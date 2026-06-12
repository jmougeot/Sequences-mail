/**
 * Compare des stratégies de nom d'entreprise dans la requête LinkedIn :
 * phrase exacte complète vs raccourcie vs mots non quotés. Compte les résultats
 * bruts (pas de filtre de poste) pour isoler l'effet du nom. ~6 crédits Serper.
 * Usage : npx tsx scripts/test-name-strategies.ts
 */
import { apiSearch } from "../src/services/b2b/search.js";

const CASES = [
  { label: "phrase exacte légale", q: 'site:fr.linkedin.com/in "ZAYO INFRASTRUCTURE FRANCE"' },
  { label: "phrase raccourcie", q: 'site:fr.linkedin.com/in "ZAYO"' },
  { label: "mots non quotés", q: "site:fr.linkedin.com/in ZAYO INFRASTRUCTURE" },
  { label: "phrase exacte légale", q: 'site:fr.linkedin.com/in "ALTITUDE INFRASTRUCTURE THD"' },
  { label: "phrase raccourcie", q: 'site:fr.linkedin.com/in "ALTITUDE INFRASTRUCTURE"' },
  { label: "mots non quotés", q: "site:fr.linkedin.com/in ALTITUDE INFRASTRUCTURE THD" },
];

for (const c of CASES) {
  const results = await apiSearch(c.q, 0);
  const sample = (results ?? [])
    .slice(0, 2)
    .map((r) => r.title.split(/[-|–]/)[0].trim())
    .join(" ; ");
  console.log(`${String(results?.length ?? "API?").padStart(4)} résultats  [${c.label}]  ${c.q}${sample ? `\n      ex: ${sample}` : ""}`);
}
process.exit(0);
