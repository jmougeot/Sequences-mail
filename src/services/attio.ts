import { config } from "../config.js";
import { importContacts, type ImportReport } from "./contacts.js";

const ATTIO_API = "https://api.attio.com/v2";

interface AttioPerson {
  id: { record_id: string };
  values: Record<string, Array<Record<string, unknown>>>;
}

function firstValue(person: AttioPerson, attr: string): Record<string, unknown> | undefined {
  return person.values[attr]?.[0];
}

/**
 * Importe depuis Attio les personnes dont l'attribut `statusAttribute`
 * (slug, ex: "stage" ou un attribut select personnalisé) vaut l'un des `statuses`.
 */
export async function syncFromAttio(
  campaignId: number,
  statusAttribute: string,
  statuses: string[]
): Promise<ImportReport & { fetched: number }> {
  if (!config.attioApiKey) {
    throw new Error("ATTIO_API_KEY manquant dans .env");
  }

  const rows: Array<Record<string, string>> = [];
  const attioIds: Record<string, string> = {};
  let offset = 0;
  const limit = 500;

  for (;;) {
    const res = await fetch(`${ATTIO_API}/objects/people/records/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.attioApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { [statusAttribute]: { $in: statuses } },
        limit,
        offset,
      }),
    });
    if (!res.ok) {
      throw new Error(`Attio API ${res.status} : ${await res.text()}`);
    }
    const { data } = (await res.json()) as { data: AttioPerson[] };

    for (const person of data) {
      const emailVal = firstValue(person, "email_addresses");
      const email = (emailVal?.email_address as string | undefined)?.toLowerCase();
      if (!email) continue;
      const nameVal = firstValue(person, "name");
      rows.push({
        email,
        first_name: (nameVal?.first_name as string) ?? "",
        last_name: (nameVal?.last_name as string) ?? "",
        company: "",
      });
      attioIds[email] = person.id.record_id;
    }

    if (data.length < limit) break;
    offset += limit;
  }

  const report = importContacts(campaignId, rows, { attioRecordIds: attioIds });
  return { ...report, fetched: rows.length };
}
