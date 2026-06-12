/**
 * Découverte du site web / domaine email d'une entreprise, sans API payante :
 * 1. on devine le domaine à partir du nom (acme.fr, acme.com…) et on vérifie
 *    que la page d'accueil mentionne bien l'entreprise ;
 * 2. sinon, recherche DuckDuckGo (version HTML) en excluant les annuaires.
 * Puis crawl léger du site (contact, mentions légales…) pour récolter des
 * emails et détecter le pattern d'adressage de la boîte.
 */
import { resolveMx, resolve4 } from "node:dns/promises";

// Particules en minuscules au milieu d'un nom (Neuilly-sur-Seine, Massiet du Biest)
const PARTICLES = new Set(["de", "du", "des", "le", "la", "les", "et", "en", "au", "aux", "sur", "sous", "lès", "and", "of", "the", "à"]);

/** Mise en forme lisible d'un nom en capitales ("SERENSIA" → "Serensia", sigles sans voyelle conservés). */
export function titleCase(s: string): string {
  let first = true;
  return s
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (w) => {
      const isFirst = first;
      first = false;
      if (!isFirst && PARTICLES.has(w)) return w;
      if (w.length <= 3 && !/[aeiouyàâéèêëîïôûù]/.test(w)) return w.toUpperCase(); // sigle probable (GTD, BNP)
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .trim();
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Mots de forme juridique / génériques à retirer du nom avant de deviner un domaine
const LEGAL_WORDS = new Set([
  "sas", "sasu", "sarl", "eurl", "sa", "sci", "scm", "scp", "scop", "snc", "selarl", "selas",
  "selafa", "sep", "gie", "societe", "société", "ste", "ets", "etablissements", "compagnie",
  "cie", "groupe", "group", "holding", "france", "et", "de", "des", "du", "la", "le", "les", "by",
]);

// Domaines d'annuaires/réseaux à ignorer dans les résultats de recherche
const DIRECTORY_DOMAINS = [
  "societe.com", "pappers.fr", "infogreffe.fr", "verif.com", "annuaire-entreprises.data.gouv.fr",
  "data.gouv.fr", "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "pagesjaunes.fr", "kompass.com", "manageo.fr", "score3.fr", "bilansgratuits.fr", "b-reputation.com",
  "wikipedia.org", "indeed.com", "welcometothejungle.com", "glassdoor.fr", "youtube.com",
  "lefigaro.fr", "entreprises.lefigaro.fr", "duckduckgo.com", "rubypayeur.com", "datanaly.se",
  "annuaire-mairie.fr", "dirigeant.societe.com", "economie.gouv.fr", "egal-pro.fr", "creditsafe.com",
  "dnb.com", "papers.fr", "lannuaire.service-public.fr", "tripadvisor.fr", "tripadvisor.com",
];

export function deaccent(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** D\u00e9code les entit\u00e9s HTML courantes (deux passes : certains sites double-encodent). */
export function decodeEntities(s: string): string {
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&eacute;/gi, "\u00e9").replace(/&egrave;/gi, "\u00e8").replace(/&ecirc;/gi, "\u00ea")
      .replace(/&agrave;/gi, "\u00e0").replace(/&ccedil;/gi, "\u00e7").replace(/&ocirc;/gi, "\u00f4")
      .replace(/&icirc;/gi, "\u00ee").replace(/&ucirc;/gi, "\u00fb").replace(/&euml;/gi, "\u00eb")
      .replace(/&nbsp;/gi, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return s;
}

/** Nom normalis\u00e9 pour comparer des personnes : minuscules, sans accents ni s\u00e9parateurs. */
export const normName = (s: string): string => deaccent(s.toLowerCase()).replace(/[^a-z]/g, "");

function tokens(name: string): string[] {
  return deaccent(name.toLowerCase())
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL_WORDS.has(t));
}

export async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.includes("html") && !type.includes("text")) return null;
    const html = (await res.text()).slice(0, 500_000);
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

async function domainExists(domain: string): Promise<boolean> {
  const ok = (p: Promise<unknown[]>) => p.then((r) => r.length > 0).catch(() => false);
  return (await ok(resolveMx(domain))) || (await ok(resolve4(domain))) || (await ok(resolve4(`www.${domain}`)));
}

/** La page mentionne-t-elle l'entreprise ? (tokens distinctifs du nom, sans accents) */
function pageMatchesName(html: string, names: string[]): boolean {
  const text = deaccent(html.toLowerCase());
  for (const name of names) {
    const ts = tokens(name).filter((t) => t.length >= 4);
    if (ts.length && ts.every((t) => text.includes(t))) return true;
    // un seul token long et rare suffit (marques en un mot)
    if (ts.some((t) => t.length >= 6 && text.includes(t))) return true;
  }
  return false;
}

function hostnameToDomain(host: string): string {
  // garde les 2 derniers labels (+3 pour .co.uk etc. — rare en France, on reste simple)
  const parts = host.replace(/^www\./, "").split(".");
  return parts.slice(-2).join(".");
}

export interface DomainResult {
  domain: string;
  status: "verified" | "guessed";
  homepage: string; // URL effective de la page d'accueil (après redirections)
}

/** Devine le domaine à partir du nom/de l'enseigne et le vérifie par le contenu du site. */
async function guessDomain(names: string[]): Promise<DomainResult | null> {
  const slugs = new Set<string>();
  for (const name of names) {
    const ts = tokens(name);
    if (!ts.length) continue;
    slugs.add(ts.join(""));
    if (ts.length > 1) slugs.add(ts.join("-"));
    if (ts.length > 2) slugs.add(ts.slice(0, 2).join("")); // deux premiers mots
  }
  const candidates: string[] = [];
  for (const slug of slugs) {
    if (slug.length < 3 || slug.length > 40) continue;
    for (const tld of ["fr", "com"]) candidates.push(`${slug}.${tld}`);
  }
  for (const domain of candidates.slice(0, 10)) {
    if (!(await domainExists(domain))) continue;
    const page = (await fetchPage(`https://${domain}`)) ?? (await fetchPage(`https://www.${domain}`)) ?? (await fetchPage(`http://${domain}`));
    if (!page) continue;
    // le site a pu rediriger vers son vrai domaine (ex. acme.fr → groupe-acme.com)
    const finalDomain = hostnameToDomain(new URL(page.finalUrl).hostname);
    if (pageMatchesName(page.html, names)) return { domain: finalDomain, status: "verified", homepage: page.finalUrl };
  }
  return null;
}

/** Recherche DuckDuckGo (HTML) et renvoie le premier résultat hors annuaires. */
async function duckduckgoDomain(names: string[], ville: string | null): Promise<DomainResult | null> {
  const q = `${names[0]} ${ville ?? ""}`.trim();
  const page = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!page) return null;
  const urls = [...page.html.matchAll(/result__a"[^>]*href="([^"]+)"/g)]
    .map((m) => {
      const href = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      try {
        return new URL(uddg ? decodeURIComponent(uddg[1]) : href, "https://duckduckgo.com").toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => Boolean(u));
  for (const url of urls.slice(0, 8)) {
    const host = new URL(url).hostname.toLowerCase();
    const domain = hostnameToDomain(host);
    if (DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`) || domain === d)) continue;
    if (host.endsWith(".gouv.fr")) continue;
    const home = await fetchPage(`https://${domain}`);
    const html = home?.html ?? "";
    const finalDomain = home ? hostnameToDomain(new URL(home.finalUrl).hostname) : domain;
    return {
      domain: finalDomain,
      status: pageMatchesName(html, names) ? "verified" : "guessed",
      homepage: home?.finalUrl ?? `https://${domain}`,
    };
  }
  return null;
}

export async function findDomain(company: { name: string; brand: string | null; ville: string | null }): Promise<DomainResult | null> {
  // l'enseigne commerciale d'abord : c'est elle qui porte le nom de domaine en général
  const names = [
    ...(company.brand ? company.brand.split(/\s+-\s+/) : []),
    company.name,
  ].filter(Boolean);
  return (await guessDomain(names)) ?? (await duckduckgoDomain(names, company.ville));
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/gi;
// pages internes intéressantes pour trouver des emails et l'équipe
const CRAWL_LINK_RE = /(contact|mention|legal|equipe|team|about|propos|qui-sommes)/i;
// parmi elles, celles qui listent généralement les personnes (crawlées en priorité)
const TEAM_LINK_RE = /(equipe|team|qui-sommes|about|propos)/i;

// --- Extraction des personnes publiées sur le site (pages équipe) ---------

export interface TeamPerson {
  first_name: string;
  last_name: string;
  role: string; // poste tel qu'affiché sur le site
}

// Un segment de texte n'est retenu comme poste que s'il contient un mot de métier
export const JOB_WORD_RE = /directeur|directrice|director|direction|responsable|manager|chef[fe]?s?\b|head of|\blead\b|pr[ée]sident|fondat|founder|g[ée]rant|associ[ée]|partner|\bc[eotfm]o\b|\bdg\b|\bdaf\b|\bdrh\b|commercial|sales|account|business|d[ée]veloppeu|developer|ing[ée]nieur|engineer|consultant|marketing|communication|growth|finance|comptab|juriste|avocat|\brh\b|ressources humaines|\bhr\b|recrut|talent|assistant|charg[ée]e?\b|technicien|designer|product|achats?\b|support|customer|office manager|expert|analyste?\b|architecte|coach|formateur|conseiller/i;

// Mots qui disqualifient un segment comme nom de personne
const NOT_A_NAME_RE = new RegExp(
  `\\d|@|©|[ée]quipe|\\bteam\\b|notre|\\bnos\\b|contact|cookie|mention|politique|newsletter|suivez|d[ée]couvr|bienvenue|${JOB_WORD_RE.source}`,
  "i"
);

const MIXED_CASE_WORD = /^[\p{Lu}][\p{Ll}'’-]+$/u; // Xxxx (lettres, apostrophes, tirets)
const NAME_WORD = /^[\p{Lu}][\p{L}'’-]+$/u; // Xxxx ou XXXX
const NAME_PARTICLES = new Set(["de", "du", "des", "le", "la", "van", "von", "el", "al", "ben", "di", "da"]);

/** Le segment ressemble-t-il à un nom de personne (« Marie Dupont », « Jean de La Tour ») ? */
function looksLikeName(seg: string): boolean {
  if (seg.length > 40 || NOT_A_NAME_RE.test(seg)) return false;
  const words = seg.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  let mixed = 0;
  for (const w of words) {
    if (NAME_PARTICLES.has(w.toLowerCase())) continue;
    if (!NAME_WORD.test(w)) return false;
    if (MIXED_CASE_WORD.test(w)) mixed++;
  }
  // au moins un mot en casse mixte : écarte les intitulés tout en capitales
  return mixed >= 1;
}

/**
 * Extrait les personnes (nom + poste) publiées sur une page « équipe » : un
 * segment de texte qui ressemble à un nom, suivi de près par un segment qui
 * ressemble à un poste. Heuristique volontairement stricte : mieux vaut rater
 * un profil que de fabriquer un faux prospect.
 */
export function extractTeamPeople(html: string): TeamPerson[] {
  const segs = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // les balises de mise en forme ne coupent pas un nom ("Jean <b>Dupont</b>")
    .replace(/<\/?(strong|em|b|i|u|span|a|small|sup|sub|abbr|mark)[^>]*>/gi, "")
    .split(/<[^>]+>/)
    .map((s) => decodeEntities(s).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const people: TeamPerson[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segs.length && people.length < 40; i++) {
    if (!looksLikeName(segs[i])) continue;
    // le poste est l'un des 2 segments suivants (carte d'équipe : nom puis fonction)
    const role = [segs[i + 1], segs[i + 2]].find(
      (s) => s && s.length >= 3 && s.length <= 80 && JOB_WORD_RE.test(s) && !looksLikeName(s)
    );
    if (!role) continue;
    const words = segs[i].split(/\s+/);
    const first = titleCase(words[0]);
    const last = titleCase(words.slice(1).join(" "));
    const key = normName(first + last);
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ first_name: first, last_name: last, role });
  }
  return people;
}

export interface CrawlResult {
  emails: string[]; // emails @domaine trouvés sur le site (dédupliqués, minuscules)
  people: TeamPerson[]; // personnes publiées sur les pages équipe/à propos
}

/** Crawl léger : accueil + 4 pages internes max (équipe et à-propos d'abord, puis contact…). */
export async function crawlEmails(domain: string, homepage?: string): Promise<CrawlResult> {
  const found = new Set<string>();
  const home = await fetchPage(homepage ?? `https://${domain}`);
  const pages: string[] = home ? [home.html] : [];
  if (home) {
    const base = new URL(home.finalUrl);
    const links = new Set<string>();
    for (const m of home.html.matchAll(/href="([^"#]+)"/g)) {
      try {
        const u = new URL(m[1], base);
        if (u.hostname.replace(/^www\./, "").endsWith(domain.replace(/^www\./, "")) && CRAWL_LINK_RE.test(u.pathname)) {
          links.add(u.toString());
        }
      } catch {
        /* href invalide */
      }
    }
    const ordered = [...links].sort((a, b) => Number(TEAM_LINK_RE.test(b)) - Number(TEAM_LINK_RE.test(a)));
    for (const link of ordered.slice(0, 4)) {
      const p = await fetchPage(link);
      if (p) pages.push(p.html);
    }
  }
  for (const html of pages) {
    // décode les obfuscations courantes (%40, &#64;) et les échappements JSON
    // (>…) avant extraction, pour ne pas coller de préfixe aux emails
    const text = html
      .replace(/\\u00([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/%40/g, "@")
      .replace(/&#0?64;/g, "@");
    for (const m of text.matchAll(EMAIL_RE)) {
      const email = m[0].toLowerCase().replace(/^[0-9]+/, ""); // numéros collés devant (tél/SIRET)
      const dom = email.split("@")[1];
      if (!dom) continue;
      if (dom === domain || dom === `www.${domain}` || dom.endsWith(`.${domain}`)) {
        if (!/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(email)) found.add(email);
      }
    }
  }
  // personnes publiées sur les pages crawlées (équipe, à propos…), dédupliquées
  const people: TeamPerson[] = [];
  const seenPeople = new Set<string>();
  for (const html of pages) {
    for (const p of extractTeamPeople(html)) {
      const key = normName(p.first_name + p.last_name);
      if (seenPeople.has(key)) continue;
      seenPeople.add(key);
      people.push(p);
    }
  }
  return { emails: [...found], people };
}
