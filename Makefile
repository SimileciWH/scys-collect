.PHONY: help zsxq-run zsxq-fast zsxq-dry zsxq-tail zsxq-progress scys-run csv-enrich stats

GROUP_ID ?= 1824528822
DIGESTS_URL ?= https://wx.zsxq.com/digests/$(GROUP_ID)

# Default range (new -> old).
START_DATE ?= 2026-02-28
END_DATE ?= 2020-01-01

MAX_ITEMS ?= 0

help:
	@echo "Targets:"
	@echo "  make zsxq-run        Run ZSXQ digests collector (human pacing, resumable)"
	@echo "  make zsxq-fast       Run collector with FAST=1 (test only)"
	@echo "  make zsxq-dry        Run only a few items (MAX_ITEMS=5, FAST=1)"
	@echo "  make zsxq-progress   Print current progress JSON"
	@echo "  make zsxq-tail       Tail last 20 submitted records (jsonl)"
	@echo "  make scys-run        Run SCYS collector (existing script)"
	@echo "  make csv-enrich      Enrich CSV and submit (existing script)"
	@echo "  make stats           Show throughput stats (auto-detect mode)"
	@echo ""
	@echo "Examples:"
	@echo "  make zsxq-run"
	@echo "  make zsxq-run START_DATE=2026-02-15 END_DATE=2025-01-01"
	@echo "  make zsxq-run MAX_ITEMS=20"
	@echo "  make zsxq-fast MAX_ITEMS=2"
	@echo "  make zsxq-dry"
	@echo "  make zsxq-progress"
	@echo "  make zsxq-tail"
	@echo "  make scys-run"
	@echo "  make csv-enrich"
	@echo "  make stats"
	@echo "  make stats HOURS=6 DAYS=3"
	@echo "  make stats MODE=zsxq HOURS=24 DAYS=14"
	@echo ""
	@echo "Override variables:"
	@echo "  GROUP_ID=... DIGESTS_URL=... START_DATE=YYYY-MM-DD END_DATE=YYYY-MM-DD MAX_ITEMS=N"
	@echo "  MODE=auto|zsxq|scys|csv HOURS=N DAYS=N"

zsxq-run:
	cd automation && GROUP_ID=$(GROUP_ID) DIGESTS_URL=$(DIGESTS_URL) START_DATE=$(START_DATE) END_DATE=$(END_DATE) MAX_ITEMS=$(MAX_ITEMS) node scripts/zsxqDigestsCollectRange.js

zsxq-fast:
	cd automation && FAST=1 GROUP_ID=$(GROUP_ID) DIGESTS_URL=$(DIGESTS_URL) START_DATE=$(START_DATE) END_DATE=$(END_DATE) MAX_ITEMS=$(MAX_ITEMS) node scripts/zsxqDigestsCollectRange.js

zsxq-dry:
	cd automation && FAST=1 GROUP_ID=$(GROUP_ID) DIGESTS_URL=$(DIGESTS_URL) START_DATE=$(START_DATE) END_DATE=$(END_DATE) MAX_ITEMS=5 node scripts/zsxqDigestsCollectRange.js

zsxq-progress:
	@cat automation/output/zsxq_digests_progress.json 2>/dev/null || echo "No progress yet: automation/output/zsxq_digests_progress.json"

zsxq-tail:
	@tail -n 20 automation/output/zsxq_digests_done.jsonl 2>/dev/null || echo "No done log yet: automation/output/zsxq_digests_done.jsonl"

scys-run:
	cd automation && node scripts/run.js

csv-enrich:
	cd automation && node scripts/enrichCsvAndSubmit.js

MODE ?= auto
HOURS ?= 24
DAYS ?= 14

stats:
	./automation/tools/collect_stats.py --mode $(MODE) --hours $(HOURS) --days $(DAYS)
