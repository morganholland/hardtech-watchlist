// One-off enrichment for the company detail modal.
//
// The seeded companies predate the `description` / `whyListed` / `website`
// fields, so their modals render empty. This fills those three fields in for
// any company missing them. Existing values are never overwritten, so it is
// safe to re-run — it only ever touches companies that are still missing data.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/backfill.mjs [--limit N] [--dry-run]
//
// --limit N   only process the first N companies needing work (default: all)
// --dry-run   print what would change; write nothing

import { readFileSync, writeFileSync } from "node:fs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
if (!(LIMIT > 0)) { console.error("--limit must be a positive number"); process.exit(1); }

const BATCH_SIZE = 10;   // keeps each response comfortably inside max_tokens
const FIELDS = ["description", "whyListed", "website"];

const needsWork = (c) => FIELDS.some((f) => !c[f]);

async function enrich(batch) {
  const prompt = `You maintain a hard-tech startup investing watchlist covering six themes: space, nuclear, defense, energy, semis (incl. AI chips and data center), and robotics.

For each company below, write the three missing detail fields. These are real companies — use what you actually know about them.

${JSON.stringify(batch.map((c) => ({ name: c.name, theme: c.theme, stage: c.stage, oneLiner: c.oneLiner, investors: c.investors })), null, 1)}

Return ONLY a JSON array, no prose, no markdown fences, one object per company, in the same order:
{"name":"<exactly the name given>","description":"2-3 sentences: what they build, how it works, where they are today","whyListed":"1-2 sentences: why this belongs on a hard-tech investing watchlist — the investment thesis, not a restatement of what they do","website":"company homepage URL"}

Rules:
- "name" must match the input name exactly so results can be matched up.
- "website" must be an absolute URL starting with https:// (or http://) — a bare domain like "example.com" is dropped by the site.
- Omit "website" entirely if you are not confident of the real homepage. Never guess or construct a URL.
- If you genuinely don't know a company, return it with empty strings rather than inventing details.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    throw new Error("backfill returned unparseable output:\n" + text.slice(0, 500));
  }
}

async function main() {
  const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const pending = db.companies.filter(needsWork).slice(0, LIMIT);

  console.log(`${db.companies.length} companies, ${db.companies.filter(needsWork).length} need enrichment` +
              (LIMIT === Infinity ? "" : ` (processing ${pending.length})`));
  if (!pending.length) { console.log("nothing to do"); return; }

  let filled = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    console.log(`batch ${i / BATCH_SIZE + 1}: ${batch.map((c) => c.name).join(", ")}`);

    for (const r of await enrich(batch)) {
      // Match on the returned name; skip anything that doesn't line up rather
      // than trusting positional order.
      const target = batch.find((c) => c.name === r?.name);
      if (!target) { console.warn(`  ! no match for "${r?.name}" — skipped`); continue; }
      for (const f of FIELDS) if (!target[f] && r[f]) { target[f] = r[f]; filled++; }
    }
  }

  console.log(`filled ${filled} fields across ${pending.length} companies`);
  if (DRY_RUN) { console.log("--dry-run: not writing"); return; }

  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");
  console.log(`wrote ${DATA_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
