import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { config, googleRedirectUri } from "../config.js";
import { db } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface AccountRow {
  id: number;
  email: string;
  oauth_tokens: string;
  daily_limit: number;
  sent_today: number;
  sent_today_date: string | null;
  last_sent_at: number | null;
  next_allowed_at: number | null;
  active: number;
  from_name: string | null;
  signature: string | null;
}

function newOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    googleRedirectUri()
  );
}

export function authUrl(): string {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force un refresh_token à chaque connexion
    scope: SCOPES,
  });
}

export async function handleOAuthCallback(code: string): Promise<string> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  const email = data.email;
  if (!email) throw new Error("Impossible de récupérer l'adresse email du compte Google");

  const existing = db.prepare("SELECT id, oauth_tokens FROM accounts WHERE email = ?").get(email) as
    | { id: number; oauth_tokens: string }
    | undefined;
  if (existing) {
    // Conserve l'ancien refresh_token si Google n'en renvoie pas de nouveau
    const old = JSON.parse(existing.oauth_tokens) as Credentials;
    const merged = { ...old, ...tokens, refresh_token: tokens.refresh_token ?? old.refresh_token };
    db.prepare("UPDATE accounts SET oauth_tokens = ?, active = 1 WHERE id = ?").run(
      JSON.stringify(merged),
      existing.id
    );
  } else {
    db.prepare("INSERT INTO accounts (email, oauth_tokens, daily_limit) VALUES (?, ?, ?)").run(
      email,
      JSON.stringify(tokens),
      config.deliverability.defaultDailyLimit
    );
  }
  return email;
}

export function clientForAccount(account: AccountRow): OAuth2Client {
  const client = newOAuthClient();
  client.setCredentials(JSON.parse(account.oauth_tokens) as Credentials);
  // Persiste les tokens rafraîchis automatiquement par googleapis
  client.on("tokens", (tokens) => {
    const current = JSON.parse(
      (db.prepare("SELECT oauth_tokens FROM accounts WHERE id = ?").get(account.id) as AccountRow)
        .oauth_tokens
    ) as Credentials;
    const merged = { ...current, ...tokens, refresh_token: tokens.refresh_token ?? current.refresh_token };
    db.prepare("UPDATE accounts SET oauth_tokens = ? WHERE id = ?").run(
      JSON.stringify(merged),
      account.id
    );
  });
  return client;
}

function encodeHeader(value: string): string {
  // RFC 2047 pour les sujets accentués
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface SendResult {
  gmailMessageId: string;
  threadId: string;
  rfc822MessageId: string;
}

export async function sendEmail(
  account: AccountRow,
  opts: {
    to: string;
    subject: string;
    body: string;
    threadId?: string | null;
    inReplyTo?: string | null; // Message-ID RFC822 du message précédent
  }
): Promise<SendResult> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const rfc822MessageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${account.email.split("@")[1]}>`;

  const from = account.from_name
    ? `${encodeHeader(account.from_name)} <${account.email}>`
    : account.email;
  const headers = [
    `From: ${from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `Message-ID: ${rfc822MessageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  const raw = Buffer.from(
    headers.join("\r\n") + "\r\n\r\n" + Buffer.from(opts.body, "utf8").toString("base64"),
    "utf8"
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: opts.threadId ?? undefined },
  });
  return {
    gmailMessageId: data.id ?? "",
    threadId: data.threadId ?? "",
    rfc822MessageId,
  };
}

/** Vérifie si quelqu'un d'autre que le compte a écrit dans le fil. */
export async function threadHasReply(account: AccountRow, threadId: string): Promise<boolean> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const { data } = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From"],
  });
  for (const msg of data.messages ?? []) {
    const from = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
    if (from && !from.toLowerCase().includes(account.email.toLowerCase())) {
      return true;
    }
  }
  return false;
}
