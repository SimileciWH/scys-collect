# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Node.js automation project** using Playwright to scrape data from SCYS (知识星球) and optionally submit to Feishu (飞书) forms. The main code lives in the `automation/` directory.

## Common Commands

All commands run from the `automation/` directory:

```bash
cd automation

# Setup (first time)
npm install
cp config.example.json config.json
# Edit config.json with your SCYS collection URL and Feishu form URL

# Login and capture state (first time)
npm run login        # Initial login to SCYS
npm run capture-state  # Save cookies for future runs

# Run the main collection
npm run run          # Scrape SCYS collection and optionally submit to Feishu

# Development
npm run inspect      # Inspect selectors for debugging
```

## Architecture

The project has a modular structure:

- **scripts/run.js** - Main entry: orchestrates the entire flow (open page → expand sections → extract articles → submit to Feishu)
- **scripts/browserContext.js** - Browser/Chrome profile management: handles cookie persistence, profile cloning
- **scripts/login.js** - First-time login helper
- **scripts/captureState.js** - Cookie/state capture utility
- **scripts/inspect.js** - Selector inspection tool for development
- **config.json** - All configuration (URLs, selectors, form fields)

## Configuration

Edit `automation/config.json` to configure:

- `scysCollectionUrl` - Target SCYS collection page
- `feishuFormUrl` - Feishu form for submissions
- `useChromeProfile` / `useSavedStorageState` - Login state options
- `selectors` - CSS selectors for scraping elements
- `feishuForm` - Form field labels

## Output

Results are saved to:
- `output/` directory - CSV and JSONL files with scraped article data
- `storage_state.json` - Saved login cookies (if using captured state)
