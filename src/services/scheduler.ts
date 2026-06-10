import { config } from "../config.js";
import { db } from "../db.js";
import { pushSequenceStatus } from "./attio.js";
import { renderTemplate } from "./contacts.js";
import { sendEmail, threadHasReply, type AccountRow } from "./google.js";

/** Pousse l'avancement vers Attio sans bloquer le workflow en cas d'erreur. */
function syncAttio(attioRecordId: string | null, value: string): void {
  if (!attioRecordId) return;
  pushSequenceStatus(attioRecordId, value).catch((err) =>
    console.error("[attio] mise à jour impossible :", err instanceof Error ? err.message : err)
  );
}

const d = config.deliverability;

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function inSendWindow(now = new Date()): boolean {
  if (d.weekdaysOnly) {
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }
  const h = now.getHours();
  return h >= d.sendWindowStart && h < d.sendWindowEnd;
}

interface DueRow {
  cc_id: number;
  campaign_id: number;
  contact_id: number;
  status: string;
  current_step: number;
  account_id: number | null;
  thread_id: string | null;
  last_gmail_message_id: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  extra: string | null;
  attio_record_id: string | null;
}

interface StepRow {
  step_number: number;
  subject: string;
  body: string;
  wait_days: number;
}

/** Remet à zéro les compteurs quotidiens si la date a changé. */
function resetDailyCounters(): void {
  db.prepare(
    "UPDATE accounts SET sent_today = 0, sent_today_date = ? WHERE sent_today_date IS NOT ? "
  ).run(today(), today());
}

/** Choisit le compte le moins chargé, sous quota et hors période de repos. */
function pickAccount(now: number): AccountRow | undefined {
  return db
    .prepare(
      `SELECT * FROM accounts
       WHERE active = 1
         AND sent_today < daily_limit
         AND (next_allowed_at IS NULL OR next_allowed_at <= ?)
       ORDER BY sent_today ASC, COALESCE(last_sent_at, 0) ASC
       LIMIT 1`
    )
    .get(now) as AccountRow | undefined;
}

function accountById(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

/** Planifie l'étape suivante avec un jitter aléatoire (délivrabilité). */
function scheduleNext(ccId: number, nextStep: StepRow): void {
  const jitterMs = randBetween(0, 4 * 3600 * 1000); // 0 à 4 h de variabilité
  const at = Date.now() + nextStep.wait_days * 24 * 3600 * 1000 + jitterMs;
  db.prepare(
    "UPDATE campaign_contacts SET status = 'in_progress', next_send_at = ? WHERE id = ?"
  ).run(Math.round(at), ccId);
}

async function processOne(row: DueRow): Promise<void> {
  const steps = db
    .prepare("SELECT step_number, subject, body, wait_days FROM steps WHERE campaign_id = ? ORDER BY step_number")
    .all(row.campaign_id) as StepRow[];
  const step = steps.find((s) => s.step_number === row.current_step + 1);
  if (!step) {
    db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
    return;
  }

  const now = Date.now();
  // Continuité du fil : les relances partent toujours du compte du 1er envoi
  const account = row.account_id ? accountById(row.account_id) : pickAccount(now);
  if (!account || account.active !== 1) return; // aucun compte disponible, on retentera au prochain tick
  if (account.sent_today >= account.daily_limit) return;
  if (account.next_allowed_at && account.next_allowed_at > now) return;

  const contact = {
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    company: row.company,
    extra: row.extra,
  };
  const senderVars = { sender_name: account.from_name ?? account.email };
  const isFollowUp = row.current_step > 0 && !!row.thread_id;
  const firstSubject = db
    .prepare("SELECT subject FROM steps WHERE campaign_id = ? AND step_number = 1")
    .get(row.campaign_id) as { subject: string } | undefined;
  const subject = isFollowUp && !step.subject
    ? `Re: ${renderTemplate(firstSubject?.subject ?? "", contact, senderVars)}`
    : renderTemplate(step.subject, contact, senderVars);

  let body = renderTemplate(step.body, contact, senderVars);
  if (account.signature) {
    body += `\n\n${renderTemplate(account.signature, contact, senderVars)}`;
  }

  try {
    const result = await sendEmail(account, {
      to: row.email,
      subject,
      body,
      threadId: isFollowUp ? row.thread_id : null,
      inReplyTo: isFollowUp ? row.last_gmail_message_id : null,
    });

    const gap = Math.round(randBetween(d.minGapSeconds, d.maxGapSeconds) * 1000);
    db.transaction(() => {
      db.prepare(
        `UPDATE accounts SET sent_today = sent_today + 1, sent_today_date = ?,
         last_sent_at = ?, next_allowed_at = ? WHERE id = ?`
      ).run(today(), now, now + gap, account.id);
      db.prepare(
        `UPDATE campaign_contacts SET current_step = ?, account_id = ?, thread_id = ?,
         last_gmail_message_id = ?, error = NULL WHERE id = ?`
      ).run(step.step_number, account.id, result.threadId, result.rfc822MessageId, row.cc_id);
      db.prepare(
        `INSERT INTO messages (campaign_contact_id, account_id, step_number, gmail_message_id, gmail_thread_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(row.cc_id, account.id, step.step_number, result.gmailMessageId, result.threadId);
    })();

    const next = steps.find((s) => s.step_number === step.step_number + 1);
    if (next) {
      scheduleNext(row.cc_id, next);
      syncAttio(row.attio_record_id, `Étape ${step.step_number}/${steps.length} envoyée`);
    } else {
      db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
      syncAttio(row.attio_record_id, `Séquence terminée (${steps.length} emails, sans réponse)`);
    }
    console.log(`[envoi] étape ${step.step_number} -> ${row.email} via ${account.email}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[envoi] échec pour ${row.email} :`, msg);
    // Retentera dans 1 à 2 h ; après 3 échecs consécutifs le contact passe en 'failed'
    const failures = (db
      .prepare("SELECT error FROM campaign_contacts WHERE id = ?")
      .get(row.cc_id) as { error: string | null }).error;
    const count = failures?.startsWith("retry:") ? parseInt(failures.split(":")[1], 10) + 1 : 1;
    if (count >= 3) {
      db.prepare(
        "UPDATE campaign_contacts SET status = 'failed', error = ?, next_send_at = NULL WHERE id = ?"
      ).run(msg, row.cc_id);
      syncAttio(row.attio_record_id, "Échec d'envoi ⚠️");
    } else {
      db.prepare("UPDATE campaign_contacts SET error = ?, next_send_at = ? WHERE id = ?").run(
        `retry:${count}:${msg}`,
        Math.round(Date.now() + randBetween(1, 2) * 3600 * 1000),
        row.cc_id
      );
    }
  }
}

/** Un tick d'envoi : traite quelques contacts dus, dans la fenêtre autorisée. */
export async function sendTick(): Promise<void> {
  resetDailyCounters();
  if (!inSendWindow()) return;

  const due = db
    .prepare(
      `SELECT cc.id AS cc_id, cc.campaign_id, cc.contact_id, cc.status, cc.current_step,
              cc.account_id, cc.thread_id, cc.last_gmail_message_id,
              c.email, c.first_name, c.last_name, c.company, c.extra, c.attio_record_id
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       JOIN campaigns cp ON cp.id = cc.campaign_id
       WHERE cp.status = 'active'
         AND cc.status IN ('pending', 'in_progress')
         AND (cc.next_send_at IS NULL OR cc.next_send_at <= ?)
       ORDER BY COALESCE(cc.next_send_at, 0) ASC
       LIMIT 5`
    )
    .all(Date.now()) as DueRow[];

  for (const row of due) {
    await processOne(row);
    // Pause aléatoire entre deux traitements du même tick (variabilité temporelle)
    await new Promise((r) => setTimeout(r, randBetween(2000, 8000)));
  }
}

/** Vérifie les fils en cours : toute réponse retire le contact du workflow. */
export async function checkRepliesTick(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT cc.id AS cc_id, cc.thread_id, cc.account_id, c.email, c.attio_record_id
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.status IN ('in_progress', 'completed')
         AND cc.thread_id IS NOT NULL
         AND cc.replied_at IS NULL
       LIMIT 100`
    )
    .all() as Array<{
      cc_id: number;
      thread_id: string;
      account_id: number;
      email: string;
      attio_record_id: string | null;
    }>;

  for (const row of rows) {
    const account = accountById(row.account_id);
    if (!account) continue;
    try {
      if (await threadHasReply(account, row.thread_id)) {
        db.prepare(
          "UPDATE campaign_contacts SET status = 'replied', replied_at = ?, next_send_at = NULL WHERE id = ?"
        ).run(Date.now(), row.cc_id);
        syncAttio(row.attio_record_id, "A répondu ✅");
        console.log(`[réponse] ${row.email} a répondu — retiré du workflow`);
      }
    } catch (err) {
      console.error(`[réponse] vérification impossible pour ${row.email} :`, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, randBetween(300, 1200)));
  }
}

let started = false;

/** Démarre les boucles avec des intervalles légèrement aléatoires. */
export function startScheduler(): void {
  if (started) return;
  started = true;

  const loop = (fn: () => Promise<void>, minMs: number, maxMs: number) => {
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        console.error("[scheduler]", err instanceof Error ? err.message : err);
      }
      setTimeout(run, randBetween(minMs, maxMs));
    };
    setTimeout(run, randBetween(2000, 10000));
  };

  loop(sendTick, 45_000, 120_000); // envois : toutes les ~1-2 min
  loop(checkRepliesTick, 4 * 60_000, 7 * 60_000); // réponses : toutes les ~4-7 min
  console.log("[scheduler] démarré (envois + détection de réponses)");
}
