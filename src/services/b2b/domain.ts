/**
 * Découverte du site web / domaine email d'une entreprise, sans API payante :
 * 1. on devine le domaine à partir du nom (acme.fr, acme.com…) et on vérifie
 *    que la page d'accueil mentionne bien l'entreprise ;
 * 2. sinon, recherche DuckDuckGo (version HTML) en excluant les annuaires.
 * Puis crawl léger du site (contact, mentions légales…) pour récolter des
 * emails et détecter le pattern d'adressage de la boîte.
 */
import { resolveMx, resolve4 } from "node:dns/promises";

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
// pages internes intéressantes pour trouver des emails
const CRAWL_LINK_RE = /(contact|mention|legal|equipe|team|about|propos|qui-sommes)/i;

export interface CrawlResult {
  emails: string[]; // emails @domaine trouvés sur le site (dédupliqués, minuscules)
}

/** Crawl léger : accueil + 3 pages internes max (contact, mentions légales…). */
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
    for (const link of [...links].slice(0, 3)) {
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
  return { emails: [...found] };
}
