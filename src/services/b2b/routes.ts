/**
 * Routes du moteur de recherche B2B : recherche d'entreprises (API publique),
 * enrichissement local (domaine + emails) et export des leads vers une campagne.
 */
import type express from "express";
import { db } from "../../db.js";
import { importContacts } from "../contacts.js";
import { EFFECTIF_LABELS, SECTION_LABELS, searchCompanies, type SearchFilters } from "./annuaire.js";
import { ensureDirigeantLeads, jobStatus, startEnrich } from "./enrich.js";
import { hasSearchApi } from "./search.js";

export function registerB2bRoutes(app: express.Express): void {
  // Référentiels pour les filtres de l'UI
  app.get("/api/b2b/referentiels", (_req, res) => {
    res.json({ sections: SECTION_LABELS, effectifs: EFFECTIF_LABELS, search_api: hasSearchApi() });
  });

  // --- Recherche d'entreprises (proxy API publique + cache local) ---
  app.get("/api/b2b/search", async (req, res) => {
    const q = (name: string) => (req.query[name] ? String(req.query[name]) : undefined);
    const filters: SearchFilters = {
      q: q("q"),
      naf: q("naf"),
      section: q("section"),
      effectifs: q("effectifs"),
      departements: q("departements"),
      code_postal: q("code_postal"),
      categorie: q("categorie"),
      ca_min: q("ca_min") ? Number(q("ca_min")) : undefined,
      ca_max: q("ca_max") ? Number(q("ca_max")) : undefined,
      page: q("page") ? Number(q("page")) : 1,
    };
    try {
      const result = await searchCompanies(filters);

      // Cache local : on mémorise les entreprises vues (sans écraser l'enrichissement)
      const upsert = db.prepare(`
        INSERT INTO b2b_companies (siren, name, brand, naf, naf_section, effectif, categorie, ville, code_postal, departement, date_creation, raw)
        VALUES (@siren, @name, @brand, @naf, @naf_section, @effectif, @categorie, @ville, @code_postal, @departement, @date_creation, @raw)
        ON CONFLICT(siren) DO UPDATE SET
          name = excluded.name,
          brand = COALESCE(excluded.brand, b2b_companies.brand),
          naf = excluded.naf, naf_section = excluded.naf_section,
          effectif = excluded.effectif, categorie = excluded.categorie,
          ville = excluded.ville, code_postal = excluded.code_postal,
          departement = excluded.departement, date_creation = excluded.date_creation,
          raw = excluded.raw
      `);
      db.transaction(() => {
        for (const c of result.companies) {
          upsert.run({
            siren: c.siren,
            name: c.name,
            brand: c.brand,
            naf: c.naf,
            naf_section: c.naf_section,
            effectif: c.effectif,
            categorie: c.categorie,
            ville: c.ville,
            code_postal: c.code_postal,
            departement: c.departement,
            date_creation: c.date_creation,
            raw: JSON.stringify({ dirigeants_parsed: c.dirigeants }),
          });
          // les dirigeants apparaissent immédiatement comme prospects,
          // l'enrichissement (LinkedIn, emails) viendra compléter leurs lignes
          ensureDirigeantLeads(c.siren, c.dirigeants);
        }
      })();

      // État local (enrichissement) fusionné dans la réponse, en une seule requête
      const sirens = result.companies.map((c) => c.siren);
      const locals = sirens.length
        ? (db
            .prepare(
              `SELECT siren, domain, domain_status, email_pattern, smtp, enriched_at,
                 (SELECT COUNT(*) FROM b2b_leads l WHERE l.siren = b2b_companies.siren AND l.email IS NOT NULL) AS emails_found
               FROM b2b_companies WHERE siren IN (${sirens.map(() => "?").join(",")})`
            )
            .all(...sirens) as Array<{ siren: string }>)
        : [];
      const localBySiren = new Map(locals.map((l) => [l.siren, l]));
      res.json({
        total: result.total,
        page: result.page,
        total_pages: result.total_pages,
        companies: result.companies.map((c) => ({ ...c, ...localBySiren.get(c.siren) })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Enrichissement (job en tâche de fond) ---
  app.post("/api/b2b/enrich", (req, res) => {
    const { sirens, emails, linkedin, people } = req.body as {
      sirens?: string[];
      emails?: boolean;
      linkedin?: boolean;
      people?: string; // mot-clé de fonction à chercher sur LinkedIn (ex. "commercial")
    };
    if (!Array.isArray(sirens) || !sirens.length) {
      return res.status(400).json({ error: "sirens[] est requis" });
    }
    const opts = {
      emails: emails ?? false,
      linkedin: linkedin ?? true,
      people: typeof people === "string" && people.trim() ? people.trim() : null,
    };
    if (!opts.emails && !opts.linkedin && !opts.people) {
      return res.status(400).json({ error: "Choisissez au moins LinkedIn, Emails ou une fonction à chercher" });
    }
    if (!startEnrich(sirens.map(String), opts)) {
      return res.status(409).json({ error: "Un enrichissement est déjà en cours" });
    }
    res.json({ ok: true, total: sirens.length });
  });

  app.get("/api/b2b/enrich/status", (_req, res) => res.json(jobStatus()));

  // --- Correction manuelle du domaine d'une entreprise ---
  app.patch("/api/b2b/companies/:siren", (req, res) => {
    const { domain } = req.body as { domain?: string };
    const clean = (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const { changes } = db
      .prepare(
        `UPDATE b2b_companies SET domain = ?, domain_status = ?, email_pattern = NULL, smtp = NULL, enriched_at = NULL WHERE siren = ?`
      )
      .run(clean || null, clean ? "manual" : null, req.params.siren);
    if (!changes) return res.status(404).json({ error: "Entreprise inconnue" });
    res.json({ ok: true, domain: clean || null });
  });

  // --- Leads (prospects trouvés) ---
  interface LeadRow {
    id: number;
    siren: string;
    first_name: string | null;
    last_name: string | null;
    role: string | null;
    email: string | null;
    email_status: string;
    source: string;
    linkedin: string | null;
    company: string;
    ville: string | null;
    departement: string | null;
    naf: string | null;
    effectif: string | null;
    domain: string | null;
    in_contacts: number;
  }

  function queryLeads(query: Record<string, unknown>): LeadRow[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (query.ids) {
      const ids = String(query.ids).split(",").map(Number).filter(Number.isFinite);
      if (ids.length) {
        conds.push(`l.id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
    }
    if (query.siren) {
      conds.push("l.siren = ?");
      params.push(String(query.siren));
    }
    if (query.sirens) {
      const sirens = String(query.sirens).split(",").filter(Boolean);
      if (sirens.length) {
        conds.push(`l.siren IN (${sirens.map(() => "?").join(",")})`);
        params.push(...sirens);
      }
    }
    if (query.role) {
      // plusieurs mots-clés possibles, séparés par des virgules (ex. président,ceo)
      const keywords = String(query.role).split(",").map((s) => s.trim()).filter(Boolean);
      if (keywords.length) {
        conds.push(`(${keywords.map(() => "l.role LIKE ?").join(" OR ")})`);
        params.push(...keywords.map((k) => `%${k}%`));
      }
    }
    if (query.status) {
      const statuses = String(query.status).split(",").filter(Boolean);
      conds.push(`l.email_status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (query.linkedin) conds.push("l.linkedin IS NOT NULL");
    if (query.source) {
      conds.push("l.source = ?");
      params.push(String(query.source));
    }
    if (query.q) {
      conds.push("(c.name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ?)");
      const like = `%${String(query.q)}%`;
      params.push(like, like, like);
    }
    return db
      .prepare(
        `SELECT l.id, l.siren, l.first_name, l.last_name, l.role, l.email, l.email_status, l.source, l.linkedin,
                c.name AS company, c.ville, c.departement, c.naf, c.effectif, c.domain,
                EXISTS(SELECT 1 FROM contacts ct WHERE ct.email = l.email) AS in_contacts
         FROM b2b_leads l JOIN b2b_companies c ON c.siren = l.siren
         ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
         ORDER BY c.name, l.source = 'site' DESC, l.id
         LIMIT 2000`
      )
      .all(...params) as LeadRow[];
  }

  app.get("/api/b2b/leads", (req, res) => {
    res.json(queryLeads(req.query as Record<string, unknown>));
  });

  // --- Export CSV des prospects (mêmes filtres que /api/b2b/leads, ou ids=1,2,3) ---
  app.get("/api/b2b/leads.csv", (req, res) => {
    const STATUS_FR: Record<string, string> = {
      pending: "non enrichi",
      verified: "vérifié",
      pattern: "pattern du site",
      probable: "probable",
      generic: "générique",
      not_found: "introuvable",
      no_domain: "sans domaine",
    };
    const rows = queryLeads(req.query as Record<string, unknown>);
    const headers = ["prenom", "nom", "poste", "linkedin", "email", "statut_email", "entreprise", "siren", "ville", "departement", "naf", "effectif", "site_web"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.first_name, r.last_name, r.role, r.linkedin, r.email, r.email ? STATUS_FR[r.email_status] ?? r.email_status : "",
       r.company, r.siren, r.ville, r.departement, r.naf, EFFECTIF_LABELS[r.effectif ?? ""] ?? r.effectif, r.domain]
        .map(cell)
        .join(";")
    );
    // BOM + point-virgule : ouverture directe dans Excel/Numbers FR
    const csv = "\uFEFF" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // --- Export d'une sélection de leads vers une campagne ---
  app.post("/api/b2b/export", async (req, res) => {
    const { campaign_id, lead_ids } = req.body as { campaign_id?: number; lead_ids?: number[] };
    if (!campaign_id || !Array.isArray(lead_ids) || !lead_ids.length) {
      return res.status(400).json({ error: "campaign_id et lead_ids[] sont requis" });
    }
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(campaign_id);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const placeholders = lead_ids.map(() => "?").join(",");
    const leads = db
      .prepare(
        `SELECT l.first_name, l.last_name, l.role, l.email, c.name AS company, c.ville, c.domain
         FROM b2b_leads l JOIN b2b_companies c ON c.siren = l.siren
         WHERE l.id IN (${placeholders}) AND l.email IS NOT NULL`
      )
      .all(...lead_ids) as Array<{
      first_name: string | null;
      last_name: string | null;
      role: string | null;
      email: string;
      company: string;
      ville: string | null;
      domain: string | null;
    }>;
    if (!leads.length) return res.status(400).json({ error: "Aucun lead avec email dans la sélection" });
    // poste/ville/site_web partent en champs personnalisés ({{poste}}, {{ville}}…)
    const rows = leads.map((l) => ({
      email: l.email,
      first_name: l.first_name ?? "",
      last_name: l.last_name ?? "",
      company: l.company,
      poste: l.role ?? "",
      ville: l.ville ?? "",
      site_web: l.domain ?? "",
    }));
    try {
      res.json(await importContacts(campaign_id, rows));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
