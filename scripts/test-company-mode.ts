/**
 * Test du mode « ciblage par entreprises » :
 *  1. énumération du registre avec filtres (taille 50-249, secteur J) ;
 *  2. construction des requêtes LinkedIn ciblées (nettoyage des noms) ;
 *  3. 3 vraies requêtes Serper pour mesurer le rendement (3 crédits, en cache).
 * Usage : npx tsx scripts/test-company-mode.ts
 */
import { listCompanies } from "../src/services/b2b/company.js";
import { companyQuery, fetchProspectsPage, allRoleTerms } from "../src/services/b2b/linkedin.js";

const filters = { effectifs: new Set(["21", "22", "31"]), sections: new Set(["J"]) };
const params = { roles: ["sdr"], franceOnly: true };

console.log("--- 1. Énumération du registre (50-249 salariés, secteur J) ---");
const t0 = Date.now();
const { companies, nextPage } = await listCompanies(filters, 50, 1);
console.log(`${companies.length} entreprises en ${Date.now() - t0}ms — page registre suivante : ${nextPage}`);
for (const c of companies.slice(0, 8)) {
  console.log(`  ${c.name.padEnd(40)} effectif=${c.info.effectif} section=${c.info.naf_section}`);
}

console.log("\n--- 2. Requêtes ciblées ---");
for (const c of companies.slice(0, 3)) console.log(" ", companyQuery(params, c.name));

console.log("\n--- 3. Rendement réel (3 requêtes Serper) ---");
const terms = allRoleTerms(params.roles);
let total = 0;
for (const c of companies.slice(0, 3)) {
  const page = await fetchProspectsPage(companyQuery(params, c.name), 0, terms);
  const n = page?.prospects.length ?? 0;
  total += n;
  console.log(`  ${c.name.padEnd(40)} ${page ? `${n} prospect(s) / ${page.raw} résultats bruts` : "API indisponible"}`);
  for (const p of (page?.prospects ?? []).slice(0, 2)) {
    console.log(`     · ${p.first_name} ${p.last_name} — ${p.role} @ ${p.company ?? "?"}`);
  }
}
console.log(`\nTotal : ${total} prospect(s) sur 3 entreprises (recherche générique : ~0-2 nouveaux par requête à ce stade)`);
process.exit(0);
