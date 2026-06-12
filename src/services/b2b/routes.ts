/**
 * Routes de la prospection : recherche de personnes par poste (LinkedIn),
 * suivi du job, tableau des prospects, emails optionnels et exports.
 */
import type express from "express";
import { db } from "../../db.js";
import { importContacts } from "../contacts.js";
import { currentSearchId, jobStatus, startEmailJob, startProspecting } from "./enrich.js";
import { hasSearchApi } from "./search.js";

export function registerB2bRoutes(app: express.Express): void {
  app.get("/api/b2b/meta", (_req, res) => res.json({ search_api: hasSearchApi() }));

  // --- Recherche de personnes (job en tâche de fond) ---
  app.post("/api/b2b/prospect", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
    const cont = Boolean(b.continue);
    const poste = s("poste");
    if (!cont && !poste) {
      return res.status(400).json({ error: "Indiquez le poste recherché (ex. directeur commercial)" });
    }
    const target = Math.min(Math.max(Math.round(Number(b.target)) || 50, 5), 1000);
    const params = { role: poste ?? "", location: s("localisation"), sector: s("secteur") };
    if (!startProspecting(params, target, cont)) {
      return res.status(409).json({ error: "Une recherche est déjà en cours" });
    }
    res.json({ ok: true });
  });

  app.get("/api/b2b/status", (_req, res) => res.json(jobStatus()));

  // --- Emails (optionnel) : domaine deviné depuis l'entreprise → adresse ---
  app.post("/api/b2b/emails", (req, res) => {
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids[] est requis" });
    if (!startEmailJob(ids.map(Number).filter(Number.isFinite))) {
      return res.status(409).json({ error: "Un job est déjà en cours" });
    }
    res.json({ ok: true });
  });

  // --- Prospects ---
  interface ProspectRow {
    id: number;
    first_name: string;
    last_name: string;
    role: string | null;
    company: string | null;
    location: string | null;
    linkedin: string;
    email: string | null;
    email_status: string;
    search_role: string | null;
    in_contacts: number;
  }

  function queryProspects(query: Record<string, unknown>): ProspectRow[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (query.scope === "search") {
      const sid = currentSearchId();
      if (!sid) return [];
      conds.push("search_id = ?");
      params.push(sid);
    }
    if (query.ids) {
      const ids = String(query.ids).split(",").map(Number).filter(Number.isFinite);
      if (ids.length) {
        conds.push(`id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
    }
    if (query.role) {
      // plusieurs mots-clés possibles, séparés par des virgules (ex. directeur,ceo)
      const keywords = String(query.role).split(",").map((s) => s.trim()).filter(Boolean);
      if (keywords.length) {
        conds.push(`(${keywords.map(() => "role LIKE ?").join(" OR ")})`);
        params.push(...keywords.map((k) => `%${k}%`));
      }
    }
    if (query.q) {
      conds.push("(first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR location LIKE ?)");
      const like = `%${String(query.q)}%`;
      params.push(like, like, like, like);
    }
    if (query.email) conds.push("email IS NOT NULL");
    return db
      .prepare(
        `SELECT id, first_name, last_name, role, company, location, linkedin, email, email_status, search_role,
                EXISTS(SELECT 1 FROM contacts ct WHERE ct.email = prospects.email) AS in_contacts
         FROM prospects
         ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
         ORDER BY id DESC
         LIMIT 5000`
      )
      .all(...params) as ProspectRow[];
  }

  app.get("/api/b2b/prospects", (req, res) => {
    res.json(queryProspects(req.query as Record<string, unknown>));
  });

  // --- Export CSV (mêmes filtres que /api/b2b/prospects, ou ids=1,2,3) ---
  app.get("/api/b2b/prospects.csv", (req, res) => {
    const STATUS_FR: Record<string, string> = {
      pending: "",
      verified: "vérifié",
      pattern: "pattern du site",
      probable: "probable",
      not_found: "introuvable",
      no_domain: "sans domaine",
    };
    const rows = queryProspects(req.query as Record<string, unknown>);
    const headers = ["prenom", "nom", "poste", "entreprise", "localisation", "linkedin", "email", "statut_email"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.first_name, r.last_name, r.role, r.company, r.location, r.linkedin, r.email, STATUS_FR[r.email_status] ?? r.email_status]
        .map(cell)
        .join(";")
    );
    // BOM + point-virgule : ouverture directe dans Excel/Numbers FR
    const csv = "\uFEFF" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // --- Export d'une sélection vers une campagne (prospects avec email) ---
  app.post("/api/b2b/export", async (req, res) => {
    const { campaign_id, ids } = req.body as { campaign_id?: number; ids?: number[] };
    if (!campaign_id || !Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "campaign_id et ids[] sont requis" });
    }
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(campaign_id);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const rows = queryProspects({ ids: ids.join(",") }).filter((r) => r.email);
    if (!rows.length) return res.status(400).json({ error: "Aucun prospect avec email dans la sélection" });
    // poste/localisation/linkedin partent en champs personnalisés ({{poste}}…)
    const contacts = rows.map((r) => ({
      email: r.email!,
      first_name: r.first_name,
      last_name: r.last_name,
      company: r.company ?? "",
      poste: r.role ?? "",
      localisation: r.location ?? "",
      linkedin: r.linkedin,
    }));
    try {
      res.json(await importContacts(campaign_id, contacts));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
