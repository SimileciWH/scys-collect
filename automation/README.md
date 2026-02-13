# SCYS -> Feishu automation (Playwright)

## What it does
- Opens SCYS collection page
- Expands all folded sections
- Iterates article cards
- Opens article, extracts title/author/date/link/feishu-link
- Opens author page, extracts region (fallback: 暂时不知)
- Writes CSV + JSONL
- Optionally opens Feishu form and submits

## Setup

```bash
cd /Volumes/data/workspace/github/scys-collect/automation
npm install
cp config.example.json config.json
```

Fill `config.json`:
- `scysCollectionUrl`: the SCYS collection page
- `feishuFormUrl`: your Feishu form URL
- `useChromeProfile`: `true` to reuse local Chrome login cookies
- `useSavedStorageState`: `true` to prefer saved cookies from `storage_state.json`
- `chromeUserDataDir`: default `~/Library/Application Support/Google/Chrome`
- `chromeProfileDirectory`: usually `Default`
- `chromeProfileCloneDir`: local snapshot dir used by Playwright (avoids Chrome debug restrictions)
- `storageStatePath`: saved cookies/state file path

When `useSavedStorageState=true` and `storage_state.json` exists, scripts run directly with saved cookies.
If missing, it falls back to Chrome profile snapshot mode.

## Capture cookies for later runs

After you log in to SCYS and Feishu in Chrome profile, run:

```bash
npm run capture-state
```

This creates `storage_state.json` for direct reuse in future runs.

## First-time login (optional)

```bash
npm run login
```
Only needed when `useChromeProfile=false` and you use local `user_data`.

## Run

```bash
npm run run
```

## Inspect selectors

```bash
npm run inspect
```

Use DevTools/Playwright to find stable selectors and update `config.json`:
- `selectors.sections`
- `selectors.sectionTitle`
- `selectors.card`
- `selectors.cardTitle`
- `selectors.cardAuthor`
- `selectors.cardDate`
- `selectors.cardLink`
- `selectors.articleTitle`
- `selectors.articleAuthor`
- `selectors.articleDate`
- `selectors.articleContent`
- `selectors.authorLink`
- `selectors.authorRegionLabelTexts`

## Output
- `./output/records.csv`
- `./output/records.jsonl`

Each row:
`title, author, region, industry, publishDate, articleLink, feishuLink`

## Notes
- If Feishu is a dropdown, ensure the option exists; otherwise it will try to type + Enter.
- For stability, increase `slowMoMs` in config.
