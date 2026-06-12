/**
 * Jobs de prospection, un seul à la fois (suivi via jobStatus(), pollé par l'UI) :
 * - 'prospect' : recherche directe de personnes par poste — file de requêtes
 *   (terme × localisation × page) déroulée jusqu'au quota de prospects, chaque
 *   profil inséré au fil de l'eau (dédoublonné par slug LinkedIn) ;
 * - 'emails' : pour l'export campagne — devine le domaine de l'entreprise de
 *   chaque prospect, en déduit son adresse (pattern du site + SMTP).
 */
import { db } from "../../db.js";
import {
  companyPasses,
  enrichCompanyByName,
  hasCompanyFilters,
  listCompanies,
  type CompanyFilters,
} from "./company.js";
import { crawlEmails, findDomain, normName } from "./domain.js";
import { inferPattern, probeSmtp, resolveEmail } from "./emails.js";
import {
  allEnginesQuarantined,
  allRoleTerms,
  buildQueries,
  companyQuery,
  fetchProspectsPage,
  isExcluded,
  locationList,
  roleMatches,
  scrapeProspects,
  type PeopleSearchParams,
  type Prospect,
} from "./linkedin.js";
import { hasSearchApi } from "./search.js";

export interface JobState {
  running: boolean;
  mode: "prospect" | "emails";
  target: number; // prospects voulus (mode prospect)
  found: number; // prospects ajoutés (ou emails trouvés en mode emails)
  done: number; // requêtes traitées (ou entreprises traitées en mode emails)
  total: number; // requêtes planifiées (ou entreprises à traiter)
  current: string | null; // requête ou entreprise en cours
  errors: string[];
}

const state: JobState = {
  running: false,
  mode: "prospect",
  target: 0,
  found: 0,
  done: 0,
  total: 0,
  current: null,
  errors: [],
};

interface ProspectRun {
  params: PeopleSearchParams;
  terms: string[]; // termes acceptés au filtrage (postes exacts + équivalents)
  exclude: string[]; // mots-clés bannis (titre/entreprise)
  locations: string[]; // localisations demandées, normalisées (filtrage)
  company: CompanyFilters; // filtres taille/secteur/CA (enrichissement registre)
  searchId: number; // scope « recherche en cours » des prospects insérés
  target: number;
  found: number;
  units: Array<{ query: string; page: number }>; // file restante (pages 0..9 de chaque requête)
  dead: Set<string>; // requêtes épuisées (page incomplète, ou déjà passées en scraping)
  byCompany: boolean; // mode « ciblage par entreprises » (filtres entreprise actifs)
  regPage: number | null; // prochaine page du registre à énumérer (null = épuisé)
}

// Dernière recherche : sert aussi après la fin du job (scope du tableau,
// bouton « chercher plus » qui reprend la file où elle s'est arrêtée).
let run: ProspectRun | null = null;

export function currentSearchId(): number | null {
  return run?.searchId ?? null;
}

export function jobStatus(): JobState & { search_id: number | null; has_more: boolean } {
  return {
    ...state,
    errors: [...state.errors],
    search_id: run?.searchId ?? null,
    has_more: Boolean(
      run && (run.units.some((u) => !run!.dead.has(u.query)) || (run.byCompany && run.regPage !== null))
    ),
  };
}

const API_PAGES = 10; // Google CSE s'arrête à start=91 ; Serper/Brave suivent
const NO_API_MSG =
  "Les moteurs publics sont tous en quarantaine (anti-bot) — recherche interrompue, « Chercher plus » " +
  "reprendra plus tard. Pour des résultats fiables et massifs, ajoutez une clé d'API de recherche " +
  "gratuite dans .env (SERPER_API_KEY recommandé, voir .env.example).";

/**
 * Identifiant stable d'une recherche : les mêmes paramètres (poste,
 * localisation, secteur) retombent sur le même scope — relancer la recherche
 * demain accumule dans le même tableau au lieu d'en repartir un nouveau.
 */
function searchIdFor(params: PeopleSearchParams, company: CompanyFilters): number {
  const clean = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = [
    params.roles.map(clean).sort().join(","),
    (params.exclude ?? []).map(clean).sort().join(","),
    clean(params.location),
    clean(params.sector),
    params.franceOnly ? "fr" : "",
    [...(company.effectifs ?? [])].sort().join("+"),
    [...(company.sections ?? [])].sort().join("+"),
    company.caMin ?? "",
  ].join("|");
  const row = db.prepare("SELECT search_id FROM searches WHERE key = ?").get(key) as
    | { search_id: number }
    | undefined;
  if (row) return row.search_id;
  const id = Date.now();
  db.prepare("INSERT INTO searches (key, search_id) VALUES (?, ?)").run(key, id);
  return id;
}

/** Slug normalisé d'une URL de profil : identité du prospect (dédoublonnage). */
function linkedinKey(url: string): string {
  let slug = url.split("/in/")[1] ?? url;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* encodage partiel : on garde brut */
  }
  return slug.toLowerCase().replace(/\/+$/, "");
}

const insertProspect = db.prepare(`
  INSERT OR IGNORE INTO prospects
    (first_name, last_name, role, company, location, linkedin, linkedin_key, search_role, search_id,
     company_effectif, company_section, company_ca)
  VALUES
    (@first_name, @last_name, @role, @company, @location, @linkedin, @linkedin_key, @search_role, @search_id,
     @company_effectif, @company_section, @company_ca)
`);

/**
 * Insère les personnes qui passent tous les filtres (poste, mots-clés exclus,
 * localisation, puis taille/secteur via enrichissement entreprise — fait en
 * dernier car c'est le seul appel réseau). Renvoie le nombre de nouvelles lignes.
 */
async function keepProspects(prospects: Prospect[], r: ProspectRun): Promise<number> {
  let added = 0;
  const filterCompany = hasCompanyFilters(r.company);
  for (const p of prospects) {
    // précision avant rappel : seuls les postes correspondant à un mot-clé entrent
    if (!roleMatches(p.role, r.terms)) continue;
    // mots-clés bannis dans le titre ou l'entreprise (ex. « senior »)
    if (isExcluded(p.role, r.exclude) || isExcluded(p.company, r.exclude)) continue;
    // localisation demandée : un profil situé ailleurs est écarté (le mot-clé de
    // ville peut matcher n'importe où dans la page) ; lieu inconnu toléré
    if (r.locations.length && p.location && !r.locations.some((l) => normName(p.location!).includes(l))) continue;

    // filtres entreprise : on enrichit la boîte (taille/secteur/CA) et on écarte
    // si elle ne correspond pas — ou si elle est introuvable au registre
    let info = null;
    if (filterCompany) {
      if (!p.company) continue; // sans entreprise, impossible de filtrer → écarté
      info = await enrichCompanyByName(p.company);
      if (!companyPasses(info, r.company)) continue;
    }
    const { changes } = insertProspect.run({
      ...p,
      linkedin_key: linkedinKey(p.linkedin),
      search_role: r.params.roles.join(", "),
      search_id: r.searchId,
      company_effectif: info?.effectif ?? null,
      company_section: info?.naf_section ?? null,
      company_ca: info?.ca ?? null,
    });
    added += changes;
  }
  return added;
}

/**
 * Lance la recherche de personnes en tâche de fond. `cont` reprend la file de
 * la recherche précédente avec `target` prospects EN PLUS (pages suivantes,
 * requêtes restantes). Renvoie false si un job tourne déjà.
 */
export function startProspecting(
  params: PeopleSearchParams,
  company: CompanyFilters,
  target: number,
  cont: boolean
): boolean {
  if (state.running) return false;
  if (cont && run) {
    run.target = run.found + target;
    // sans API, les quarantaines expirent : les requêtes redeviennent tentables
    if (!hasSearchApi()) run.dead.clear();
  } else {
    // filtres entreprise actifs → mode « ciblage par entreprises » : la file se
    // remplit par lots depuis le registre (voir refill plus bas), une requête
    // par boîte — chaque entreprise ouvre son propre espace de résultats
    const byCompany = hasCompanyFilters(company);
    const units: ProspectRun["units"] = [];
    if (!byCompany) {
      const queries = buildQueries(params);
      // pages en largeur d'abord : page 0 de chaque requête, puis page 1…
      // les premiers prospects arrivent vite et de requêtes variées
      for (let page = 0; page < API_PAGES; page++) for (const query of queries) units.push({ query, page });
    }
    run = {
      params,
      terms: allRoleTerms(params.roles),
      exclude: params.exclude ?? [],
      locations: locationList(params.location).map(normName),
      company,
      searchId: searchIdFor(params, company),
      target,
      found: 0,
      units,
      dead: new Set(),
      byCompany,
      regPage: byCompany ? 1 : null,
    };
  }
  const r = run;

  state.running = true;
  state.mode = "prospect";
  state.target = r.target;
  state.found = r.found;
  state.done = 0;
  state.total = r.units.filter((u) => !r.dead.has(u.query)).length;
  state.current = null;
  state.errors = [];

  void (async () => {
    // Mode « ciblage par entreprises » : remplit la file avec un lot de boîtes
    // énumérées au registre (2 pages de résultats par boîte, en largeur d'abord).
    // Appelé quand la file est vide ; regPage avance pour que « chercher plus »
    // reprenne au lot suivant. Le registre est gratuit : seules les requêtes
    // LinkedIn (Serper) consomment des crédits, et la boucle s'arrête au quota.
    const refill = async (): Promise<void> => {
      if (!r.byCompany || r.regPage === null) return;
      state.current = "énumération des entreprises (registre)…";
      const batch = Math.min(600, Math.max(100, (r.target - r.found) * 3));
      const { companies, nextPage } = await listCompanies(r.company, batch, r.regPage);
      r.regPage = nextPage;
      for (let page = 0; page < 2; page++) {
        for (const c of companies) r.units.push({ query: companyQuery(r.params, c.name), page });
      }
      state.total = state.done + r.units.filter((u) => !r.dead.has(u.query)).length;
    };
    try {
      while (r.found < r.target) {
        if (!r.units.length) {
          await refill();
          if (!r.units.length) break;
        }
        const unit = r.units.shift()!;
        if (r.dead.has(unit.query)) continue;
        state.current = unit.query.replace(/^site:\S+\s+/, ""); // libellé lisible
        let prospects: Prospect[];
        const api = await fetchProspectsPage(unit.query, unit.page, r.terms);
        if (api !== null) {
          prospects = api.prospects;
          if (api.raw < 10) r.dead.add(unit.query); // plus de pages à attendre
        } else {
          // pas d'API (ou plus disponible) : scraping public — une seule passe
          // par requête, les pages sont gérées moteur par moteur
          if (unit.page > 0) {
            r.dead.add(unit.query);
            continue;
          }
          prospects = (await scrapeProspects(unit.query, r.terms, { engines: 3, pages: 2 })) ?? [];
          r.dead.add(unit.query);
          if (!prospects.length && allEnginesQuarantined()) {
            state.errors.push(NO_API_MSG);
            break;
          }
        }
        const added = await keepProspects(prospects, r);
        r.found += added;
        state.found = r.found;
        state.done++;
      }
    } catch (err) {
      state.errors.push(err instanceof Error ? err.message : String(err));
    }
    state.running = false;
    state.current = null;
  })();
  return true;
}

// --- Emails (optionnel, pour l'export campagne) -------------------------------

/** Domaine HELO pour le dialogue SMTP : celui du premier compte connecté. */
function heloDomain(): string {
  const row = db.prepare("SELECT email FROM accounts WHERE active = 1 ORDER BY id LIMIT 1").get() as
    | { email: string }
    | undefined;
  return row?.email.split("@")[1] ?? "example.com";
}

interface ProspectRow {
  id: number;
  first_name: string;
  last_name: string;
  company: string | null;
}

/**
 * Cherche l'email professionnel des prospects donnés : domaine deviné depuis
 * le nom d'entreprise, pattern d'adressage du site, vérification SMTP quand
 * c'est possible. Renvoie false si un job tourne déjà.
 */
export function startEmailJob(ids: number[]): boolean {
  if (state.running) return false;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, company FROM prospects WHERE id IN (${placeholders}) AND email IS NULL`
    )
    .all(...ids) as ProspectRow[];

  // sans entreprise, pas de domaine à chercher
  const noCompany = rows.filter((p) => !p.company);
  const setStatus = db.prepare("UPDATE prospects SET email_status = ? WHERE id = ?");
  for (const p of noCompany) setStatus.run("no_domain", p.id);

  const groups = new Map<string, ProspectRow[]>();
  for (const p of rows) {
    if (!p.company) continue;
    const key = p.company.toLowerCase();
    if (groups.has(key)) groups.get(key)!.push(p);
    else groups.set(key, [p]);
  }

  state.running = true;
  state.mode = "emails";
  state.target = 0;
  state.found = 0;
  state.done = 0;
  state.total = groups.size;
  state.current = null;
  state.errors = [];

  const helo = heloDomain();
  const updEmail = db.prepare("UPDATE prospects SET email = ?, email_status = ? WHERE id = ?");
  void (async () => {
    // 2 entreprises en parallèle : assez rapide sans matraquer les sites
    const queue = [...groups.values()];
    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        const company = group[0].company!;
        state.current = company;
        try {
          const dom = await findDomain({ name: company, brand: null, ville: null });
          if (!dom) {
            for (const p of group) setStatus.run("no_domain", p.id);
          } else {
            const { emails } = await crawlEmails(dom.domain, dom.homepage);
            const pattern = inferPattern(emails, group);
            const probe = await probeSmtp(dom.domain, helo);
            try {
              for (const p of group) {
                const r = await resolveEmail(p.first_name, p.last_name, dom.domain, pattern, probe);
                updEmail.run(r.email, r.status, p.id);
                if (r.email) state.found++;
              }
            } finally {
              probe.close();
            }
          }
        } catch (err) {
          state.errors.push(`${company} : ${err instanceof Error ? err.message : err}`);
        }
        state.done++;
      }
    };
    await Promise.all([worker(), worker()]);
    state.running = false;
    state.current = null;
  })();
  return true;
}
