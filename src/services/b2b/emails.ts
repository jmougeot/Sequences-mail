/**
 * Construction et vérification d'emails professionnels :
 * - génération de candidats à partir de prénom/nom + domaine (patterns français usuels) ;
 * - détection du pattern réel via les emails trouvés sur le site ;
 * - vérification SMTP (RCPT TO) quand le port 25 est joignable, avec détection
 *   de catch-all. Sinon, repli sur le meilleur candidat marqué « probable ».
 */
import { resolveMx } from "node:dns/promises";
import net from "node:net";
import { deaccent } from "./domain.js";

export type Pattern = "prenom.nom" | "prenomnom" | "pnom" | "prenom" | "nom" | "nom.prenom" | "p.nom";

const PATTERNS: Pattern[] = ["prenom.nom", "pnom", "prenom", "prenomnom", "p.nom", "nom", "nom.prenom"];

/** Partie locale d'email à partir d'un prénom/nom (sans accents, minuscules). */
function localPart(s: string): string {
  return deaccent(s.toLowerCase()).replace(/[^a-z0-9-]+/g, "");
}

export function applyPattern(pattern: Pattern, first: string, last: string): string {
  const f = localPart(first);
  const l = localPart(last);
  switch (pattern) {
    case "prenom.nom": return `${f}.${l}`;
    case "prenomnom": return `${f}${l}`;
    case "pnom": return `${f[0] ?? ""}${l}`;
    case "p.nom": return `${f[0] ?? ""}.${l}`;
    case "prenom": return f;
    case "nom": return l;
    case "nom.prenom": return `${l}.${f}`;
  }
}

/** Emails génériques (boîtes de service) vs nominatifs. */
export function isGenericEmail(email: string): boolean {
  const local = email.split("@")[0];
  return /^(contact|info|infos|hello|bonjour|accueil|commercial|ventes?|sales|support|sav|rh|recrutement|jobs?|admin|administration|compta|comptabilite|facturation|billing|direction|secretariat|communication|marketing|presse|webmaster|postmaster|no-?reply|service|boutique|agence|cabinet|contact-?fr)$/i.test(local);
}

/**
 * Déduit le pattern d'adressage à partir des emails nominatifs trouvés sur le
 * site, en les confrontant aux dirigeants connus puis à des heuristiques.
 */
export function inferPattern(
  siteEmails: string[],
  people: Array<{ first_name: string; last_name: string }>
): Pattern | null {
  const personal = siteEmails.filter((e) => !isGenericEmail(e));
  for (const email of personal) {
    const local = email.split("@")[0];
    for (const p of people) {
      for (const pattern of PATTERNS) {
        if (applyPattern(pattern, p.first_name, p.last_name) === local) return pattern;
      }
    }
  }
  // heuristique : a.b@ → prenom.nom (le plus répandu en France)
  for (const email of personal) {
    const local = email.split("@")[0];
    const m = /^([a-z][a-z-]+)\.([a-z][a-z-]+)$/.exec(local);
    if (m) return m[1].length === 1 ? "p.nom" : "prenom.nom";
    if (/^[a-z]\.?[a-z]{3,}$/.test(local) && local.length <= 12) return "pnom";
  }
  return null;
}

// --- Vérification SMTP -------------------------------------------------------

export interface SmtpProbe {
  reachable: boolean; // port 25 du MX joignable et dialogue possible
  catchAll: boolean; // le serveur accepte n'importe quelle adresse
  accepts: (email: string) => Promise<"ok" | "no" | "unknown">;
  close: () => void;
}

const SMTP_TIMEOUT = 8000;

/** Dialogue SMTP minimal sur une socket : envoie une commande, lit la réponse complète. */
function smtpCommand(socket: net.Socket, cmd: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout SMTP"));
    }, SMTP_TIMEOUT);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // réponse terminée : dernière ligne "XXX " (et pas "XXX-" multi-ligne)
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3}([ ]|$)/.test(last)) {
        cleanup();
        resolve(parseInt(last.slice(0, 3), 10));
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
    if (cmd !== null) socket.write(cmd + "\r\n");
  });
}

/**
 * Ouvre une session SMTP vers le MX du domaine et prépare la vérification
 * d'adresses (MAIL FROM:<> puis RCPT TO par adresse). Détecte le catch-all
 * avec une adresse aléatoire.
 */
export async function probeSmtp(domain: string, heloDomain: string): Promise<SmtpProbe> {
  const noProbe: SmtpProbe = { reachable: false, catchAll: false, accepts: async () => "unknown", close: () => {} };
  let mxHost: string;
  try {
    const mx = await resolveMx(domain);
    if (!mx.length) return noProbe;
    mxHost = mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch {
    return noProbe;
  }

  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: mxHost, port: 25, timeout: 6000 });
      s.once("connect", () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.once("timeout", () => {
        s.destroy();
        reject(new Error("timeout de connexion"));
      });
      s.once("error", reject);
    });
    const greeting = await smtpCommand(socket, null); // bannière 220
    if (greeting !== 220) throw new Error(`bannière ${greeting}`);
    const ehlo = await smtpCommand(socket, `EHLO ${heloDomain}`);
    if (ehlo !== 250) throw new Error(`EHLO ${ehlo}`);
    let mailFrom = await smtpCommand(socket, "MAIL FROM:<>");
    if (mailFrom !== 250) {
      // certains serveurs refusent l'expéditeur nul
      mailFrom = await smtpCommand(socket, `MAIL FROM:<postmaster@${heloDomain}>`);
      if (mailFrom !== 250) throw new Error(`MAIL FROM ${mailFrom}`);
    }
  } catch {
    return noProbe;
  }

  const rcpt = async (email: string): Promise<"ok" | "no" | "unknown"> => {
    try {
      const code = await smtpCommand(socket, `RCPT TO:<${email}>`);
      if (code === 250 || code === 251) return "ok";
      if (code >= 500) return "no";
      return "unknown"; // 4xx : greylisting, on ne conclut pas
    } catch {
      return "unknown";
    }
  };

  const random = `zx${Math.random().toString(36).slice(2, 10)}@${domain}`;
  const catchAll = (await rcpt(random)) === "ok";

  return {
    reachable: true,
    catchAll,
    accepts: rcpt,
    close: () => {
      try {
        socket.write("QUIT\r\n");
        socket.end();
      } catch {
        /* déjà fermée */
      }
    },
  };
}

export interface ResolvedEmail {
  email: string | null;
  status: "verified" | "pattern" | "probable" | "not_found";
}

/**
 * Choisit le meilleur email pour une personne : pattern détecté sur le site en
 * priorité, sinon candidats usuels ; vérifié par SMTP quand c'est possible.
 */
export async function resolveEmail(
  first: string,
  last: string,
  domain: string,
  sitePattern: Pattern | null,
  probe: SmtpProbe
): Promise<ResolvedEmail> {
  const ordered: Pattern[] = sitePattern
    ? [sitePattern, ...PATTERNS.filter((p) => p !== sitePattern)]
    : [...PATTERNS];
  const candidates = [...new Set(ordered.map((p) => `${applyPattern(p, first, last)}@${domain}`))].filter(
    (e) => !e.startsWith("@") && !e.startsWith(".")
  );
  if (!candidates.length) return { email: null, status: "not_found" };

  if (probe.reachable && !probe.catchAll) {
    for (const email of candidates) {
      const r = await probe.accepts(email);
      if (r === "ok") return { email, status: "verified" };
      if (r === "unknown") break; // greylisting : inutile d'insister
    }
    // SMTP a répondu « non » à tous les candidats
    if (sitePattern) return { email: candidates[0], status: "pattern" };
    return { email: null, status: "not_found" };
  }

  // SMTP injoignable ou catch-all : on garde le meilleur candidat
  return { email: candidates[0], status: sitePattern ? "pattern" : "probable" };
}
