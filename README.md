# Hard Tech Watchlist

Self-refreshing watchlist of hard tech startups (space, nuclear, defense, energy, semis/data center, robotics). Static site on GitHub Pages; a GitHub Action refreshes the data twice a week using the YC directory, funding-news RSS feeds, and Claude for classification. Git history of `data/companies.json` is the permanent changelog.

## Setup (one time, ~5 minutes)

1. Create a new GitHub repo (private is fine — Pages works on private repos with a Pro plan; otherwise public) and push these files.
2. **Settings → Pages** → Source: "Deploy from a branch" → branch `main`, folder `/ (root)`.
3. **Settings → Secrets and variables → Actions → New repository secret**: name `ANTHROPIC_API_KEY`, value = your API key from console.anthropic.com.
4. **Actions tab** → "Refresh watchlist" → "Run workflow" to test a manual run.

The site will be at `https://<you>.github.io/<repo>/`.

## How the refresh works

`scripts/refresh.mjs` (no npm dependencies, Node 20+):

1. Fetches YC's directory via the yc-oss static JSON mirror + RSS from TechCrunch, Crunchbase News, and Tectonic
2. Keyword-screens items so only plausible hard-tech news reaches the classifier
3. Sends survivors to Claude (Sonnet) → returns adds/updates as structured JSON
4. Merges + dedupes into `data/companies.json`, appends a changelog entry
5. `scripts/enrich-pedigree.mjs` screens a few unscreened (or stale) companies
   per run for founder pedigree — see "Founder pedigree screen" below
6. `scripts/validate-pedigree.mjs` + `scripts/pedigree.test.mjs` enforce the
   pedigree guardrails; any violation fails the run before the commit
7. The Action commits only if the file changed → Pages redeploys automatically

Schedule: Mon & Thu ~7am ET (`.github/workflows/refresh.yml`). Note GitHub cron is best-effort; runs can be delayed ~15–60 min.

## Company detail modal

Clicking any row opens a modal with a fuller description, why the company is on the list, its known backers, and links out to its website and source. Rows are keyboard-accessible (Tab to a row, Enter to open, Escape to close).

Three fields back it: `description`, `whyListed`, and `website`. New companies get them from the refresh classifier automatically. Companies added before those fields existed show empty-state placeholders until backfilled:

```
ANTHROPIC_API_KEY=sk-... node scripts/backfill.mjs            # fill every company missing detail
ANTHROPIC_API_KEY=sk-... node scripts/backfill.mjs --limit 10 # first 10 only, to sample quality
ANTHROPIC_API_KEY=sk-... node scripts/backfill.mjs --dry-run  # report, write nothing
```

The script only writes fields that are currently empty, so it never overwrites existing copy and is safe to re-run. Commit the resulting `data/companies.json` change.

## Founder pedigree screen

An orthogonal screen on top of theme/stage/backers: does a founder have real
tenure **and** real ownership at an elite hard-tech company (SpaceX, Tesla,
Anduril, Waymo, …)? The thesis: alumni who stayed long and owned something are
a different population from alumni who badged in for eighteen months.
**Pedigree predicts fundability, not returns** — alumni lists are
survivorship-biased, so the score is a first-pass diligence filter and the UI
never phrases it as a recommendation.

How it works:

- Each company can carry a `pedigree` object (founders, titles, tenure,
  evidence URLs). The roster of source companies lives in the
  `sourceCompanies` registry inside `data/companies.json` — add
  second-generation spawners (Impulse, Varda, Castelion, Base Power…) there
  with no code change.
- The score is deterministic and reproducible by hand (see
  `scripts/pedigree.mjs`): tenure (0–40, capped at 15y) + ownership tier
  (0–40) + source-company weight (0–12) + domain fit (0–8), then confidence
  only ever *discounts* (single-source ×0.9; unverified → no score at all).
  Tiers: exceptional ≥78 · strong 62–77 · qualified 45–61 · weak <45 ·
  unscreened (null).
- `scripts/enrich-pedigree.mjs` runs in the refresh Action: Moonfire spawner
  pages and the company's own site are fetched, Claude extracts founder facts
  *from those documents only* (citing them by index), and the script computes
  the score. Every evidence URL was fetched with a 200 during the run — a URL
  nobody retrieved cannot enter the data, and LinkedIn is never scraped.
  It runs a deeper sweep in the 4–8 weeks after SpaceX's May 15 / Nov 15
  vesting dates, when departures cluster.
- `scripts/validate-pedigree.mjs` + `scripts/pedigree.test.mjs` fail the
  build on any guardrail violation (unsourced score, unreproducible number,
  missing flags, LinkedIn evidence).
- `scripts/seed-pedigree.mjs` backfilled the initial labelled set of ~27
  companies (safe to re-run; `--force` recomputes existing records).

In the UI: a sortable Pedigree column (`Strong · SpaceX 11y`), pedigree/source
filter chips that compose with the existing filters and persist in the URL, a
founder ledger in the company modal (tenure bars on a shared 20-year axis,
evidence links, flags), and a ⚑ verification queue of unverified or
single-source claims, earliest stage first. Records older than 180 days show
as stale and re-enter the queue. Pedigree tier upgrades are announced in the
Δ ledger.

Out of scope for now (noted as follow-ups): automated LinkedIn enrichment,
secondary-market/SPV access data, valuation tracking, second-generation
spawner detection, and alerting.

## Local preview

```
python3 -m http.server
# open http://localhost:8000
```

(Opening index.html directly via file:// won't load the JSON — browsers block it.)

## Tweaks

- Add/remove feeds or YC industry endpoints: top of `scripts/refresh.mjs`
- Themes and screening keywords: `THEMES` / `KEYWORDS` in the same file
- "NEW" badge window (currently 14 days): `isNew()` in `index.html`
- Stars are stored in your browser's localStorage (per device)
