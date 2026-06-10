import { parse } from "csv-parse/sync";
import { db } from "../db.js";

const KNOWN_COLUMNS = new Set(["email", "first_name", "last_name", "company"]);

export interface ImportReport {
  imported: number;
  skipped: number;
  errors: string[];
}

/** Insère/met à jour les contacts puis les inscrit à la campagne (statut pending). */
export function importContacts(
  campaignId: number,
  rows: Array<Record<string, string>>,
  source: { attioRecordIds?: Record<string, string> } = {}
): ImportReport {
  const report: ImportReport = { imported: 0, skipped: 0, errors: [] };

  const upsertContact = db.prepare(`
    INSERT INTO contacts (email, first_name, last_name, company, extra, attio_record_id)
    VALUES (@email, @first_name, @last_name, @company, @extra, @attio_record_id)
    ON CONFLICT(email) DO UPDATE SET
      first_name = COALESCE(excluded.first_name, contacts.first_name),
      last_name  = COALESCE(excluded.last_name, contacts.last_name),
      company    = COALESCE(excluded.company, contacts.company),
      extra      = COALESCE(excluded.extra, contacts.extra),
      attio_record_id = COALESCE(excluded.attio_record_id, contacts.attio_record_id)
  `);
  const getContactId = db.prepare("SELECT id FROM contacts WHERE email = ?");
  const enroll = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status)
    VALUES (?, ?, 'pending')
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        report.skipped++;
        if (email) report.errors.push(`Email invalide : ${email}`);
        continue;
      }
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!KNOWN_COLUMNS.has(k) && v) extra[k] = v;
      }
      upsertContact.run({
        email,
        first_name: row.first_name?.trim() || null,
        last_name: row.last_name?.trim() || null,
        company: row.company?.trim() || null,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        attio_record_id: source.attioRecordIds?.[email] ?? null,
      });
      const { id } = getContactId.get(email) as { id: number };
      const r = enroll.run(campaignId, id);
      if (r.changes > 0) report.imported++;
      else report.skipped++; // déjà inscrit à cette campagne
    }
  });
  run();
  return report;
}

/** Parse un CSV (entêtes en première ligne, normalisées en snake_case). */
export function parseCsv(content: string): Array<Record<string, string>> {
  return parse(content, {
    columns: (header: string[]) =>
      header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;
}

/** Remplace les variables {{first_name}}, {{company}}, etc. */
export function renderTemplate(
  template: string,
  contact: { email: string; first_name: string | null; last_name: string | null; company: string | null; extra: string | null }
): string {
  const vars: Record<string, string> = {
    email: contact.email,
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    company: contact.company ?? "",
    ...(contact.extra ? (JSON.parse(contact.extra) as Record<string, string>) : {}),
  };
  return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}
