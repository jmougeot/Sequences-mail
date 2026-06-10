import express from "express";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { db } from "./db.js";
import { authUrl, handleOAuthCallback } from "./services/google.js";
import { importContacts, parseCsv, renderTemplate } from "./services/contacts.js";
import { syncFromAttio } from "./services/attio.js";

export function createServer(): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "20mb" }));
  // Relatif au projet, pas au répertoire de lancement
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  // --- Comptes Google ---
  app.get("/auth/google", (_req, res) => res.redirect(authUrl()));

  app.get("/auth/google/callback", async (req, res) => {
    try {
      const email = await handleOAuthCallback(String(req.query.code ?? ""));
      res.redirect(`/settings.html?connected=${encodeURIComponent(email)}`);
    } catch (err) {
      res.status(500).send(`Erreur OAuth : ${err instanceof Error ? err.message : err}`);
    }
  });

  app.get("/api/accounts", (_req, res) => {
    const rows = db
      .prepare(
        "SELECT id, email, from_name, signature, daily_limit, sent_today, sent_today_date, active FROM accounts ORDER BY email"
      )
      .all();
    res.json(rows);
  });

  app.patch("/api/accounts/:id", (req, res) => {
    const { daily_limit, active, from_name, signature } = req.body as {
      daily_limit?: number;
      active?: boolean;
      from_name?: string;
      signature?: string;
    };
    if (daily_limit !== undefined) {
      db.prepare("UPDATE accounts SET daily_limit = ? WHERE id = ?").run(daily_limit, req.params.id);
    }
    if (active !== undefined) {
      db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(active ? 1 : 0, req.params.id);
    }
    if (from_name !== undefined) {
      db.prepare("UPDATE accounts SET from_name = ? WHERE id = ?").run(from_name.trim() || null, req.params.id);
    }
    if (signature !== undefined) {
      db.prepare("UPDATE accounts SET signature = ? WHERE id = ?").run(signature.trim() || null, req.params.id);
    }
    res.json({ ok: true });
  });

  // --- Campagnes ---
  app.post("/api/campaigns", (req, res) => {
    const { name, steps } = req.body as {
      name: string;
      steps: Array<{ subject?: string; subject_b?: string; body: string; wait_days?: number }>;
    };
    if (!name || !steps?.length) {
      return res.status(400).json({ error: "name et steps[] sont requis" });
    }
    if (!steps[0].subject) {
      return res.status(400).json({ error: "La première étape doit avoir un sujet" });
    }
    const result = db.transaction(() => {
      const { lastInsertRowid } = db.prepare("INSERT INTO campaigns (name) VALUES (?)").run(name);
      const insert = db.prepare(
        "INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days) VALUES (?, ?, ?, ?, ?, ?)"
      );
      steps.forEach((s, i) =>
        insert.run(
          lastInsertRowid,
          i + 1,
          s.subject ?? "",
          i === 0 ? s.subject_b?.trim() || null : null, // A/B test : étape 1 uniquement
          s.body,
          i === 0 ? 0 : (s.wait_days ?? 3)
        )
      );
      return lastInsertRowid;
    })();
    res.json({ id: result });
  });

  app.get("/api/campaigns", (_req, res) => {
    const campaigns = db
      .prepare(
        `SELECT cp.id, cp.name, cp.status, cp.created_at,
           (SELECT COUNT(*) FROM steps s WHERE s.campaign_id = cp.id) AS steps,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id) AS contacts,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'pending') AS pending,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'in_progress') AS in_progress,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'replied') AS replied,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'opted_out') AS opted_out,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'completed') AS completed,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'failed') AS failed,
           (SELECT COUNT(*) FROM messages m JOIN campaign_contacts cc ON cc.id = m.campaign_contact_id
              WHERE cc.campaign_id = cp.id) AS emails_sent,
           (SELECT s.subject_b FROM steps s WHERE s.campaign_id = cp.id AND s.step_number = 1) AS subject_b,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'A' AND cc.current_step > 0) AS contacted_a,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'A' AND cc.status = 'replied') AS replied_a,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'B' AND cc.current_step > 0) AS contacted_b,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'B' AND cc.status = 'replied') AS replied_b
         FROM campaigns cp ORDER BY cp.created_at DESC`
      )
      .all() as Array<Record<string, number | string | null>>;

    const rate = (replied: number, contacted: number) =>
      contacted > 0 ? Math.round((replied / contacted) * 1000) / 10 : 0;

    for (const c of campaigns) {
      const contacted = Number(c.contacts) - Number(c.pending);
      c.reply_rate = rate(Number(c.replied), contacted);
      c.progress =
        Number(c.contacts) > 0
          ? Math.round(((Number(c.contacts) - Number(c.pending) - Number(c.in_progress)) / Number(c.contacts)) * 100)
          : 0;
      c.ab_test = c.subject_b ? 1 : 0;
      c.reply_rate_a = rate(Number(c.replied_a), Number(c.contacted_a));
      c.reply_rate_b = rate(Number(c.replied_b), Number(c.contacted_b));
    }
    res.json(campaigns);
  });

  // Détail d'une campagne avec ses étapes (pour l'édition)
  app.get("/api/campaigns/:id", (req, res) => {
    const campaign = db
      .prepare("SELECT id, name, status FROM campaigns WHERE id = ?")
      .get(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const steps = db
      .prepare(
        "SELECT step_number, subject, subject_b, body, wait_days FROM steps WHERE campaign_id = ? ORDER BY step_number"
      )
      .all(req.params.id);
    res.json({ ...campaign, steps });
  });

  // Modification d'une campagne, y compris en cours : les étapes sont remplacées.
  // Les contacts gardent leur avancement (current_step) ; les prochains envois
  // utilisent le nouveau contenu. Un contact dont l'étape courante dépasse la
  // nouvelle séquence sera marqué 'completed' au prochain passage.
  app.put("/api/campaigns/:id", (req, res) => {
    const exists = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.id);
    if (!exists) return res.status(404).json({ error: "Campagne introuvable" });
    const { name, steps } = req.body as {
      name: string;
      steps: Array<{ subject?: string; subject_b?: string; body: string; wait_days?: number }>;
    };
    if (!name || !steps?.length) {
      return res.status(400).json({ error: "name et steps[] sont requis" });
    }
    if (!steps[0].subject) {
      return res.status(400).json({ error: "La première étape doit avoir un sujet" });
    }
    db.transaction(() => {
      db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name, req.params.id);
      db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(req.params.id);
      const insert = db.prepare(
        "INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days) VALUES (?, ?, ?, ?, ?, ?)"
      );
      steps.forEach((s, i) =>
        insert.run(
          req.params.id,
          i + 1,
          s.subject ?? "",
          i === 0 ? s.subject_b?.trim() || null : null,
          s.body,
          i === 0 ? 0 : (s.wait_days ?? 3)
        )
      );
    })();
    res.json({ ok: true });
  });

  // Aperçu d'un email : rendu des variables avec un vrai contact de la campagne
  // (le premier) ou un contact d'exemple, signature du compte incluse.
  app.post("/api/preview", (req, res) => {
    const { subject, body, account_id, campaign_id } = req.body as {
      subject?: string;
      body?: string;
      account_id?: number;
      campaign_id?: number;
    };
    const contact = (campaign_id
      ? db
          .prepare(
            `SELECT c.email, c.first_name, c.last_name, c.company, c.extra
             FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
             WHERE cc.campaign_id = ? ORDER BY cc.id LIMIT 1`
          )
          .get(campaign_id)
      : undefined) as
      | { email: string; first_name: string | null; last_name: string | null; company: string | null; extra: string | null }
      | undefined;
    const sample = contact ?? {
      email: "marie.dupont@exemple.fr",
      first_name: "Marie",
      last_name: "Dupont",
      company: "Exemple SAS",
      extra: null,
    };
    const account = (account_id
      ? db.prepare("SELECT email, from_name, signature FROM accounts WHERE id = ?").get(account_id)
      : db.prepare("SELECT email, from_name, signature FROM accounts WHERE active = 1 ORDER BY id LIMIT 1").get()) as
      | { email: string; from_name: string | null; signature: string | null }
      | undefined;
    const senderVars = { sender_name: account?.from_name ?? account?.email ?? "Votre nom" };

    let renderedBody = renderTemplate(body ?? "", sample, senderVars);
    if (account?.signature) {
      renderedBody += `\n\n${renderTemplate(account.signature, sample, senderVars)}`;
    }
    res.json({
      from: account ? (account.from_name ? `${account.from_name} <${account.email}>` : account.email) : "(aucun compte connecté)",
      to: sample.email,
      sample_contact: !contact,
      subject: renderTemplate(subject ?? "", sample, senderVars),
      body: renderedBody,
    });
  });

  // Paramètres effectifs (lecture seule, issus du .env)
  app.get("/api/settings", (_req, res) => {
    res.json({
      deliverability: config.deliverability,
      google_configured: Boolean(config.google.clientId),
      attio_configured: Boolean(config.attioApiKey),
      attio_stage_attribute: config.attioStageAttribute || null,
    });
  });

  app.post("/api/campaigns/:id/pause", (req, res) => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/campaigns/:id/resume", (req, res) => {
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // --- Import CSV (body = contenu CSV brut) ---
  app.post("/api/campaigns/:id/import", (req, res) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    try {
      const rows = parseCsv(String(req.body ?? ""));
      if (!rows.length) return res.status(400).json({ error: "CSV vide ou illisible" });
      if (!("email" in rows[0])) {
        return res.status(400).json({ error: "Le CSV doit contenir une colonne 'email'" });
      }
      res.json(importContacts(Number(req.params.id), rows));
    } catch (err) {
      res.status(400).json({ error: `CSV invalide : ${err instanceof Error ? err.message : err}` });
    }
  });

  // --- Synchronisation Attio (bonus) ---
  app.post("/api/campaigns/:id/attio-sync", async (req, res) => {
    const { status_attribute, statuses } = req.body as {
      status_attribute?: string;
      statuses?: string[];
    };
    if (!status_attribute || !statuses?.length) {
      return res.status(400).json({ error: "status_attribute et statuses[] sont requis" });
    }
    try {
      res.json(await syncFromAttio(Number(req.params.id), status_attribute, statuses));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Détail contacts d'une campagne ---
  app.get("/api/campaigns/:id/contacts", (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.email, c.first_name, c.last_name, cc.status, cc.current_step, cc.variant,
                cc.next_send_at, cc.replied_at, cc.error, a.email AS sender
         FROM campaign_contacts cc
         JOIN contacts c ON c.id = cc.contact_id
         LEFT JOIN accounts a ON a.id = cc.account_id
         WHERE cc.campaign_id = ?
         ORDER BY cc.id`
      )
      .all(req.params.id);
    res.json(rows);
  });

  return app;
}
