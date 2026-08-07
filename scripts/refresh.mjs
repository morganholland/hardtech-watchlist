// Hard Tech Watchlist — refresh pipeline
// Runs in GitHub Actions on a cron schedule. Node 20+, zero npm dependencies.
//
// Flow:
//   1. Load existing data/companies.json
//   2. Fetch candidate items:
//        a. YC directory via the yc-oss static JSON mirror (structured, stable)
//        b. RSS feeds: TechCrunch, Crunchbase News, Tectonic (funding news)
//   3. Filter to plausibly-relevant items with cheap keyword screening
//   4. Send survivors to Claude for classification (theme, stage, tier, dedupe-safe name)
//   5. Merge: add new companies, update stage on existing ones, append changelog
//   6. Write file. The Action commits only if the file changed.

import { readFileSync, writeFileSync } from "node:fs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

const THEMES = ["space", "nuclear", "defense", "energy", "semis", "robotics"];

// Cheap pre-filter so we don't send every AI-app press release to the classifier
const KEYWORDS = /\b(space|orbital|satellite|launch|rocket|lunar|reentry|nuclear|reactor|fission|fusion|SMR|HALEU|uranium|defense|defence|drone|counter-UAS|hypersonic|munition|missile|autonom|maritime|geothermal|solar|battery|batteries|grid|energy storage|electrolyz|semiconductor|chip|photonic|optical interconnect|silicon|packaging|interposer|inference|GPU|data center|datacenter|robot|humanoid|actuator|manufactur|machining|aerospace)\b/i;

const RSS_FEEDS = [
  "https://techcrunch.com/feed/",
  "https://news.crunchbase.com/feed/",
  "https://www.tectonicdefense.com/feed/",
];

// yc-oss/api — community-maintained static JSON mirror of the YC directory.
// Slugs must exist in https://yc-oss.github.io/api/meta.json ("industries" map);
// there is no "hard-tech" industry, so the six themes are covered by these.
const YC_ENDPOINTS = [
  "https://yc-oss.github.io/api/industries/industrials.json",
  "https://yc-oss.github.io/api/industries/aviation-and-space.json",
  "https://yc-oss.github.io/api/industries/defense.json",
  "https://yc-oss.github.io/api/industries/drones.json",
  "https://yc-oss.github.io/api/industries/energy.json",
  "https://yc-oss.github.io/api/industries/manufacturing-and-robotics.json",
];

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "hardtech-watchlist/1.0" } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.text();
  } catch (e) {
    console.warn(`fetch failed ${url}: ${e.message}`);
    return null;
  }
}

// Minimal RSS item extraction — good enough for title/link/description/date
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return r ? r[1].replace(/<[^>]+>/g, "").trim() : "";
    };
    items.push({ title: pick("title"), link: pick("link"), description: pick("description").slice(0, 500), pubDate: pick("pubDate") });
  }
  return items;
}

function withinDays(dateStr, days) {
  const d = new Date(dateStr);
  return !isNaN(d) && Date.now() - d.getTime() < days * 86400e3;
}

async function gatherCandidates(existingNames) {
  const candidates = [];

  for (const feed of RSS_FEEDS) {
    const xml = await fetchText(feed);
    if (!xml) continue;
    for (const item of parseRss(xml)) {
      if (!withinDays(item.pubDate, 8)) continue;              // only items since last run (+buffer)
      if (!KEYWORDS.test(item.title + " " + item.description)) continue;
      candidates.push({ source: "rss", ...item });
    }
  }

  const seenYc = new Set();                                     // endpoints overlap; don't send dupes to the classifier
  for (const url of YC_ENDPOINTS) {
    const json = await fetchText(url);
    if (!json) continue;
    try {
      for (const c of JSON.parse(json)) {
        if (existingNames.has(normName(c.name))) continue;
        if (seenYc.has(normName(c.name))) continue;
        seenYc.add(normName(c.name));
        if (!KEYWORDS.test(`${c.name} ${c.one_liner ?? ""} ${(c.tags ?? []).join(" ")}`)) continue;
        candidates.push({ source: "yc", title: c.name, description: c.one_liner ?? "", link: c.url ?? "", batch: c.batch ?? "" });
      }
    } catch { console.warn(`bad JSON from ${url}`); }
  }

  return candidates;
}

function normName(n) {
  return n.toLowerCase().replace(/,?\s+(inc|labs|industries|technologies|space|energy|robotics)\.?$/i, "").replace(/[^a-z0-9]/g, "");
}

async function classify(candidates, existingCompanies) {
  if (candidates.length === 0) return [];
  const existingList = existingCompanies.map((c) => c.name).join(", ");

  const prompt = `You maintain a hard-tech startup investing watchlist with these themes: space (launch, satellites, orbital infra), nuclear (fission, fusion, fuel), defense (autonomy, drones, EW, munitions, defense manufacturing), energy (geothermal, solar-thermal, grid batteries, critical minerals), semis (AI chips, photonics, networking silicon, packaging, DC power/cooling, battery materials), robotics (humanoids, foundation models, industrial automation).

Existing companies on the list (do NOT re-add; if an item is news about one of these, emit an "update" instead): ${existingList}

Candidate items (news headlines and YC directory entries):
${JSON.stringify(candidates, null, 1)}

Return ONLY a JSON array, no prose, no markdown fences. For each RELEVANT item emit one object:
{"action":"add"|"update","name":"Company","theme":"space|nuclear|defense|energy|semis|robotics","tier":"growth|seed","stage":"e.g. Series B ($100M, Aug 2026)","oneLiner":"what they do, <=15 words","description":"2-3 sentences: what they build, how it works, where they are","whyListed":"1-2 sentences: why this belongs on a hard-tech investing watchlist — the thesis, not a restatement of what they do","investors":["Lead VC"],"status":"private|public|acquired","website":"company homepage URL","sourceUrl":"link to the news item or directory entry"}
Rules: skip items that are not clearly a hard-tech company in one of the six themes (AI apps, SaaS, biotech, fintech = skip). tier "seed" = pre-seed/seed/YC; "growth" = Series A+. For "update", only include fields that changed (name + changed fields). "website" and "sourceUrl" must be absolute URLs starting with https:// (or http://) — a bare domain is dropped by the site. Omit "website" if you don't know the real homepage; do not guess a URL. If nothing is relevant, return [].`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
  });
  // Throw rather than return [] — a silent [] is indistinguishable from
  // "nothing relevant found", so a broken key would commit a no-op refresh
  // and leave the Action green.
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  // A response cut off at the token cap parses as broken JSON; name the real
  // cause instead of failing as "unparseable output".
  if (data.stop_reason === "max_tokens")
    throw new Error(`classifier output truncated at max_tokens with ${candidates.length} candidates — raise max_tokens or tighten the keyword screen`);
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    throw new Error("classifier returned unparseable output:\n" + text.slice(0, 500));
  }
}

async function main() {
  const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const existingNames = new Set(db.companies.map((c) => normName(c.name)));

  const candidates = await gatherCandidates(existingNames);
  console.log(`${candidates.length} candidate items after keyword screen`);

  const results = await classify(candidates, db.companies);
  const added = [], updated = [];

  for (const r of results) {
    if (!r?.name || !THEMES.includes(r.theme ?? "")) { if (r?.action !== "update") continue; }
    const key = normName(r.name);
    const existing = db.companies.find((c) => normName(c.name) === key);

    if (r.action === "add" && !existing) {
      db.companies.push({
        name: r.name, theme: r.theme, tier: r.tier ?? "seed", stage: r.stage ?? "",
        oneLiner: r.oneLiner ?? "", description: r.description ?? "", whyListed: r.whyListed ?? "",
        investors: r.investors ?? [], status: r.status ?? "private",
        website: r.website ?? "", sourceUrl: r.sourceUrl ?? "",
        addedOn: new Date().toISOString().slice(0, 10),
      });
      added.push(r.name);
    } else if (existing) {
      for (const f of ["stage", "oneLiner", "description", "whyListed", "website", "status", "tier"]) if (r[f]) existing[f] = r[f];
      if (r.investors?.length) existing.investors = [...new Set([...(existing.investors ?? []), ...r.investors])];
      if (r.stage || r.status) updated.push(`${r.name} → ${r.stage ?? r.status}`);
    }
  }

  if (added.length || updated.length) {
    db.changelog.unshift({
      date: new Date().toISOString().slice(0, 10),
      added, updated,
    });
    db.changelog = db.changelog.slice(0, 30);
  }
  db.lastRefresh = new Date().toISOString();

  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");
  console.log(`done. added: ${added.length}, updated: ${updated.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
