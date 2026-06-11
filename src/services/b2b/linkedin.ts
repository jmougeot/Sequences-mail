/**
 * Recherche de profils LinkedIn pour la prospection. Deux sources, dans l'ordre :
 * 1. une API de recherche (Google CSE / Serper / Brave) si une clé est
 *    configurée — fiable et légal, titres JSON propres ;
 * 2. sinon, scraping de moteurs publics (Yahoo → Ecosia → Bing → DuckDuckGo,
 *    avec quarantaine du moteur qui bloque).
 * Dans les deux cas on extrait les URLs linkedin.com/in/ et on valide le slug
 * par rapport au nom pour éviter les homonymes.
 */
import { deaccent, fetchPage, normName as norm } from "./domain.js";
import { titleCase } from "./annuaire.js";
import { apiSearch, type WebResult } from "./search.js";

const ENGINES = [
  { name: "yahoo-fr", url: (q: string) => `https://fr.search.yahoo.com/search?p=${q}` },
  { name: "yahoo", url: (q: string) => `https://search.yahoo.com/search?p=${q}` },
  { name: "ecosia", url: (q: string) => `https://www.ecosia.org/search?q=${q}` },
  { name: "bing", url: (q: string) => `https://www.bing.com/search?q=${q}&setlang=fr` },
  { name: "ddg", url: (q: string) => `https://html.duckduckgo.com/html/?q=${q}` },
];

// Moteur bloqué (captcha, challenge…) : en quarantaine 10 minutes
const COOLDOWN_MS = 10 * 60 * 1000;
const cooldownUntil = new Map<string, number>();

// Throttle global : une requête moteur toutes les ~2,5 s pour rester discret
let lastSearch = 0;
async function politeDelay(): Promise<void> {
  const wait = lastSearch + 2500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearch = Date.now();
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
 * Interroge les moteurs publics dans l'ordre (quarantaine des moteurs bloqués,
 * throttle global) et renvoie les résultats du premier moteur qui donne quelque
 * chose d'exploitable, ou null si aucun n'a répondu.
 */
async function scrapeEngines<T>(query: string, parse: (html: string) => T[]): Promise<T[] | null> {
  const q = encodeURIComponent(query);
  for (const engine of ENGINES) {
    if ((cooldownUntil.get(engine.name) ?? 0) > Date.now()) continue;
    await politeDelay();
    const page = await fetchPage(engine.url(q));
    if (!page) {
      cooldownUntil.set(engine.name, Date.now() + COOLDOWN_MS);
      continue;
    }
    const items = parse(page.html);
    // le moteur a répondu : c'est notre réponse, inutile d'interroger les suivants
    if (items.length) return items;
    // rien d'exploitable : page anti-bot → quarantaine, sinon moteur suivant (seconde opinion)
    if (/captcha|challenge|anomaly|unusual traffic/i.test(page.html)) {
      cooldownUntil.set(engine.name, Date.now() + COOLDOWN_MS);
    }
  }
  return null;
}

const PROFILE_RE = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9%_.\-]+/g;
// même motif sans /g : exec() → première occurrence, sans état lastIndex partagé
const PROFILE_ONE = new RegExp(PROFILE_RE.source);

/** Extrait toutes les URLs de profils LinkedIn d'une page de résultats. */
function linkedinUrls(html: string): string[] {
  const urls = new Set<string>();
  // URLs en clair (Ecosia, hrefs directs, JSON embarqué) et percent-encodées
  // (redirections r.search.yahoo.com, uddg DuckDuckGo) : on décode :// et /
  // avant extraction, le slug garde ses éventuels %xx internes
  const decoded = html.replace(/%2f/gi, "/").replace(/%3a/gi, ":");
  for (const m of decoded.matchAll(PROFILE_RE)) urls.add(m[0]);
  // URLs encapsulées dans les redirections de tracking Bing (base64url)
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!href.includes("bing.com/ck/")) continue;
    const target = decodeBingUrl(href);
    if (target) for (const p of target.matchAll(PROFILE_RE)) urls.add(p[0]);
  }
  return [...urls].map((u) => u.replace(/\/+$/, ""));
}

/**
 * Cherche le profil LinkedIn d'une personne. Le slug du profil doit contenir
 * son nom (ou son prénom s'il est assez distinctif), sinon on ne renvoie
 * rien : mieux vaut pas de LinkedIn qu'un mauvais.
 */
/** URLs de profils /in/ contenues dans des résultats d'API (champ url ou texte). */
function profilesFromApi(results: WebResult[]): string[] {
  const urls = new Set<string>();
  for (const r of results) {
    for (const field of [r.url, r.title, r.snippet]) {
      for (const m of String(field).matchAll(PROFILE_RE)) urls.add(m[0].replace(/\/+$/, ""));
    }
  }
  return [...urls];
}

export async function findLinkedIn(first: string, last: string, company: string): Promise<string | null> {
  // site: force les moteurs à ne renvoyer que des profils — bien plus dense
  // qu'un simple mot-clé "linkedin" noyé dans les offres d'emploi et pages presse
  const query = `site:linkedin.com/in "${first} ${last}" ${company}`;
  const lastTokens = last.split(/[\s-]+/).map(norm).filter((t) => t.length >= 3);
  const firstNorm = norm(first);
  const matches = (profile: string) => {
    const slug = norm(decodeURIComponent(profile.split("/in/")[1] ?? ""));
    return lastTokens.some((t) => slug.includes(t)) || (firstNorm.length >= 4 && slug.includes(firstNorm));
  };

  // 1. API de recherche si configurée (prioritaire)
  const api = await apiSearch(query);
  if (api !== null) return profilesFromApi(api).find(matches) ?? null;

  // 2. repli : scraping de moteurs publics
  const profiles = await scrapeEngines(query, linkedinUrls);
  return profiles?.find(matches) ?? null;
}

// --- Recherche de personnes par fonction (commerciaux, marketing…) ----------

export interface FoundPerson {
  first_name: string;
  last_name: string;
  role: string | null; // poste lu dans le titre du résultat, null si absent
  linkedin: string;
}

/** Décode les entités HTML courantes des titres de résultats. */
function decodeEntities(s: string): string {
  // deux passes : certains moteurs double-encodent (&amp;amp; → &amp; → &)
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&eacute;/gi, "é").replace(/&egrave;/gi, "è").replace(/&ecirc;/gi, "ê")
      .replace(/&agrave;/gi, "à").replace(/&ccedil;/gi, "ç").replace(/&ocirc;/gi, "ô")
      .replace(/&icirc;/gi, "î").replace(/&ucirc;/gi, "û").replace(/&euml;/gi, "ë")
      .replace(/&nbsp;/gi, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return s;
}

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

/**
 * Interprète les titres d'un résultat ("Prénom Nom - Poste - Entreprise | LinkedIn",
 * ou juste "Prénom Nom" pour les vignettes) en personne. Renvoie null si le
 * titre ne ressemble pas à une personne ou si le slug ne correspond pas au nom.
 */
function parsePerson(url: string, titles: string[], company: string): FoundPerson | null {
  // retire les fils d'Ariane "fr.linkedin.com › in › slug " devant certains titres
  const cleaned = titles.map((t) => t.replace(/^.*?\bin\b\s*[›·]\s*\S+\s+/i, "").trim()).filter(Boolean);
  const full = cleaned.filter((t) => / [-–|] /.test(t)).sort((a, b) => b.length - a.length)[0];
  const nameOnly = cleaned.filter((t) => !/ [-–|] /.test(t)).sort((a, b) => a.length - b.length)[0];

  let name = "";
  let role: string | null = null;
  if (full) {
    // un titre complet qui ne mentionne pas l'entreprise = résultat hors sujet
    const companyTokens = deaccent(company.toLowerCase()).split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (companyTokens.length && !companyTokens.some((t) => deaccent(full.toLowerCase()).includes(t))) return null;
    const parts = full.split(/ [-–] /);
    name = parts[0].trim();
    role = (parts[1] ?? "").split(/ \| /)[0].split(/ chez /i)[0].trim() || null;
    if (role && /linkedin|profils|posts?/i.test(role)) role = null;
    // titre sans poste ("Prénom Nom - Entreprise") : l'entreprise n'est pas un poste
    if (role && norm(role) === norm(company)) role = null;
  }
  if (!name && nameOnly) name = nameOnly;
  name = name.replace(/\s*\|\s*LinkedIn.*$/i, "").replace(/\s*sur LinkedIn.*$/i, "").trim();

  const tokens = name.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4 || /[\d@©]/.test(name)) return null;
  const first = titleCase(tokens[0]);
  const last = titleCase(tokens.slice(1).join(" "));
  if (norm(name) === norm(company)) return null; // page/vignette de l'entreprise
  // le slug du profil doit correspondre au nom (anti-bruit)
  let slug = url.split("/in/")[1] ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* garde brut */
  }
  const slugNorm = norm(slug);
  if (!slugNorm.includes(norm(last).slice(0, 6)) && !slugNorm.includes(norm(first))) return null;
  return { first_name: first, last_name: last, role, linkedin: url };
}

/**
 * Trouve des personnes d'une fonction donnée (ex. "commercial") dans une
 * entreprise, via les pages de résultats des moteurs : noms, postes et URLs
 * LinkedIn extraits des titres. Plusieurs requêtes (combinée + une par
 * synonyme, 2 pages côté API) fusionnées puis dédoublonnées, pour remonter
 * le plus de profils possible. Best effort, qualité dépendante des moteurs.
 */
/** Dédoublonne une liste de personnes par nom normalisé, en gardant l'ordre. */
function dedupePeople(people: FoundPerson[]): FoundPerson[] {
  const seen = new Set<string>();
  const out: FoundPerson[] = [];
  for (const p of people) {
    const key = norm(p.first_name + p.last_name);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

// Synonymes par grande fonction (FR + EN) : une recherche « commercial » doit
// aussi remonter les « Sales », « Business Developer », etc. Premier groupe dont
// le motif correspond au mot-clé saisi/choisi ; sinon le mot-clé est utilisé tel quel.
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
];

/** Synonymes d'un mot-clé de fonction (ou le mot-clé seul s'il n'a pas de groupe). */
function roleTerms(keyword: string): string[] {
  const group = ROLE_SYNONYMS.find((g) => g.match.test(keyword));
  return group ? group.terms : [keyword.trim()];
}

/** Transforme un mot-clé de fonction en expression de recherche avec ses synonymes (OR). */
function buildRoleExpr(keyword: string): string {
  const terms = roleTerms(keyword);
  const ors = terms.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ");
  return terms.length > 1 ? `(${ors})` : ors;
}

export async function findPeopleByRole(company: string, keyword: string): Promise<FoundPerson[]> {
  const combined = `site:linkedin.com/in "${company}" ${buildRoleExpr(keyword)}`;
  // une requête ciblée par synonyme en plus de la requête combinée : chaque
  // variante remonte ~10 résultats différents, donc des profils en plus
  const terms = roleTerms(keyword);
  const variants = terms.length > 1 ? terms.map((t) => `site:linkedin.com/in "${company}" "${t}"`) : [];

  const people: FoundPerson[] = [];
  // un résultat de recherche = une personne potentielle (titre + snippet)
  const collect = (results: WebResult[]) => {
    for (const r of results) {
      const prof = PROFILE_ONE.exec(r.url) ?? PROFILE_ONE.exec(`${r.title} ${r.snippet}`);
      if (!prof) continue;
      const p = parsePerson(prof[0].replace(/\/+$/, ""), [r.title, r.snippet], company);
      if (p) people.push(p);
    }
  };

  // 1. API de recherche si configurée : requête combinée sur 2 pages puis les
  //    variantes — budget ≤ 7 appels API par entreprise
  const first = await apiSearch(combined);
  if (first !== null) {
    collect(first);
    collect((await apiSearch(combined, 1)) ?? []);
    for (const q of variants.slice(0, 5)) collect((await apiSearch(q)) ?? []);
    return dedupePeople(people);
  }

  // 2. repli : scraping de moteurs publics — requête combinée + 4 variantes,
  //    résultats fusionnés (les moteurs gèrent mal les longs OR, les variantes
  //    simples compensent ; chacune coûte ~3-5 s à cause du throttle)
  for (const q of [combined, ...variants.slice(0, 4)]) {
    const found = await scrapeEngines(q, (html) => {
      const out: FoundPerson[] = [];
      for (const [url, titles] of profileAnchors(html)) {
        const p = parsePerson(url, titles, company);
        if (p) out.push(p);
      }
      return out;
    });
    if (found) people.push(...found);
  }
  return dedupePeople(people);
}
