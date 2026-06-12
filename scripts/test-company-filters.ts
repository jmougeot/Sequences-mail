/**
 * Vérification des filtres entreprise (taille/secteur/CA) :
 *  1. logique pure : companyPasses / hasCompanyFilters sur des cas limites ;
 *  2. live : enrichCompanyByName sur des noms réalistes (tels qu'affichés sur
 *     LinkedIn) — taux de résolution et cohérence des attributs renvoyés.
 * Usage : npx tsx scripts/test-company-filters.ts
 */
import {
  companyPasses,
  enrichCompanyByName,
  hasCompanyFilters,
  EFFECTIF_LABELS,
  SECTION_LABELS,
  type CompanyInfo,
} from "../src/services/b2b/company.js";

let fails = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` — attendu ${expected}, obtenu ${actual}`}`);
}

// --- 1. Logique pure -----------------------------------------------------------

const pme: CompanyInfo = { siren: "123", effectif: "12", naf_section: "J", ca: 2_000_000 };
const grosse: CompanyInfo = { siren: "456", effectif: "52", naf_section: "C", ca: 900_000_000 };
const sansInfo: CompanyInfo = { siren: "789", effectif: null, naf_section: null, ca: null };

check("aucun filtre → tout passe", companyPasses(pme, {}), true);
check("aucun filtre → hasCompanyFilters false", hasCompanyFilters({}), false);
check("sets vides ≠ filtre actif", hasCompanyFilters({ effectifs: new Set(), sections: new Set() }), false);
check("caMin=0 ≠ filtre actif", hasCompanyFilters({ caMin: 0 }), false);
check("filtre effectifs présent détecté", hasCompanyFilters({ effectifs: new Set(["12"]) }), true);

check("effectif 20-49 accepté quand demandé", companyPasses(pme, { effectifs: new Set(["12"]) }), true);
check("effectif 5000-9999 refusé quand on veut 20-49", companyPasses(grosse, { effectifs: new Set(["12"]) }), false);
check("section J acceptée", companyPasses(pme, { sections: new Set(["J"]) }), true);
check("section C refusée quand on veut J", companyPasses(grosse, { sections: new Set(["J"]) }), false);
check("CA 2M ≥ caMin 1M", companyPasses(pme, { caMin: 1_000_000 }), true);
check("CA 2M < caMin 10M refusé", companyPasses(pme, { caMin: 10_000_000 }), false);
check("filtres combinés tous satisfaits", companyPasses(pme, { effectifs: new Set(["12"]), sections: new Set(["J"]), caMin: 1_000_000 }), true);
check("filtres combinés : un seul échoue → refus", companyPasses(pme, { effectifs: new Set(["12"]), sections: new Set(["C"]) }), false);

check("entreprise non résolue (null) refusée si filtre actif", companyPasses(null, { effectifs: new Set(["12"]) }), false);
check("effectif inconnu refusé si filtre taille", companyPasses(sansInfo, { effectifs: new Set(["12"]) }), false);
check("CA inconnu refusé si filtre CA", companyPasses(sansInfo, { caMin: 1 }), false);
check("effectif NN (non renseigné) refusé sauf si NN demandé", companyPasses({ ...pme, effectif: "NN" }, { effectifs: new Set(["12"]) }), false);

// --- 2. Live : résolution registre sur des noms « façon LinkedIn » -------------

const SAMPLES: Array<{ name: string; expect?: Partial<CompanyInfo> }> = [
  // grands comptes — attributs connus pour vérifier la cohérence ; attention,
  // le registre décrit l'unité légale : pour Capgemini seule la holding existe
  // (M, sièges sociaux) ; pour Decathlon le score retient l'entité opérante
  // DECATHLON FRANCE (G, commerce) plutôt que la holding immobilière
  { name: "Doctolib", expect: { naf_section: "J" } },
  { name: "Decathlon", expect: { naf_section: "G" } },
  { name: "BlaBlaCar", expect: { naf_section: "J" } },
  { name: "Sanofi", expect: { naf_section: "M" } },
  { name: "Capgemini", expect: { naf_section: "M" } },
  // variantes telles qu'affichées sur LinkedIn (suffixes, formes juridiques)
  { name: "Doctolib SAS" },
  { name: "Decathlon France" },
  { name: "Alan (alan.com)" },
  { name: "PayFit 🚀" },
  // nom commercial ≠ raison sociale : doit retrouver JUNG S.A.S (BACK MARKET),
  // l'entité française avec effectif renseigné, pas BACK MARKET GERMANY GMBH
  { name: "Back Market", expect: { siren: "804049476" } },
  // PME / noms ambigus / introuvables attendus
  { name: "Qonto" },
  { name: "Swile" },
  { name: "Une Entreprise Qui N'Existe Vraiment Pas 1234" },
];

const fmt = (i: CompanyInfo | null) =>
  i
    ? `siren=${i.siren} effectif=${i.effectif ?? "?"} (${i.effectif ? EFFECTIF_LABELS[i.effectif] ?? "?" : "?"}) section=${i.naf_section ?? "?"} (${i.naf_section ? SECTION_LABELS[i.naf_section] ?? "?" : "?"}) ca=${i.ca ?? "?"}`
    : "introuvable";

console.log("\n--- Live : enrichCompanyByName (API recherche-entreprises) ---");
let resolved = 0;
for (const s of SAMPLES) {
  const t0 = Date.now();
  const info = await enrichCompanyByName(s.name);
  const ms = Date.now() - t0;
  if (info) resolved++;
  let verdict = "";
  if (s.expect && info) {
    for (const [k, v] of Object.entries(s.expect)) {
      const got = info[k as keyof CompanyInfo];
      verdict += got === v ? ` [${k} ✓]` : ` [${k} ✗ attendu ${v}, obtenu ${got}]`;
      if (got !== v) fails++;
    }
  }
  console.log(`${String(ms).padStart(5)}ms  ${s.name.padEnd(45)} ${fmt(info)}${verdict}`);
}
console.log(`\nRésolution : ${resolved}/${SAMPLES.length} (le dernier nom est volontairement introuvable)`);

// cache : un 2e appel doit être instantané
const t0 = Date.now();
await enrichCompanyByName("Doctolib");
const cacheMs = Date.now() - t0;
check(`cache : 2e appel instantané (${cacheMs}ms)`, cacheMs < 20, true);

console.log(fails ? `\n${fails} échec(s)` : "\nTous les contrôles passent");
process.exit(fails ? 1 : 0);
