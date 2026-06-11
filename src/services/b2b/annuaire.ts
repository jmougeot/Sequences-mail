/**
 * Client de l'API publique « Recherche d'Entreprises » (recherche-entreprises.api.gouv.fr).
 * Gratuite, sans clé, limitée à 7 req/s : toutes les entreprises françaises avec
 * secteur NAF, tranche d'effectifs, localisation et dirigeants (nom + fonction).
 */

const API_URL = "https://recherche-entreprises.api.gouv.fr/search";

export interface Dirigeant {
  first_name: string; // premier prénom, mis en forme (Stéphanie)
  last_name: string; // nom mis en forme (Auchabie)
  role: string; // qualité (Président de SAS, Gérant, ...)
}

export interface CompanyHit {
  siren: string;
  name: string;
  brand: string | null;
  naf: string | null;
  naf_section: string | null;
  effectif: string | null; // code INSEE (12 = 20 à 49 salariés)
  categorie: string | null; // PME | ETI | GE
  ville: string | null;
  code_postal: string | null;
  departement: string | null;
  date_creation: string | null;
  dirigeants: Dirigeant[];
}

export interface SearchFilters {
  q?: string;
  naf?: string; // codes NAF précis, séparés par des virgules
  section?: string; // sections NAF A..U, séparées par des virgules
  effectifs?: string; // codes INSEE de tranches, séparés par des virgules
  departements?: string;
  code_postal?: string;
  categorie?: string; // PME,ETI,GE
  ca_min?: number;
  ca_max?: number;
  page?: number;
}

export interface SearchResult {
  total: number;
  page: number;
  total_pages: number;
  per_page: number;
  companies: CompanyHit[];
  raw_by_siren: Record<string, unknown>; // réponse brute par siren (stockée pour l'enrichissement)
}

/** Tranches d'effectifs INSEE → libellés (partagé avec l'UI via /api/b2b/referentiels). */
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

// Throttle simple : l'API autorise 7 req/s, on reste sous 5/s.
let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = lastCall + 220 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

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

// Fonctions de "dirigeants" qui ne sont pas des contacts à prospecter
const EXCLUDED_ROLES = /commissaire aux comptes|liquidateur|administrateur judiciaire|mandataire/i;

function parseDirigeants(raw: unknown): Dirigeant[] {
  if (!Array.isArray(raw)) return [];
  const out: Dirigeant[] = [];
  for (const d of raw as Array<Record<string, string | null>>) {
    if (d.type_dirigeant !== "personne physique") continue;
    const role = (d.qualite ?? "").trim();
    if (EXCLUDED_ROLES.test(role)) continue;
    const last = (d.nom ?? "").trim();
    const first = (d.prenoms ?? "").trim().split(/[\s,]+/)[0] ?? "";
    if (!last || !first) continue;
    out.push({ first_name: titleCase(first), last_name: titleCase(last), role: role || "Dirigeant" });
  }
  return out;
}

export async function searchCompanies(filters: SearchFilters): Promise<SearchResult> {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.naf?.trim()) params.set("activite_principale", filters.naf.trim());
  if (filters.section?.trim()) params.set("section_activite_principale", filters.section.trim());
  if (filters.effectifs?.trim()) params.set("tranche_effectif_salarie", filters.effectifs.trim());
  if (filters.departements?.trim()) params.set("departement", filters.departements.trim());
  if (filters.code_postal?.trim()) params.set("code_postal", filters.code_postal.trim());
  if (filters.categorie?.trim()) params.set("categorie_entreprise", filters.categorie.trim());
  if (filters.ca_min) params.set("ca_min", String(filters.ca_min));
  if (filters.ca_max) params.set("ca_max", String(filters.ca_max));
  params.set("etat_administratif", "A"); // entreprises actives uniquement
  params.set("per_page", "25");
  params.set("page", String(filters.page ?? 1));
  if (![...params.keys()].some((k) => !["etat_administratif", "per_page", "page"].includes(k))) {
    throw new Error("Renseignez au moins un filtre (mots-clés, secteur, effectif, localisation…)");
  }

  await throttle();
  const res = await fetch(`${API_URL}?${params}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    return searchCompanies(filters);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { erreur?: string };
    throw new Error(`API Recherche d'Entreprises : ${body.erreur ?? res.statusText} (${res.status})`);
  }
  const data = (await res.json()) as {
    results: Array<Record<string, unknown>>;
    total_results: number;
    page: number;
    per_page: number;
    total_pages: number;
  };

  const raw_by_siren: Record<string, unknown> = {};
  const companies = data.results.map((r) => {
    const siege = (r.siege ?? {}) as Record<string, string | null>;
    raw_by_siren[String(r.siren)] = r;
    return {
      siren: String(r.siren),
      name: titleCase(String(r.nom_raison_sociale ?? r.nom_complet ?? "")),
      brand: r.siege && siege.nom_commercial ? titleCase(siege.nom_commercial) : null,
      naf: (r.activite_principale as string) ?? null,
      naf_section: (r.section_activite_principale as string) ?? null,
      effectif: (r.tranche_effectif_salarie as string) ?? null,
      categorie: (r.categorie_entreprise as string) ?? null,
      ville: siege.libelle_commune ? titleCase(siege.libelle_commune) : null,
      code_postal: siege.code_postal ?? null,
      departement: siege.departement ?? null,
      date_creation: (r.date_creation as string) ?? null,
      dirigeants: parseDirigeants(r.dirigeants),
    } satisfies CompanyHit;
  });

  return {
    total: data.total_results,
    page: data.page,
    total_pages: data.total_pages,
    per_page: data.per_page,
    companies,
    raw_by_siren,
  };
}
