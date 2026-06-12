/**
 * Enrichissement d'une entreprise par son NOM, via l'API publique « Recherche
 * d'Entreprises » (recherche-entreprises.api.gouv.fr — gratuite, sans clé,
 * France uniquement). Sert à filtrer les prospects par taille / secteur / CA :
 * le nom de boîte lu dans un résultat LinkedIn n'a pas ces attributs, on va les
 * chercher dans le registre. Le rapprochement nom → entreprise est « best
 * effort » (on prend le meilleur résultat de l'API). Résultats mis en cache
 * (table company_cache) : une même entreprise n'est jamais requêtée deux fois.
 */
import { db } from "../../db.js";

const API_URL = "https://recherche-entreprises.api.gouv.fr/search";

/** Tranches d'effectifs INSEE → libellés (partagé avec l'UI via /api/b2b/meta). */
export const EFFECTIF_LABELS: Record<string, string> = {
  NN: "non renseigné",
  "00": "0 salarié",
  "01": "1-2",
  "02": "3-5",
  "03": "6-9",
  "11": "10-19",
  "12": "20-49",
  "21": "50-99",
  "22": "100-199",
  "31": "200-249",
  "32": "250-499",
  "41": "500-999",
  "42": "1000-1999",
  "51": "2000-4999",
  "52": "5000-9999",
  "53": "10000+",
};

export const SECTION_LABELS: Record<string, string> = {
  A: "Agriculture, sylviculture et pêche",
  B: "Industries extractives",
  C: "Industrie manufacturière",
  D: "Électricité, gaz, vapeur",
  E: "Eau, assainissement, déchets",
  F: "Construction",
  G: "Commerce, réparation auto",
  H: "Transports et entreposage",
  I: "Hébergement et restauration",
  J: "Information et communication",
  K: "Activités financières et d'assurance",
  L: "Activités immobilières",
  M: "Activités spécialisées, scientifiques et techniques",
  N: "Services administratifs et de soutien",
  O: "Administration publique",
  P: "Enseignement",
  Q: "Santé humaine et action sociale",
  R: "Arts, spectacles et activités récréatives",
  S: "Autres activités de services",
  T: "Ménages employeurs",
  U: "Activités extra-territoriales",
};

export interface CompanyInfo {
  siren: string | null;
  effectif: string | null; // code INSEE de tranche (clé de EFFECTIF_LABELS)
  naf_section: string | null; // section A..U
  ca: number | null; // dernier chiffre d'affaires connu (€)
}

// Throttle simple : l'API autorise 7 req/s, on reste sous 5/s.
let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = lastCall + 220 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

const cacheGet = db.prepare("SELECT info FROM company_cache WHERE name_key = ?");
const cachePut = db.prepare("INSERT OR REPLACE INTO company_cache (name_key, info, fetched_at) VALUES (?, ?, ?)");

/** Tokens d'un nom : sans accents, sans forme juridique ni ponctuation. */
function nameTokens(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(sas|sasu|sarl|eurl|sa|sci|group|groupe|holding|france)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Clé de cache/recherche d'un nom venu de LinkedIn : on retire d'abord les
 * parenthèses (taglines, domaines — « Alan (alan.com) » → « Alan ») qui
 * polluent la requête au registre.
 */
function nameKey(name: string): string {
  return nameTokens(name.replace(/\([^)]*\)/g, " "));
}

/**
 * Choisit, parmi les résultats de l'API, celui qui correspond le mieux au nom
 * cherché — ou null si aucun ne s'en approche. Rapprochement volontairement
 * souple (les noms LinkedIn diffèrent souvent de la raison sociale) : il suffit
 * que la moitié des mots du nom se retrouve dans les noms du candidat —
 * raison sociale, sigle, noms commerciaux et enseignes des établissements
 * (« BlaBlaCar » est l'enseigne de COMUTO, « BACK MARKET » le nom commercial
 * de JUNG S.A.S). À couverture égale, on préfère un candidat qui A des données
 * (effectif/CA) — c'est sur elles qu'on filtre et ça départage les homonymes —
 * puis le moins de mots en trop (« ALAN » exact bat « ALAN PUREN »).
 */
interface MatchingEtab {
  nom_commercial?: string | null;
  liste_enseignes?: string[] | null;
}
function bestMatch(key: string, results: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const wanted = key.split(" ");
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const r of results) {
    const etabs = (r.matching_etablissements as MatchingEtab[] | undefined) ?? [];
    const names = [
      r.nom_complet,
      r.sigle,
      ...etabs.flatMap((e) => [e.nom_commercial, ...(e.liste_enseignes ?? [])]),
    ].filter(Boolean);
    // tokens uniques : les enseignes répètent le nom (« DOCTOLIB » × N établissements),
    // compter les occurrences pénaliserait à tort les entreprises multi-sites
    const candSet = new Set(nameTokens(names.join(" ")).split(" "));
    const coverage = wanted.filter((w) => candSet.has(w)).length / wanted.length;
    if (coverage < 0.5) continue;
    const effectif = r.tranche_effectif_salarie as string | null;
    const hasData = (effectif && effectif !== "NN") || latestCa(r.finances) !== null;
    const score = coverage + (hasData ? 0.25 : 0) - 0.01 * Math.max(0, candSet.size - wanted.length);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Dernier chiffre d'affaires connu dans le bloc `finances` de l'API. */
function latestCa(finances: unknown): number | null {
  if (!finances || typeof finances !== "object") return null;
  const years = Object.keys(finances as Record<string, unknown>).sort().reverse();
  for (const y of years) {
    const f = (finances as Record<string, { ca?: number | null }>)[y];
    if (f && typeof f.ca === "number") return f.ca;
  }
  return null;
}

/**
 * Renvoie les attributs registre d'une entreprise à partir de son nom, ou null
 * si introuvable. Mis en cache (succès comme échec) pour ne jamais re-requêter.
 */
export async function enrichCompanyByName(name: string, retried = false): Promise<CompanyInfo | null> {
  const key = nameKey(name);
  if (!key) return null;
  const cached = cacheGet.get(key) as { info: string } | undefined;
  if (cached) return JSON.parse(cached.info) as CompanyInfo | null;

  let info: CompanyInfo | null = null;
  try {
    await throttle();
    const params = new URLSearchParams({ q: key, page: "1", per_page: "5", etat_administratif: "A" });
    const res = await fetch(`${API_URL}?${params}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && !retried) {
      await new Promise((r) => setTimeout(r, 1500));
      return enrichCompanyByName(name, true); // une seule relance après backoff
    }
    if (res.ok) {
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const r = bestMatch(key, data.results ?? []);
      if (r) {
        info = {
          siren: r.siren ? String(r.siren) : null,
          effectif: (r.tranche_effectif_salarie as string) ?? null,
          naf_section: (r.section_activite_principale as string) ?? null,
          ca: latestCa(r.finances),
        };
      }
    }
  } catch {
    // réseau/timeout : on met en cache un échec pour ne pas boucler dessus
    info = null;
  }
  cachePut.run(key, JSON.stringify(info), Date.now());
  return info;
}

export interface CompanyFilters {
  effectifs?: Set<string>; // codes de tranche acceptés (vide = pas de filtre taille)
  sections?: Set<string>; // sections NAF acceptées (vide = pas de filtre secteur)
  caMin?: number; // CA minimum (€)
}

export function hasCompanyFilters(f: CompanyFilters): boolean {
  return Boolean((f.effectifs && f.effectifs.size) || (f.sections && f.sections.size) || f.caMin);
}

/** L'entreprise (déjà enrichie) passe-t-elle les filtres taille/secteur/CA ? */
export function companyPasses(info: CompanyInfo | null, f: CompanyFilters): boolean {
  if (!info) return false; // filtre actif mais entreprise non résolue → écartée
  if (f.effectifs && f.effectifs.size && !(info.effectif && f.effectifs.has(info.effectif))) return false;
  if (f.sections && f.sections.size && !(info.naf_section && f.sections.has(info.naf_section))) return false;
  if (f.caMin && !(info.ca !== null && info.ca >= f.caMin)) return false;
  return true;
}

// --- Énumération du registre (mode « ciblage par entreprises ») ----------------

/** Une entreprise listée depuis le registre, prête à être ciblée sur LinkedIn. */
export interface RegistryCompany {
  name: string; // nom à mettre dans la requête (alias commercial si disponible)
  info: CompanyInfo;
}

export interface RegistryPage {
  companies: RegistryCompany[];
  nextPage: number | null; // page registre suivante, null = registre épuisé
}

/**
 * Nom d'entreprise tel qu'on le met dans une requête LinkedIn : on préfère un
 * alias entre parenthèses quand il est substantiel (« JUNG S.A.S (BACK MARKET) »
 * → « BACK MARKET », c'est le nom utilisé sur LinkedIn), sinon le nom légal
 * débarrassé des formes juridiques (« ZAYO INFRASTRUCTURE FRANCE S.A. » →
 * « ZAYO INFRASTRUCTURE FRANCE »).
 */
function queryName(nomComplet: string): string {
  const aliases = [...nomComplet.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
  const alias = aliases.find((a) => a.replace(/[^a-zA-Z]/g, "").length >= 4);
  const cleaned = (alias ?? nomComplet.replace(/\([^)]*\)/g, " "))
    .replace(/[.,]/g, " ")
    .replace(/\b(S A S U|S A R L|S A S|S A|SASU|SARL|EURL|SAS|SCI|SA)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || nomComplet;
}

/**
 * Liste les entreprises du registre correspondant aux filtres (taille, secteur,
 * CA min), à partir de la page `fromPage` (1-based), jusqu'à `max` entreprises
 * environ (arrondi à la page de 25). Chaque entreprise listée est semée dans
 * company_cache — sous son nom légal et ses alias — pour que le filtrage des
 * prospects la retrouve ensuite sans appel réseau.
 */
export async function listCompanies(f: CompanyFilters, max: number, fromPage = 1): Promise<RegistryPage> {
  const base = new URLSearchParams({ etat_administratif: "A", per_page: "25" });
  if (f.effectifs?.size) base.set("tranche_effectif_salarie", [...f.effectifs].join(","));
  if (f.sections?.size) base.set("section_activite_principale", [...f.sections].join(","));
  if (f.caMin) base.set("ca_min", String(f.caMin));
  const companies: RegistryCompany[] = [];
  let page = fromPage;
  let retries = 0;
  while (companies.length < max) {
    await throttle();
    base.set("page", String(page));
    const res = await fetch(`${API_URL}?${base}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && retries < 3) {
      retries++;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) return { companies, nextPage: null };
    const data = (await res.json()) as { results?: Array<Record<string, unknown>>; total_pages?: number };
    for (const r of data.results ?? []) {
      const nom = r.nom_complet ? String(r.nom_complet) : "";
      if (!nom) continue;
      const info: CompanyInfo = {
        siren: r.siren ? String(r.siren) : null,
        effectif: (r.tranche_effectif_salarie as string) ?? null,
        naf_section: (r.section_activite_principale as string) ?? null,
        ca: latestCa(r.finances),
      };
      const keys = [nameKey(nom), ...[...nom.matchAll(/\(([^)]+)\)/g)].map((m) => nameTokens(m[1]))];
      for (const key of new Set(keys)) {
        if (key && !cacheGet.get(key)) cachePut.run(key, JSON.stringify(info), Date.now());
      }
      companies.push({ name: queryName(nom), info });
    }
    if (page >= (data.total_pages ?? page)) return { companies, nextPage: null };
    page++;
  }
  return { companies, nextPage: page };
}
