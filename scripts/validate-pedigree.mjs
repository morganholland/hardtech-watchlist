// Guardrail check for the founder-pedigree data (§7 of the screen spec).
// Run in the Action after refresh + enrichment; a violation fails the build.
//
//   node scripts/validate-pedigree.mjs
//
// Enforced:
//   - no scored founder without at least one retrieved evidence URL
//   - every evidence URL is absolute http(s) and carries a retrievedAt stamp
//   - no LinkedIn evidence (LinkedIn is never scraped; those go to the queue)
//   - unverified founders have null scores; confidence only ever discounts
//   - stored scores and tiers reproduce exactly from the stored fields
//   - mechanically-derived flags (unverified / estimated / short tenure /
//     unknown source company) are present on the record

import { readFileSync } from "node:fs";
import { validatePedigree } from "./pedigree.mjs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));

const errors = validatePedigree(db);
const screened = db.companies.filter((c) => c.pedigree).length;

if (errors.length) {
  console.error(`${errors.length} pedigree guardrail violation(s) across ${screened} screened companies:`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`pedigree guardrails OK (${screened} screened companies)`);
