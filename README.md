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
5. The Action commits only if the file changed → Pages redeploys automatically

Schedule: Mon & Thu ~7am ET (`.github/workflows/refresh.yml`). Note GitHub cron is best-effort; runs can be delayed ~15–60 min.

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
