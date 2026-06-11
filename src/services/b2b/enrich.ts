/**
 * Enrichissement d'entreprises sélectionnées, au choix :
 * - LinkedIn : profil de chaque dirigeant via les moteurs de recherche ;
 * - Emails : domaine → crawl du site → pattern → email par dirigeant
 *   (vérifié SMTP si possible).
 * Un seul job à la fois, suivi via jobStatus() (pollé par l'UI).
 */
import { db } from "../../db.js";
import { crawlEmails, deaccent, findDomain, normName } from "./domain.js";
import { inferPattern, isGenericEmail, probeSmtp, resolveEmail, type Pattern } from "./emails.js";
import { findLinkedIn, findPeopleByRole } from "./linkedin.js";
import type { Dirigeant } from "./annuaire.js";

export interface EnrichOptions {
  emails: boolean;
  linkedin: boolean;
  people: string | null; // mot-clé de fonction à chercher sur LinkedIn (ex. "commercial")
}

export interface JobState {
  running: boolean;
  total: number;
  done: number;
  current: string | null; // nom de l'entreprise en cours
  errors: string[];
  emails_found: number;
  linkedin_found: number;
  people_found: number;
}

const state: JobState = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  errors: [],
  emails_found: 0,
  linkedin_found: 0,
  people_found: 0,
};

export function jobStatus(): JobState {
  return { ...state, errors: [...state.errors] };
}

/** Domaine HELO pour le dialogue SMTP : celui du premier compte connecté. */
function heloDomain(): string {
  const row = db.prepare("SELECT email FROM accounts WHERE active = 1 ORDER BY id LIMIT 1").get() as
    | { email: string }
    | undefined;
  return row?.email.split("@")[1] ?? "example.com";
}

interface CompanyRow {
  siren: string;
  name: string;
  brand: string | null;
  ville: string | null;
  domain: string | null;
  domain_status: string | null;
  raw: string | null;
}

function dirigeantsOf(company: CompanyRow): Dirigeant[] {
  if (!company.raw) return [];
  try {
    const raw = JSON.parse(company.raw) as { dirigeants_parsed?: Dirigeant[] };
    return raw.dirigeants_parsed ?? [];
  } catch {
    return [];
  }
}

/** Garantit une ligne de prospect par dirigeant (sans toucher aux lignes existantes). */
export function ensureDirigeantLeads(siren: string, dirigeants: Dirigeant[]): void {
  const exists = db.prepare(
    "SELECT 1 FROM b2b_leads WHERE siren = ? AND first_name = ? AND last_name = ? LIMIT 1"
  );
  const ins = db.prepare(
    `INSERT INTO b2b_leads (siren, first_name, last_name, role, email, email_status, source)
     VALUES (?, ?, ?, ?, NULL, 'pending', 'dirigeant')`
  );
  for (const d of dirigeants) {
    if (!exists.get(siren, d.first_name, d.last_name)) ins.run(siren, d.first_name, d.last_name, d.role);
  }
}

/**
 * Cherche des personnes par fonction (ex. commerciaux) via les moteurs et les
 * insère comme prospects (source 'linkedin'). Les personnes déjà connues
 * (dirigeants…) reçoivent juste leur URL LinkedIn. Renvoie le nombre ajouté.
 */
async function enrichCompanyPeople(company: CompanyRow, keyword: string): Promise<number> {
  const queryName = company.brand?.split(/\s+-\s+/)[0] ?? company.name;
  const found = await findPeopleByRole(queryName, keyword);
  if (!found.length) return 0;
  const existing = db
    .prepare("SELECT id, first_name, last_name, linkedin FROM b2b_leads WHERE siren = ? AND first_name IS NOT NULL")
    .all(company.siren) as Array<{ id: number; first_name: string; last_name: string; linkedin: string | null }>;
  const byName = new Map(existing.map((r) => [normName(r.first_name + r.last_name), r]));
  const ins = db.prepare(
    `INSERT INTO b2b_leads (siren, first_name, last_name, role, email, email_status, source, linkedin)
     VALUES (?, ?, ?, ?, NULL, 'pending', 'linkedin', ?)`
  );
  const updLinkedin = db.prepare("UPDATE b2b_leads SET linkedin = ? WHERE id = ?");
  let added = 0;
  db.transaction(() => {
    for (const p of found) {
      const known = byName.get(normName(p.first_name + p.last_name));
      if (known) {
        if (!known.linkedin) updLinkedin.run(p.linkedin, known.id);
        continue;
      }
      ins.run(company.siren, p.first_name, p.last_name, p.role, p.linkedin);
      added++;
    }
  })();
  return added;
}

/** Pipeline emails : domaine, crawl, pattern, SMTP. Renvoie le nombre d'emails trouvés. */
async function enrichCompanyEmails(company: CompanyRow, helo: string): Promise<number> {
  // 1. Domaine (conservé s'il a déjà été trouvé ou saisi manuellement)
  let domain = company.domain;
  let domainStatus = company.domain_status;
  let homepage: string | undefined;
  if (!domain) {
    const found = await findDomain(company);
    domain = found?.domain ?? null;
    domainStatus = found?.status ?? "not_found";
    homepage = found?.homepage;
  }

  const dirigeants = dirigeantsOf(company);
  const dirigeantNames = new Set(dirigeants.map((d) => normName(d.first_name + d.last_name)));
  // personnes trouvées par recherche LinkedIn (commerciaux…) : conservées lors
  // de la reconstruction et enrichies en email comme les dirigeants
  const externals = (db
    .prepare(
      "SELECT first_name, last_name, role, linkedin FROM b2b_leads WHERE siren = ? AND source = 'linkedin' AND first_name IS NOT NULL"
    )
    .all(company.siren) as Array<{ first_name: string; last_name: string; role: string | null; linkedin: string | null }>)
    .filter((e) => !dirigeantNames.has(normName(e.first_name + e.last_name)));
  const people = [
    ...dirigeants.map((d) => ({ ...d, source: "dirigeant" })),
    ...externals.map((e) => ({ first_name: e.first_name, last_name: e.last_name, role: e.role ?? "", source: "linkedin" })),
  ];
  // LinkedIn déjà trouvés : à reporter sur les leads reconstruits
  const prevLinkedin = new Map(
    (db.prepare("SELECT first_name, last_name, linkedin FROM b2b_leads WHERE siren = ? AND linkedin IS NOT NULL").all(company.siren) as Array<{ first_name: string | null; last_name: string | null; linkedin: string }>)
      .map((r) => [`${r.first_name}|${r.last_name}`, r.linkedin])
  );
  const leads: Array<{
    first_name: string | null;
    last_name: string | null;
    role: string;
    email: string | null;
    email_status: string;
    source: string;
    linkedin: string | null;
  }> = [];
  const withLinkedin = (l: Omit<(typeof leads)[number], "linkedin">) => ({
    ...l,
    linkedin: prevLinkedin.get(`${l.first_name}|${l.last_name}`) ?? null,
  });
  let pattern: Pattern | null = null;
  let smtpState: string | null = null;

  if (domain) {
    // 2. Crawl du site : emails publiés + pattern d'adressage
    const { emails } = await crawlEmails(domain, homepage);
    pattern = inferPattern(emails, people);
    for (const email of emails.filter(isGenericEmail).slice(0, 3)) {
      leads.push(withLinkedin({ first_name: null, last_name: null, role: "Email générique", email, email_status: "generic", source: "site" }));
    }
    // emails nominatifs publiés sur le site : déjà vérifiés de fait
    for (const email of emails.filter((e) => !isGenericEmail(e)).slice(0, 10)) {
      const matching = people.find((p) =>
        [p.first_name, p.last_name].some((n) => n && email.split("@")[0].includes(deaccent(n.toLowerCase())))
      );
      leads.push(withLinkedin({
        first_name: matching?.first_name ?? null,
        last_name: matching?.last_name ?? null,
        role: matching?.role || "Trouvé sur le site",
        email,
        email_status: "verified",
        source: "site",
      }));
    }

    // 3. Vérification SMTP + email par personne (dirigeants + profils LinkedIn)
    const probe = await probeSmtp(domain, helo);
    smtpState = probe.reachable ? (probe.catchAll ? "catch_all" : "ok") : "unreachable";
    try {
      for (const p of people) {
        if (leads.some((l) => l.first_name === p.first_name && l.last_name === p.last_name)) continue;
        const r = await resolveEmail(p.first_name, p.last_name, domain, pattern, probe);
        leads.push(withLinkedin({ first_name: p.first_name, last_name: p.last_name, role: p.role, email: r.email, email_status: r.status, source: p.source }));
      }
    } finally {
      probe.close();
    }
  } else {
    for (const p of people) {
      leads.push(withLinkedin({ first_name: p.first_name, last_name: p.last_name, role: p.role, email: null, email_status: "no_domain", source: p.source }));
    }
  }

  // 4. Persistance (remplace les leads précédents de l'entreprise)
  db.transaction(() => {
    db.prepare(
      `UPDATE b2b_companies SET domain = ?, domain_status = ?, email_pattern = ?, smtp = ?, enriched_at = ? WHERE siren = ?`
    ).run(domain, domainStatus, pattern, smtpState, Date.now(), company.siren);
    db.prepare("DELETE FROM b2b_leads WHERE siren = ?").run(company.siren);
    const ins = db.prepare(
      `INSERT INTO b2b_leads (siren, first_name, last_name, role, email, email_status, source, linkedin)
       VALUES (@siren, @first_name, @last_name, @role, @email, @email_status, @source, @linkedin)`
    );
    for (const l of leads) ins.run({ siren: company.siren, ...l });
  })();
  return leads.filter((l) => l.email).length;
}

/** Cherche le LinkedIn des prospects nommés qui n'en ont pas encore. */
async function enrichCompanyLinkedin(company: CompanyRow): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name FROM b2b_leads
       WHERE siren = ? AND linkedin IS NULL AND first_name IS NOT NULL AND last_name IS NOT NULL`
    )
    .all(company.siren) as Array<{ id: number; first_name: string; last_name: string }>;
  const update = db.prepare("UPDATE b2b_leads SET linkedin = ? WHERE id = ?");
  let found = 0;
  for (const r of rows) {
    const url = await findLinkedIn(r.first_name, r.last_name, company.brand ?? company.name);
    if (url) {
      update.run(url, r.id);
      found++;
    }
  }
  return found;
}

/** Lance l'enrichissement en tâche de fond. Renvoie false si un job tourne déjà. */
export function startEnrich(sirens: string[], opts: EnrichOptions): boolean {
  if (state.running) return false;
  const placeholders = sirens.map(() => "?").join(",");
  const companies = db
    .prepare(
      `SELECT siren, name, brand, ville, domain, domain_status, raw FROM b2b_companies WHERE siren IN (${placeholders})`
    )
    .all(...sirens) as CompanyRow[];

  state.running = true;
  state.total = companies.length;
  state.done = 0;
  state.current = null;
  state.errors = [];
  state.emails_found = 0;
  state.linkedin_found = 0;
  state.people_found = 0;

  const helo = heloDomain();
  void (async () => {
    // 2 entreprises en parallèle : assez rapide sans matraquer les sites ni les moteurs
    const queue = [...companies];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        state.current = c.name;
        try {
          // pas de `state.x += await …` : la valeur serait capturée avant l'await
          // et les deux workers parallèles s'écraseraient mutuellement
          if (opts.people) {
            const n = await enrichCompanyPeople(c, opts.people);
            state.people_found += n;
          }
          if (opts.emails) {
            const n = await enrichCompanyEmails(c, helo);
            state.emails_found += n;
          } else {
            ensureDirigeantLeads(c.siren, dirigeantsOf(c));
          }
          if (opts.linkedin) {
            const n = await enrichCompanyLinkedin(c);
            state.linkedin_found += n;
          }
        } catch (err) {
          state.errors.push(`${c.name} : ${err instanceof Error ? err.message : err}`);
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
