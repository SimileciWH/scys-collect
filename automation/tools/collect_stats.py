#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Collect run statistics for this repo.

Supports 3 modes (auto-detected):
1) SCYS collector (automation/scripts/run.js)             -> config.outputJsonlPath
2) ZSXQ digests collector (automation/scripts/zsxq...)    -> output/zsxq_digests_done.jsonl
3) CSV enrich+submit (automation/scripts/enrichCsv...)    -> output/csv_enrich_results.jsonl

Outputs:
- hourly counts (default last 24h)
- daily counts (default last 14d)
- cumulative totals (entire log)

Notes:
- For accurate hourly/daily stats, each JSONL line should contain an ISO time field "at".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, Optional, Tuple


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for _ in range(10):
        if (cur / "automation" / "config.json").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise FileNotFoundError("Could not find repo root containing automation/config.json")


def parse_iso(ts: str) -> Optional[datetime]:
    s = (ts or "").strip()
    if not s:
        return None
    # Accept "...Z" or "+00:00" etc.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def read_jsonl(path: Path) -> Iterator[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                yield obj


def file_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except Exception:
        return 0.0


@dataclass(frozen=True)
class ModeSpec:
    mode: str
    done_path: Path
    err_path: Optional[Path]
    time_field: str = "at"


def load_scys_done_path(repo_root: Path) -> Path:
    cfg = repo_root / "automation" / "config.json"
    with cfg.open("r", encoding="utf-8") as f:
        j = json.load(f)
    rel = j.get("outputJsonlPath") or "./output/records.jsonl"
    # Path in config is relative to automation/
    return (repo_root / "automation" / rel).resolve()


def detect_mode(repo_root: Path, forced: Optional[str]) -> ModeSpec:
    auto_candidates: list[ModeSpec] = []

    zsxq_done = repo_root / "automation" / "output" / "zsxq_digests_done.jsonl"
    zsxq_err = repo_root / "automation" / "output" / "zsxq_digests_errors.jsonl"
    if zsxq_done.exists():
        auto_candidates.append(ModeSpec("zsxq", zsxq_done, zsxq_err if zsxq_err.exists() else None))

    csv_done = repo_root / "automation" / "output" / "csv_enrich_results.jsonl"
    csv_err = repo_root / "automation" / "output" / "csv_enrich_errors.log"
    if csv_done.exists():
        auto_candidates.append(ModeSpec("csv", csv_done, csv_err if csv_err.exists() else None))

    scys_done = load_scys_done_path(repo_root)
    scys_err = repo_root / "automation" / "output" / "errors.log"
    if scys_done.exists():
        auto_candidates.append(ModeSpec("scys", scys_done, scys_err if scys_err.exists() else None))

    if forced and forced != "auto":
        forced = forced.lower()
        for c in auto_candidates:
            if c.mode == forced:
                return c
        raise FileNotFoundError(f"forced mode={forced} but expected log file not found")

    if not auto_candidates:
        raise FileNotFoundError("No known output JSONL found under automation/output (or config.outputJsonlPath)")

    # Pick the most recently modified done log as "current".
    auto_candidates.sort(key=lambda m: file_mtime(m.done_path), reverse=True)
    return auto_candidates[0]


def bucket_keys_local(dt: datetime) -> Tuple[str, str]:
    # Use local timezone buckets.
    local = dt.astimezone()
    day = local.strftime("%Y-%m-%d")
    hour = local.strftime("%Y-%m-%d %H:00")
    return hour, day


def summarize_jsonl(path: Path, time_field: str) -> Tuple[int, Optional[datetime], Optional[datetime], Counter, Counter, int]:
    total = 0
    missing_ts = 0
    first_dt: Optional[datetime] = None
    last_dt: Optional[datetime] = None
    by_hour: Counter = Counter()
    by_day: Counter = Counter()

    for obj in read_jsonl(path):
        total += 1
        dt = parse_iso(str(obj.get(time_field, "")))
        if not dt:
            missing_ts += 1
            continue
        if first_dt is None or dt < first_dt:
            first_dt = dt
        if last_dt is None or dt > last_dt:
            last_dt = dt
        h, d = bucket_keys_local(dt)
        by_hour[h] += 1
        by_day[d] += 1

    return total, first_dt, last_dt, by_hour, by_day, missing_ts


def print_table(title: str, rows: Iterable[Tuple[str, int]]) -> None:
    print(title)
    for k, v in rows:
        print(f"- {k}: {v}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Show collector throughput stats (hour/day/total).")
    ap.add_argument("--mode", default=os.getenv("MODE", "auto"), choices=["auto", "zsxq", "scys", "csv"])
    ap.add_argument("--hours", type=int, default=int(os.getenv("HOURS", "24")))
    ap.add_argument("--days", type=int, default=int(os.getenv("DAYS", "14")))
    args = ap.parse_args()

    repo_root = find_repo_root(Path(__file__).parent)
    spec = detect_mode(repo_root, args.mode)

    done_total, done_first, done_last, done_by_hour, done_by_day, done_missing = summarize_jsonl(
        spec.done_path, spec.time_field
    )

    err_total = 0
    err_first = None
    err_last = None
    err_by_hour = Counter()
    err_by_day = Counter()
    err_missing = 0
    if spec.err_path and spec.err_path.exists():
        err_total, err_first, err_last, err_by_hour, err_by_day, err_missing = summarize_jsonl(spec.err_path, "at")

    print(f"mode: {spec.mode}")
    print(f"done_log: {spec.done_path}")
    if spec.err_path:
        print(f"err_log:  {spec.err_path}")
    print("")

    # Cumulative
    span = ""
    if done_first and done_last:
        span = f"{done_first.astimezone().strftime('%Y-%m-%d %H:%M')} -> {done_last.astimezone().strftime('%Y-%m-%d %H:%M')}"
    print("Cumulative:")
    print(f"- done_total: {done_total}")
    print(f"- err_total:  {err_total}")
    if span:
        print(f"- time_span(local): {span}")
    if done_missing:
        print(f"- done_missing_at: {done_missing}  (需要日志里有 at 字段才能做小时/天统计)")
    if err_missing:
        print(f"- err_missing_at:  {err_missing}")
    print("")

    # Recent windows (based on keys, not current wall clock; easiest and stable).
    # Hourly
    hours = max(1, args.hours)
    last_hours = sorted(done_by_hour.keys())[-hours:]
    hour_rows = []
    for h in last_hours:
        hour_rows.append((h, int(done_by_hour.get(h, 0))))
    if hour_rows:
        print_table(f"Hourly done (last {len(hour_rows)} hours):", hour_rows)
        print("")

    # Daily
    days = max(1, args.days)
    last_days = sorted(done_by_day.keys())[-days:]
    day_rows = []
    for d in last_days:
        day_rows.append((d, int(done_by_day.get(d, 0))))
    if day_rows:
        print_table(f"Daily done (last {len(day_rows)} days):", day_rows)
        print("")

    # Also show errors in the same recent windows if available
    if err_total:
        last_err_hours = sorted(err_by_hour.keys())[-hours:]
        err_hour_rows = [(h, int(err_by_hour.get(h, 0))) for h in last_err_hours]
        if err_hour_rows:
            print_table(f"Hourly err (last {len(err_hour_rows)} hours):", err_hour_rows)
            print("")

        last_err_days = sorted(err_by_day.keys())[-days:]
        err_day_rows = [(d, int(err_by_day.get(d, 0))) for d in last_err_days]
        if err_day_rows:
            print_table(f"Daily err (last {len(err_day_rows)} days):", err_day_rows)
            print("")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

