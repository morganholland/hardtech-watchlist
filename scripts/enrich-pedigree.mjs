// Founder-pedigree enrichment stage — runs in the refresh Action after
// refresh.mjs. Node 20+, zero npm dependencies.
//
// For companies with no pedigree yet (or one stale >180 days), gathers source
// documents in cost order (§5): Moonfire's Spawners Explorer pages, the
// company's own site (/, /about, /team — highest confidence for titles and
// tenure), then the stored funding-announcement sourceUrl. Claude extracts
// founder facts FROM THOSE DOCUMENTS ONLY, citing each claim by document
// index — so every evidence URL is by construction one this run fetched with
// a 200. The score is computed here, deterministically, never by the model.
//
// LinkedIn is never fetched. A founder whose only trace is a LinkedIn profile
// or an unnamed "ex-SpaceX engineers" mention stays unverified (null score)
// and lands in the site's verification queue for a ten-second manual check.
//
// Cadence: the Action's normal schedule, plus a deeper sweep (higher --limit)
// in the 4-8 weeks after SpaceX's May 15 / Nov 15 vesting dates, when
// departures cluster (inVestingSweepWindow).
//
//   ANTHROPIC_API_KEY=sk-... node scripts/enrich-pedigree.mjs [--limit N] [--dry-run]

import { readFileSync, writeFileSync } from "node:fs";
import {
  scorePedigree, deriveFlags, validatePedigree, normName,
  inVestingSweepWindow, TIER_ORDER, OWNERSHIP_SCORES,
} from "./pedigree.mjs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const SWEEP = inVestingSweepWindow();
const LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : (SWEEP ? 16 : 6);
if (!(LIMIT > 0)) { console.error("--limit must be a positive number"); process.exit(1); }

const STALE_DAYS = 180;
const TODAY = new Date().toISOString().slice(0, 10);
const MAX_DOC_CHARS = 6000;

async function fetchDoc(url) {
  if (!/^https?:\/\//.test(url ?? "")) return null;
  if (/(^|\.)linkedin\.com/.test(hostOf(url))) return null;   // never scrape LinkedIn
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "hardtech-watchlist/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (res.status !== 200) return null;
    const text = (await res.text())
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_DOC_CHARS);
    return { url, retrievedAt: TODAY, publisher: hostOf(url), text };
  } catch {
    return null;
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

function isStale(pedigree) {
  if (!pedigree?.lastVerified) return true;
  return (Date.now() - new Date(pedigree.lastVerified).getTime()) / 86400e3 > STALE_DAYS;
}

async function extract(company, docs, registryKeys) {
  const prompt = `You extract founder-background facts for a hard-tech watchlist's pedigree screen. The screen asks whether a founder had meaningful tenure AND real ownership at one of these source companies: ${registryKeys.join(", ")}.

Company: ${company.name} — ${company.oneLiner || company.description || ""} (theme: ${company.theme}, stage: ${company.stage})

Numbered source documents fetched this run (the ONLY permissible evidence):
${docs.map((d, i) => `[${i}] ${d.url}\n${d.text}`).join("\n\n")}

Return ONLY a JSON array of founder records, no prose, no markdown fences:
{"name":"Full Name","roleAtCompany":"e.g. Co-founder & CEO","source":"<registry key above>","title":"their title at the source company, verbatim as the document states it","ownership":"cofounder-exec|program-owner|functional-head|senior-ic|ic|unknown","years":<number or null>,"yearsPrecision":"reported|derived|estimated|unknown","note":"optional context, e.g. approximate source-company headcount during tenure if a document states it","confidence":"verified|single-source","evidence":[{"claim":"one specific claim","doc":<document index>}]}

Ownership rubric: cofounder-exec = co-founder / C-level / SVP of the source company. program-owner = ran a named program end-to-end (e.g. "manager of Falcon 9 integration and test", "head of manufacturing"). functional-head = director or head of a discipline or region. senior-ic = staff/senior engineer, no org ownership. ic = everything else. unknown = the documents don't say.

Hard rules:
- Every claim MUST come from the numbered documents. Cite the document index. If the documents don't state a founder's title or tenure, do not guess from their current role or the company's sector — omit the field or return nothing for that founder.
- "verified" only when two independent documents agree, or one document is the company's own page. Otherwise "single-source".
- If a document only says something like "founded by former SpaceX engineers" with no names, return [] rather than inventing founders.
- years: only if a document states or implies a duration; set yearsPrecision accordingly ("estimated" when inferred from a range).
- Only use source keys from the list above. Skip founders whose prior employer is not on the list.
If nothing can be extracted, return [].`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    throw new Error(`pedigree extractor returned unparseable output for ${company.name}:\n` + text.slice(0, 500));
  }
}

async function main() {
  const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const registry = db.sourceCompanies ?? {};
  const registryKeys = Object.keys(registry);
  if (!registryKeys.length) { console.log("no sourceCompanies registry — run scripts/seed-pedigree.mjs first"); return; }

  // Unscreened companies first (earliest-stage data pays off most), then the
  // stalest screened ones for re-verification.
  const queue = db.companies
    .filter((c) => !c.pedigree || isStale(c.pedigree))
    .sort((a, b) => (a.pedigree ? 1 : 0) - (b.pedigree ? 1 : 0))
    .slice(0, LIMIT);
  console.log(`${queue.length} companies to enrich (limit ${LIMIT}${SWEEP ? ", post-vesting deep sweep window" : ""})`);
  if (!queue.length) return;

  // Cheapest, most reliable source first: Moonfire's Spawners Explorer pages,
  // fetched once per run and shared across companies.
  const moonfire = [];
  for (const key of registryKeys) {
    const doc = await fetchDoc(`https://www.moonfire.com/spawners/${key}`);
    if (doc) moonfire.push(doc);
  }
  console.log(`${moonfire.length} Moonfire spawner pages retrieved`);

  const upgrades = [];
  for (const company of queue) {
    const site = (company.website || "").replace(/\/+$/, "");
    const candidates = [
      ...(site ? [site, `${site}/about`, `${site}/team`] : []),
      company.sourceUrl,
    ].filter(Boolean);
    const docs = [...moonfire];
    for (const url of candidates) {
      const doc = await fetchDoc(url);
      if (doc) docs.push(doc);
    }
    if (!docs.length) { console.log(`  - ${company.name}: no retrievable sources, skipping`); continue; }

    const prevTier = company.pedigree?.tier ?? "unscreened";
    const results = await extract(company, docs, registryKeys);

    const founders = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (!r?.name || !registry[r.source]) continue;
      // Claims cite fetched documents by index; anything else is dropped, so a
      // fabricated URL cannot enter the data.
      const evidence = (r.evidence ?? [])
        .filter((e) => Number.isInteger(e?.doc) && docs[e.doc])
        .map((e) => ({ claim: String(e.claim ?? ""), url: docs[e.doc].url, publisher: docs[e.doc].publisher, retrievedAt: TODAY }));
      // "verified" requires two independent documents or the company's own
      // page; the model's claim of confidence is downgraded if the evidence
      // that survived filtering no longer supports it.
      const primary = site && evidence.some((e) => e.url.startsWith(site));
      const distinctUrls = new Set(evidence.map((e) => e.url)).size;
      founders.push({
        name: r.name, roleAtCompany: r.roleAtCompany ?? "", source: r.source,
        title: r.title ?? null,
        ownership: r.ownership in OWNERSHIP_SCORES ? r.ownership : "unknown",
        years: typeof r.years === "number" ? r.years : null,
        yearsPrecision: r.yearsPrecision ?? "unknown",
        ...(r.note ? { note: r.note } : {}),
        confidence: evidence.length === 0 ? "unverified"
          : r.confidence === "verified" && (distinctUrls >= 2 || primary) ? "verified"
          : "single-source",
        evidence,
      });
    }

    // Preserve manually curated founders on stale re-verification rather than
    // letting a thinner automated pass overwrite them.
    if (!founders.length && company.pedigree) {
      company.pedigree.lastVerified = TODAY;
      console.log(`  = ${company.name}: nothing new, re-stamped lastVerified`);
      continue;
    }

    const pedigree = {
      screened: true,
      tier: null, score: null,
      sourceCompanies: [...new Set(founders.map((f) => f.source))],
      founders,
      lastVerified: TODAY,
      flags: [],
    };
    const { score, tier } = scorePedigree(pedigree, company.theme, registry);
    pedigree.score = score;
    pedigree.tier = tier;
    pedigree.flags = deriveFlags(pedigree, company.theme, registry);

    // Never let an automated pass demote a hand-verified record.
    if (company.pedigree && TIER_ORDER[tier] <= TIER_ORDER[prevTier] && tier !== prevTier) {
      company.pedigree.lastVerified = TODAY;
      console.log(`  = ${company.name}: automated pass weaker than existing record, kept existing`);
      continue;
    }
    company.pedigree = pedigree;
    console.log(`  + ${company.name}: ${prevTier} → ${tier}${score != null ? ` (${score})` : ""}`);
    if (TIER_ORDER[tier] > TIER_ORDER[prevTier]) upgrades.push(`${company.name} → ${tier}`);
  }

  // Pedigree upgrades join the delta ledger — often more actionable than new
  // companies.
  if (upgrades.length) {
    let entry = db.changelog.find((e) => e.date === TODAY);
    if (!entry) { entry = { date: TODAY, added: [], updated: [] }; db.changelog.unshift(entry); }
    entry.pedigree = [...(entry.pedigree ?? []), ...upgrades];
    db.changelog = db.changelog.slice(0, 30);
  }

  const errors = validatePedigree(db);
  if (errors.length) {
    console.error(`${errors.length} guardrail violation(s) — not writing:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  console.log(`done. ${upgrades.length} pedigree upgrade(s)`);
  if (DRY_RUN) { console.log("--dry-run: not writing"); return; }
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
