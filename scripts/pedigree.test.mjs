// Acceptance checks for the pedigree screen (§9). Run with:
//   node scripts/pedigree.test.mjs
// Also run in the Action so a data or scoring regression fails the build.

import { readFileSync } from "node:fs";
import { scorePedigree, stintRawScore, tierForScore, TIER_ORDER } from "./pedigree.mjs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const registry = db.sourceCompanies ?? {};

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const co = (name) => db.companies.find((c) => c.name === name);
const ped = (name) => co(name)?.pedigree;

console.log("scoring model:");
{
  // Waymo alum, identical stint, autonomy company vs legal-tech company:
  // the fit score must separate them by at least 8 points.
  const stint = {
    source: "waymo", ownership: "program-owner", years: 5,
    confidence: "verified", evidence: [{ url: "https://example.com", retrievedAt: "2026-08-07" }],
  };
  const autonomy = stintRawScore({ ...stint }, "robotics", registry);
  const legaltech = stintRawScore({ ...stint }, "legaltech", registry);
  check("Waymo alum in autonomy scores ≥8 above the same alum in legal tech",
    autonomy - legaltech >= 8, `autonomy=${autonomy} legaltech=${legaltech}`);
}
{
  // Confidence can only discount, never boost.
  const base = { source: "spacex", ownership: "functional-head", years: 6, evidence: [{ url: "https://example.com", retrievedAt: "2026-08-07" }] };
  const v = scorePedigree({ founders: [{ ...base, name: "A", confidence: "verified" }] }, "space", registry).score;
  const s = scorePedigree({ founders: [{ ...base, name: "A", confidence: "single-source" }] }, "space", registry).score;
  const u = scorePedigree({ founders: [{ ...base, name: "A", confidence: "unverified" }] }, "space", registry).score;
  check("single-source discounts, unverified nulls", s < v && u === null, `v=${v} s=${s} u=${u}`);
  // No unsourced claims: evidence-less founders never score, whatever the confidence says.
  const noEv = scorePedigree({ founders: [{ ...base, evidence: [], name: "A", confidence: "verified" }] }, "space", registry).score;
  check("a founder without retrieved evidence cannot have a score", noEv === null);
  check("tenure caps at 15 years", stintRawScore({ ...base, name: "A", confidence: "verified", years: 40 }, "space", registry) <= 100);
}

console.log("seed data:");
check("Impulse Space scores exceptional", ped("Impulse Space")?.tier === "exceptional", `got ${ped("Impulse Space")?.tier}`);
check("Heron Power scores exceptional", ped("Heron Power")?.tier === "exceptional", `got ${ped("Heron Power")?.tier}`);
check("Rebellions scores weak (logo without tenure)", ped("Rebellions")?.tier === "weak", `got ${ped("Rebellions")?.tier}`);
check("Harbinger scores weak (thin record)", ped("Harbinger")?.tier === "weak", `got ${ped("Harbinger")?.tier}`);
check("TerraFirma is unscreened", ped("TerraFirma")?.tier === "unscreened" && ped("TerraFirma")?.score === null);
check("TerraFirma carries founder-detail-unverified", (ped("TerraFirma")?.flags ?? []).includes("founder-detail-unverified"));

{
  const bp = ped("Base Power");
  check("Base Power carries two source companies", bp?.sourceCompanies?.length === 2, JSON.stringify(bp?.sourceCompanies));
  const scores = (bp?.founders ?? []).map((f) => f.score).filter((s) => s != null);
  check("Base Power scores off the stronger stint without double-counting",
    bp?.score === Math.round(Math.max(...scores)), `company=${bp?.score} stints=${scores.join(",")}`);
}
{
  // Descending pedigree sort puts Impulse Space and Heron Power at the top,
  // and null scores last.
  const sorted = [...db.companies].sort((a, b) => (b.pedigree?.score ?? -1) - (a.pedigree?.score ?? -1));
  const top = sorted.slice(0, 2).map((c) => c.name).sort();
  check("Impulse Space and Heron Power lead a descending pedigree sort",
    top.join(" + ") === "Heron Power + Impulse Space", top.join(", "));
  const firstNull = sorted.findIndex((c) => (c.pedigree?.score ?? null) === null);
  const lastScored = sorted.map((c) => c.pedigree?.score ?? null).lastIndexOf(null) >= firstNull;
  check("null scores sort last", sorted.slice(firstNull).every((c) => (c.pedigree?.score ?? null) === null));
}
{
  const scored = db.companies.filter((c) => c.pedigree?.score != null);
  check("every scored company's founders carry retrieved evidence",
    scored.every((c) => c.pedigree.founders.some((f) => f.score != null && f.evidence?.every((e) => e.retrievedAt))));
  check("tier bands reproduce from scores",
    scored.every((c) => c.pedigree.tier === tierForScore(c.pedigree.score)));
  check("tier order covers all stored tiers",
    db.companies.every((c) => !c.pedigree || c.pedigree.tier in TIER_ORDER));
}

if (failures) { console.error(`\n${failures} acceptance check(s) failed`); process.exit(1); }
console.log("\nall acceptance checks passed");
