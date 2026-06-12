/**
 * Recherche directe de personnes par poste sur LinkedIn, via les moteurs de
 * recherche : une requête `site:linkedin.com/in "<poste>" "<ville>"` renvoie
 * ~10 profils par page, presque tous au bon poste — bien plus dense que de
 * parcourir des entreprises une à une. Deux sources, dans l'ordre :
 * 1. une API de recherche (Google CSE / Serper / Brave) si une clé est
 *    configurée — fiable, paginable (jusqu'à ~10 pages par requête) ;
 * 2. sinon, scraping de moteurs publics (Yahoo → Ecosia → Bing → DuckDuckGo,
 *    avec quarantaine du moteur qui bloque).
 * Chaque résultat est interprété en personne (nom, poste, entreprise,
 * localisation) ; le slug du profil doit correspondre au nom (anti-bruit) et
 * seuls les postes correspondant strictement au mot-clé sont gardés.
 */
import { deaccent, decodeEntities, fetchPage, normName as norm, titleCase, JOB_WORD_RE } from "./domain.js";
import { apiSearch } from "./search.js";

// `url(q, page)` renvoie l'URL de la page de résultats demandée (0-based), ou
// null si le moteur ne pagine pas en GET (DuckDuckGo exige un POST).
// Les instances SearXNG publiques relaient Google/Bing : précieuses quand les
// moteurs directs bloquent ; si une instance disparaît, la quarantaine l'écarte.
const ENGINES: Array<{ name: string; url: (q: string, page: number) => string | null }> = [
  { name: "yahoo-fr", url: (q, p) => `https://fr.search.yahoo.com/search?p=${q}&b=${1 + p * 10}` },
  { name: "yahoo", url: (q, p) => `https://search.yahoo.com/search?p=${q}&b=${1 + p * 10}` },
  { name: "ecosia", url: (q, p) => `https://www.ecosia.org/search?q=${q}&p=${p}` },
  { name: "mojeek", url: (q, p) => `https://www.mojeek.com/search?q=${q}&s=${1 + p * 10}` },
  { name: "searx-be", url: (q, p) => `https://searx.be/search?q=${q}&language=fr-FR&pageno=${p + 1}` },
  { name: "searx-tiekoetter", url: (q, p) => `https://searx.tiekoetter.com/search?q=${q}&language=fr-FR&pageno=${p + 1}` },
  { name: "bing", url: (q, p) => `https://www.bing.com/search?q=${q}&setlang=fr&first=${1 + p * 10}` },
  { name: "ddg", url: (q, p) => (p ? null : `https://html.duckduckgo.com/html/?q=${q}`) },
  { name: "ddg-lite", url: (q, p) => (p ? null : `https://lite.duckduckgo.com/lite/?q=${q}`) },
];

// Moteur en échec réseau/HTTP : 5 min de quarantaine ; page anti-bot
// explicite (captcha…) : 15 min — insister ne ferait qu'allonger le ban.
const COOLDOWN_FAIL_MS = 5 * 60 * 1000;
const COOLDOWN_BLOCK_MS = 15 * 60 * 1000;
const cooldownUntil = new Map<string, number>();

// Un moteur qui répond HTTP 200 mais sans rien d'exploitable sur plusieurs
// requêtes d'affilée (soft-block : page servie mais résultats masqués) est
// aussi mis en quarantaine, sinon il ferait perdre du temps indéfiniment.
const EMPTY_STREAK_LIMIT = 4;
const emptyStreak = new Map<string, number>();

/**
 * Tous les moteurs publics sont-ils en quarantaine ? Quand c'est le cas (et
 * sans clé d'API), continuer une recherche ne peut rien donner : l'appelant
 * doit s'interrompre proprement plutôt que d'enchaîner des requêtes vides.
 */
export function allEnginesQuarantined(): boolean {
  const now = Date.now();
  return ENGINES.every((e) => (cooldownUntil.get(e.name) ?? 0) > now);
}

// Throttle PAR MOTEUR (~2,5-4 s avec jitter entre deux requêtes au même
// moteur) : interroger yahoo puis ecosia n'attend presque pas. Le créneau est
// réservé avant l'attente, donc sûr avec plusieurs workers. Un petit
// espacement global évite les rafales réseau.
const ENGINE_GAP_MS = 2500;
const GLOBAL_GAP_MS = 300;
const engineNextAt = new Map<string, number>();
let globalNextAt = 0;
async function politeDelay(engine: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(engineNextAt.get(engine) ?? 0, globalNextAt, now);
  engineNextAt.set(engine, at + ENGINE_GAP_MS + Math.floor(Math.random() * 1500));
  globalNextAt = at + GLOBAL_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Liens de tracking bing.com/ck/a : cible en base64url dans le paramètre u (préfixe "a1"). */
function decodeBingUrl(href: string): string | null {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
  if (!m) return null;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Interroge les moteurs publics dans l'ordre (quarantaine des moteurs bloqués)
 * et fusionne les résultats de `engines` moteurs ayant répondu, sur `pages`
 * pages de résultats chacun quand le moteur sait paginer.
 * Renvoie null si aucun moteur n'a rien donné.
 */
async function scrapeEngines<T>(
  query: string,
  parse: (html: string) => T[],
  opts: { engines?: number; pages?: number } = {}
): Promise<T[] | null> {
  const wantEngines = opts.engines ?? 1;
  const maxPages = opts.pages ?? 1;
  const q = encodeURIComponent(query);
  const out: T[] = [];
  let responded = 0;
  for (const engine of ENGINES) {
    if (responded >= wantEngines) break;
    if ((cooldownUntil.get(engine.name) ?? 0) > Date.now()) continue;
    let gave = false;
    for (let p = 0; p < maxPages; p++) {
      const url = engine.url(q, p);
      if (!url) break; // ce moteur ne pagine pas en GET
      await politeDelay(engine.name);
      const page = await fetchPage(url);
      if (!page) {
        cooldownUntil.set(engine.name, Date.now() + COOLDOWN_FAIL_MS);
        break;
      }
      const items = parse(page.html);
      if (!items.length) {
        // page anti-bot → quarantaine ; vide à répétition → soft-block probable
        if (/captcha|challenge|anomaly|unusual traffic/i.test(page.html)) {
          cooldownUntil.set(engine.name, Date.now() + COOLDOWN_BLOCK_MS);
        } else if (p === 0) {
          const streak = (emptyStreak.get(engine.name) ?? 0) + 1;
          emptyStreak.set(engine.name, streak);
          if (streak >= EMPTY_STREAK_LIMIT) {
            cooldownUntil.set(engine.name, Date.now() + COOLDOWN_FAIL_MS);
            emptyStreak.set(engine.name, 0);
          }
        }
        break;
      }
      emptyStreak.set(engine.name, 0);
      out.push(...items);
      gave = true;
    }
    if (gave) responded++;
  }
  return responded ? out : null;
}

const PROFILE_RE = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9%_.\-]+/g;
// même motif sans /g : exec() → première occurrence, sans état lastIndex partagé
const PROFILE_ONE = new RegExp(PROFILE_RE.source);

/** Ancres de la page de résultats dont la cible est un profil : URL → textes (titres). */
function profileAnchors(html: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)) {
    const href = m[1].replace(/&amp;/g, "&");
    let target = href.includes("bing.com/ck/") ? (decodeBingUrl(href) ?? "") : href;
    try {
      target = decodeURIComponent(target);
    } catch {
      /* encodage partiel : on garde brut */
    }
    target = target.replace(/%2f/gi, "/").replace(/%3a/gi, ":");
    const prof = PROFILE_ONE.exec(target);
    if (!prof) continue;
    const url = prof[0].replace(/\/+$/, "");
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!title) continue;
    if (map.has(url)) map.get(url)!.push(title);
    else map.set(url, [title]);
  }
  return map;
}

// --- Postes : équivalences strictes et correspondance ------------------------

// Racine grossière d'un mot de poste : sans pluriel, tronquée — « directeur »
// matche « directrice »/« director », « commercial » matche « commerciale »
const stem = (w: string) => w.replace(/s$/, "").slice(0, 6);

/**
 * Le poste affiché correspond-il à l'un des termes demandés ? Tous les mots du
 * terme (racines) doivent apparaître dans le poste : « account executive »
 * matche « Senior Account Executive » mais pas « Directeur Commercial ».
 * Un poste inconnu (null) ne matche jamais : précision avant rappel.
 */
export function roleMatches(role: string | null, terms: string[]): boolean {
  if (!role) return false;
  const r = norm(role);
  return terms.some((t) => {
    const words = deaccent(t.toLowerCase()).split(/[^a-z]+/).filter((w) => w.length >= 2);
    return words.length > 0 && words.every((w) => r.includes(stem(w)));
  });
}

// Équivalences exactes d'un poste précis : mêmes responsabilités sous un autre
// nom (FR/EN, abréviations, féminin quand la racine diffère). Sert quand
// l'utilisateur tape un poste précis — on ne l'élargit PAS à toute la fonction.
const ROLE_EQUIV: Record<string, string[]> = {
  accountexecutive: ["account exec"],
  accountmanager: ["account management"],
  sdr: ["sales development representative", "business development representative", "bdr"],
  bdr: ["business development representative", "sales development representative", "sdr"],
  businessdeveloper: ["business development", "biz dev", "bizdev"],
  directeurcommercial: ["directrice commerciale", "head of sales", "sales director", "vp sales", "chief sales officer"],
  directeurmarketing: ["directrice marketing", "head of marketing", "marketing director", "cmo", "vp marketing"],
  directeurgeneral: ["directrice générale", "general manager", "managing director", "ceo"],
  directeurfinancier: ["directrice financière", "cfo", "daf", "head of finance", "finance director"],
  daf: ["directeur financier", "directrice financière", "cfo", "head of finance"],
  drh: ["directeur des ressources humaines", "directrice des ressources humaines", "head of hr", "hr director", "chro"],
  ceo: ["chief executive officer", "directeur général", "fondateur", "founder", "président"],
  cmo: ["chief marketing officer", "directeur marketing", "head of marketing"],
  cfo: ["chief financial officer", "directeur financier", "daf"],
  coo: ["chief operating officer", "directeur des opérations"],
  cto: ["chief technology officer", "directeur technique", "vp engineering"],
};

// Synonymes par grande fonction (FR + EN) : une recherche « commercial » doit
// aussi remonter les « Sales », « Business Developer », etc. Utilisé seulement
// pour un mot-clé générique d'un seul mot — un poste précis n'est pas élargi.
const ROLE_SYNONYMS: Array<{ match: RegExp; terms: string[] }> = [
  {
    match: /commercial|\bsales\b|vente|business dev|account/i,
    terms: ["commercial", "sales", "ventes", "business developer", "account executive", "account manager"],
  },
  {
    match: /marketing|growth|acquisition|communication/i,
    terms: ["marketing", "growth", "communication", "acquisition"],
  },
  {
    match: /\brh\b|ressources humaines|recrut|talent|\bhr\b/i,
    terms: ["RH", "ressources humaines", "recrutement", "talent acquisition", "recruteur"],
  },
  {
    match: /\bcto\b|\btech\b|technique|développeur|developer|ing[ée]nieur|engineer/i,
    terms: ["CTO", "directeur technique", "développeur", "software engineer", "lead tech"],
  },
  {
    match: /fondateur|founder|\bceo\b|pr[ée]sident|directeur g[ée]n[ée]ral|\bdg\b|dirigeant/i,
    terms: ["CEO", "fondateur", "founder", "président", "directeur général"],
  },
  {
    match: /finance|\bdaf\b|\bcfo\b|comptab/i,
    terms: ["CFO", "DAF", "directeur financier", "finance"],
  },
  {
    match: /achat|procurement|sourcing/i,
    terms: ["achats", "acheteur", "procurement"],
  },
  {
    match: /produit\b|product|\bcpo\b/i,
    terms: ["product manager", "produit", "head of product"],
  },
  {
    match: /op[ée]rations|\bcoo\b|\bops\b/i,
    terms: ["COO", "directeur des opérations", "operations"],
  },
];

/**
 * Termes cherchés (et acceptés au filtrage) pour un mot-clé de poste, le
 * mot-clé exact toujours en premier :
 * - poste précis connu (« account executive », « directeur commercial ») :
 *   ses équivalents stricts seulement ;
 * - mot générique d'un seul mot (« commercial », « marketing ») : son groupe
 *   de fonction élargi ;
 * - sinon : le mot-clé tel quel.
 */
export function roleTerms(keyword: string): string[] {
  const kw = keyword.trim();
  const equiv = ROLE_EQUIV[norm(kw)];
  if (equiv) return [kw, ...equiv.filter((t) => norm(t) !== norm(kw))];
  if (!/\s/.test(kw)) {
    const group = ROLE_SYNONYMS.find((g) => g.match.test(kw));
    if (group) return [kw, ...group.terms.filter((t) => norm(t) !== norm(kw))];
  }
  return [kw];
}

// --- Interprétation d'un résultat de recherche en personne --------------------

export interface Prospect {
  first_name: string;
  last_name: string;
  role: string | null; // poste lu dans le résultat
  company: string | null; // entreprise lue dans le résultat
  location: string | null; // localisation lue dans le résultat
  linkedin: string; // URL du profil
}

// Segment de titre qui est une localisation, pas un poste ni une entreprise
const LOCATION_SEG = /^(r[ée]gion|greater|m[ée]tropole)\b|p[ée]riph[ée]rie|, france$/i;

/**
 * Interprète un résultat de recherche (titres + texte) en personne. Formats
 * usuels : « Prénom Nom - Poste - Entreprise | LinkedIn », « Prénom Nom -
 * Entreprise | LinkedIn », « Prénom Nom - Poste chez Entreprise »… Renvoie
 * null si le titre ne ressemble pas à une personne ou si le slug du profil ne
 * correspond pas au nom (homonymes, pages diverses).
 */
function parseProspect(url: string, titles: string[], extraText: string, terms: string[]): Prospect | null {
  const cleaned = titles
    .map((t) =>
      t
        .replace(/^.*?\bin\b\s*[›·]\s*\S+\s+/i, "") // fil d'Ariane "linkedin.com › in › slug"
        .replace(/\s*[|·–—-]\s*LinkedIn\s*$/i, "")
        .replace(/\s*sur LinkedIn.*$/i, "")
        .trim()
    )
    .filter(Boolean);
  // titre le plus riche (avec séparateurs) d'abord, sinon vignette "Prénom Nom"
  const withSep = cleaned.filter((t) => /\s[-–—|·]\s/.test(t)).sort((a, b) => b.length - a.length)[0];
  const nameOnly = cleaned.filter((t) => !/\s[-–—|·]\s/.test(t)).sort((a, b) => a.length - b.length)[0];
  const title = withSep ?? nameOnly;
  if (!title) return null;

  const segments = title.split(/\s+[-–—|·]\s+/).map((s) => s.trim()).filter(Boolean);
  const name = segments[0] ?? "";
  const tokens = name.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4 || /[\d@©]/.test(name)) return null;
  const first = titleCase(tokens[0]);
  const last = titleCase(tokens.slice(1).join(" "));

  // le slug du profil doit correspondre au nom (anti-bruit)
  let slug = url.split("/in/")[1] ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* garde brut */
  }
  const slugNorm = norm(slug);
  if (!slugNorm.includes(norm(last).slice(0, 6)) && !slugNorm.includes(norm(first))) return null;

  let role: string | null = null;
  let company: string | null = null;
  let location: string | null = null;
  for (const seg of segments.slice(1)) {
    const chez = /^(.*?)\s*\bchez\s+(.+)$/i.exec(seg);
    if (chez) {
      if (!role && chez[1].trim()) role = chez[1].trim();
      if (!company) company = chez[2].trim();
    } else if (LOCATION_SEG.test(seg)) {
      location ??= seg;
    } else if (!role && (roleMatches(seg, terms) || JOB_WORD_RE.test(seg))) {
      // un segment n'est un poste que s'il y ressemble — sinon c'est l'entreprise
      role = seg;
    } else if (!company) {
      company = seg;
    }
  }
  if (role && /linkedin|profils?\b|\bposts?\b|relations\b/i.test(role)) role = null;

  // le texte du résultat (snippet) complète ce que le titre ne dit pas
  if (!company) {
    company =
      /(?:\bchez|\bat)\s+([^·|;.]{2,60}?)(?=\s*[·|;.]|$)/im.exec(extraText)?.[1]?.trim() ??
      /exp[ée]rience\s*:\s*([^·|;.]{2,60})/i.exec(extraText)?.[1]?.trim() ??
      null;
  }
  if (!location) {
    location =
      /lieu\s*:\s*([^·|;]{2,40})/i.exec(extraText)?.[1]?.trim() ??
      /(r[ée]gion de [^·|;,.]{2,30})/i.exec(`${title} · ${extraText}`)?.[1]?.trim() ??
      null;
  }
  // poste absent du titre mais terme présent dans le texte : on retient ce
  // terme comme poste plutôt que de jeter le profil
  if (!role) {
    const t = terms.find((term) => roleMatches(`${title} ${extraText}`, [term]));
    if (t) role = titleCase(t);
  }
  if (company && norm(company) === norm(name)) company = null;
  return { first_name: first, last_name: last, role, company, location, linkedin: url };
}

// --- Requêtes et collecte -----------------------------------------------------

export interface PeopleSearchParams {
  role: string; // poste recherché (texte libre, requis)
  location?: string; // villes/régions, séparées par des virgules (optionnel)
  sector?: string; // mots-clés libres ajoutés à la requête (optionnel)
}

/**
 * Requêtes du plan de recherche : une par terme de poste × localisation.
 * Chaque requête a son propre espace de résultats (~10 par page, jusqu'à
 * ~10 pages via l'API) : multiplier les requêtes multiplie les profils.
 */
export function buildQueries(params: PeopleSearchParams): string[] {
  const terms = roleTerms(params.role).slice(0, 6);
  const locations = (params.location ?? "").split(/[,;/]+/).map((s) => s.trim()).filter(Boolean);
  const sector = (params.sector ?? "").trim();
  const queries: string[] = [];
  for (const loc of locations.length ? locations : [""]) {
    for (const t of terms) {
      queries.push(`site:linkedin.com/in "${t}"${loc ? ` "${loc}"` : ""}${sector ? ` ${sector}` : ""}`);
    }
  }
  return queries;
}

/**
 * Une page de résultats d'une requête via l'API de recherche configurée,
 * interprétée en personnes. Renvoie null si aucune API n'est configurée ou
 * disponible (l'appelant bascule sur le scraping public). `raw` permet à
 * l'appelant de détecter une requête épuisée (moins de 10 résultats bruts).
 */
export async function fetchProspectsPage(
  query: string,
  page: number,
  terms: string[]
): Promise<{ prospects: Prospect[]; raw: number } | null> {
  const results = await apiSearch(query, page);
  if (results === null) return null;
  const prospects: Prospect[] = [];
  for (const r of results) {
    const m = PROFILE_ONE.exec(r.url) ?? PROFILE_ONE.exec(`${r.title} ${r.snippet}`);
    if (!m) continue;
    const p = parseProspect(m[0].replace(/\/+$/, ""), [r.title], r.snippet, terms);
    if (p) prospects.push(p);
  }
  return { prospects, raw: results.length };
}

/** Même collecte via le scraping des moteurs publics (repli sans clé d'API). */
export async function scrapeProspects(
  query: string,
  terms: string[],
  opts: { engines?: number; pages?: number } = {}
): Promise<Prospect[] | null> {
  const parse = (html: string) => {
    const out: Prospect[] = [];
    for (const [url, anchorTitles] of profileAnchors(html)) {
      const p = parseProspect(url, anchorTitles, anchorTitles.join(" · "), terms);
      if (p) out.push(p);
    }
    return out;
  };
  return scrapeEngines(query, parse, opts);
}
