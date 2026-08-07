// Founder-pedigree scoring + guardrail validation, shared by seed-pedigree.mjs,
// enrich-pedigree.mjs and validate-pedigree.mjs. Zero dependencies.
//
// The score is deterministic and reproducible by hand from the stored fields:
//
//   tenureScore    = min(years, 15) / 15 * 40                       // 0-40
//   ownershipScore = OWNERSHIP_SCORES[ownership]                    // 0-40
//   sourceScore    = sourceCompanies[source].weight * 12            // 0-12
//   fitScore       = domainOverlap(source.domains, theme) ? 8 : 0   // 0-8
//   stint raw      = tenure + ownership + source + fit              // 0-100
//   founder score  = raw * CONFIDENCE_DISCOUNT[confidence]          // never a boost
//   company score  = round(min(100, max(founder scores) + (2+ founders pass ? 5 : 0)))
//
// unverified founders never get a score (null), and a company whose only
// founders are unverified is tier "unscreened". Confidence only ever discounts.

export const OWNERSHIP_SCORES = {
  "cofounder-exec": 40,
  "program-owner": 34,
  "functional-head": 26,
  "senior-ic": 14,
  "ic": 0,
  "unknown": 0,
};

export const CONFIDENCE_DISCOUNT = { "verified": 1, "single-source": 0.9 };

export const YEARS_PRECISIONS = ["reported", "derived", "estimated", "unknown"];

export const PEDIGREE_FLAGS = [
  "founder-detail-unverified",
  "tenure-estimated",
  "title-inflation-risk",
  "short-tenure",
  "source-company-unconfirmed",
];

// Maps the watchlist's themes onto the domain tags used in the sourceCompanies
// registry, for the fit score. A theme not listed here only matches a domain
// tag equal to the theme itself.
export const THEME_DOMAINS = {
  space: ["space"],
  nuclear: ["nuclear", "energy"],
  defense: ["defense"],
  energy: ["energy", "batteries"],
  semis: ["semis"],
  robotics: ["robotics", "autonomy"],
};

// Tier bands over the rounded company score.
export function tierForScore(score) {
  if (score == null) return "unscreened";
  return score >= 78 ? "exceptional" : score >= 62 ? "strong" : score >= 45 ? "qualified" : "weak";
}

export const TIER_ORDER = { unscreened: 0, weak: 1, qualified: 2, strong: 3, exceptional: 4 };

export function domainOverlap(sourceDomains, theme) {
  const wants = new Set([theme, ...(THEME_DOMAINS[theme] ?? [])]);
  return (sourceDomains ?? []).some((d) => wants.has(d));
}

// Raw (pre-discount) score for one founder stint, or null when it can't be
// scored (unverified, or no evidence — no unsourced claims ever get a number).
export function stintRawScore(stint, theme, registry) {
  if (!stint || stint.confidence === "unverified") return null;
  if (!(stint.evidence?.length >= 1)) return null;
  const src = registry?.[stint.source];
  const tenure = (Math.min(Number(stint.years) || 0, 15) / 15) * 40;
  const ownership = OWNERSHIP_SCORES[stint.ownership] ?? 0;
  const sourceScore = (src?.weight ?? 0) * 12;
  const fit = src && domainOverlap(src.domains, theme) ? 8 : 0;
  return tenure + ownership + sourceScore + fit;
}

// The screen itself (§2): ownership tiers 1-3 pass; senior-ic passes only with
// 8+ years; ic/unknown never pass. Unverified founders can't pass.
export function stintPasses(stint) {
  if (!stint || stint.confidence === "unverified") return false;
  if (["cofounder-exec", "program-owner", "functional-head"].includes(stint.ownership)) return true;
  return stint.ownership === "senior-ic" && (Number(stint.years) || 0) >= 8;
}

// Scores a pedigree object in place: sets founder.score on each stint and
// returns { score, tier, bestIdx }. Founders with two source companies appear
// as two stints under the same name and are counted once — the strongest stint
// carries, nothing is double-counted.
export function scorePedigree(pedigree, theme, registry) {
  const founders = pedigree?.founders ?? [];
  let best = null, bestIdx = -1;
  founders.forEach((f, i) => {
    const raw = stintRawScore(f, theme, registry);
    const discounted = raw == null ? null : raw * (CONFIDENCE_DISCOUNT[f.confidence] ?? 0);
    f.score = discounted == null ? null : Math.round(discounted * 10) / 10;
    if (discounted != null && (best == null || discounted > best)) { best = discounted; bestIdx = i; }
  });
  const passingNames = new Set(founders.filter(stintPasses).map((f) => f.name));
  let score = best;
  if (score != null && passingNames.size >= 2) score = score + 5;
  score = score == null ? null : Math.round(Math.min(100, score));
  return { score, tier: tierForScore(score), bestIdx };
}

// Flags that follow mechanically from the data. Manual flags
// (title-inflation-risk) are preserved by callers on top of these.
export function deriveFlags(pedigree, theme, registry) {
  const flags = new Set();
  const founders = pedigree?.founders ?? [];
  if (founders.some((f) => f.confidence === "unverified")) flags.add("founder-detail-unverified");
  if (founders.some((f) => f.score != null && (f.yearsPrecision === "estimated" || f.yearsPrecision === "unknown")))
    flags.add("tenure-estimated");
  const { bestIdx } = scorePedigree(structuredClone(pedigree), theme, registry);
  const carrier = founders[bestIdx];
  if (carrier && carrier.years != null && Number(carrier.years) < 3) flags.add("short-tenure");
  for (const key of pedigree?.sourceCompanies ?? []) if (!registry?.[key]) flags.add("source-company-unconfirmed");
  for (const f of founders) if (f.source && !registry?.[f.source]) flags.add("source-company-unconfirmed");
  return [...flags];
}

// ---------------------------------------------------------------------------
// Guardrail validation (§7) — run by validate-pedigree.mjs in the Action so a
// bad record fails the build instead of shipping.

const OWNERSHIPS = Object.keys(OWNERSHIP_SCORES);
const CONFIDENCES = ["verified", "single-source", "unverified"];

export function validatePedigree(db) {
  const errors = [];
  const registry = db.sourceCompanies ?? {};
  const err = (company, msg) => errors.push(`${company}: ${msg}`);

  for (const [key, src] of Object.entries(registry)) {
    if (!src.label || typeof src.weight !== "number" || src.weight < 0 || src.weight > 1)
      errors.push(`sourceCompanies.${key}: needs a label and a weight in [0,1]`);
  }

  for (const c of db.companies ?? []) {
    const p = c.pedigree;
    if (!p) continue;

    for (const f of p.founders ?? []) {
      const who = `${c.name} / ${f.name ?? "(unnamed)"}`;
      if (!CONFIDENCES.includes(f.confidence)) { err(who, `bad confidence "${f.confidence}"`); continue; }
      if (f.ownership != null && !OWNERSHIPS.includes(f.ownership)) err(who, `bad ownership "${f.ownership}"`);
      if (f.yearsPrecision != null && !YEARS_PRECISIONS.includes(f.yearsPrecision))
        err(who, `bad yearsPrecision "${f.yearsPrecision}"`);

      const evidence = f.evidence ?? [];
      for (const e of evidence) {
        if (!/^https?:\/\//.test(e.url ?? "")) err(who, `evidence url is not absolute http(s): "${e.url}"`);
        if (!e.retrievedAt) err(who, `evidence "${e.url}" has no retrievedAt — every URL must have been fetched (200) during the run`);
        if (/(^|\.)linkedin\.com/.test(safeHost(e.url))) err(who, `evidence uses LinkedIn (${e.url}) — LinkedIn is never scraped; record unverified and queue it instead`);
      }

      if (f.confidence !== "unverified" && evidence.length < 1)
        err(who, `confidence "${f.confidence}" requires at least one retrieved evidence URL`);
      if (f.confidence === "unverified" && f.score != null)
        err(who, `unverified founders must have a null score (found ${f.score})`);
      if (f.score != null && evidence.length < 1)
        err(who, `scored founder has no evidence — no unsourced claims`);
    }

    // Recompute from stored fields: stored numbers must be reproducible, and
    // confidence must only ever have discounted (never raised) the score.
    const copy = structuredClone(p);
    const { score, tier } = scorePedigree(copy, c.theme, registry);
    if ((p.score ?? null) !== (score ?? null))
      err(c.name, `stored score ${p.score} does not reproduce (expected ${score})`);
    if ((p.tier ?? "unscreened") !== tier)
      err(c.name, `stored tier "${p.tier}" does not reproduce (expected "${tier}")`);
    (p.founders ?? []).forEach((f, i) => {
      if ((f.score ?? null) !== (copy.founders[i].score ?? null))
        err(`${c.name} / ${f.name}`, `stored founder score ${f.score} does not reproduce (expected ${copy.founders[i].score})`);
    });

    const required = deriveFlags(p, c.theme, registry);
    for (const flag of required)
      if (!(p.flags ?? []).includes(flag)) err(c.name, `missing required flag "${flag}"`);
    if (!p.lastVerified) err(c.name, `pedigree has no lastVerified date`);
  }
  return errors;
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ""; } }

// Mirrors normName in refresh.mjs so pedigree scripts match companies the same
// way the refresh pipeline dedupes them.
export function normName(n) {
  return n.toLowerCase().replace(/,?\s+(inc|labs|industries|technologies|space|energy|robotics)\.?$/i, "").replace(/[^a-z0-9]/g, "");
}

// SpaceX vests twice a year (May 15 / Nov 15) and departures cluster in the
// weeks after. The refresh Action runs a deeper discovery sweep 4-8 weeks
// following each date (§5).
export function inVestingSweepWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  for (const vest of [Date.UTC(y, 4, 15), Date.UTC(y, 10, 15), Date.UTC(y - 1, 10, 15)]) {
    const days = (now.getTime() - vest) / 86400e3;
    if (days >= 28 && days <= 56) return true;
  }
  return false;
}
