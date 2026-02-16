#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import csv
import json
from pathlib import Path


def read_jsonl(path: Path):
    if not path.exists():
        return
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


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    err_path = root / "automation" / "output" / "zsxq_digests_errors.jsonl"
    out_path = root / "automation" / "output" / "zsxq_errors_for_manual.csv"

    rows = []
    seen = set()
    for obj in read_jsonl(err_path):
        topic_id = str(obj.get("topicId", "") or "").strip()
        article_link = str(obj.get("articleLink", "") or "").strip()
        if not article_link and topic_id:
            article_link = f"https://wx.zsxq.com/mweb/views/topicdetail/topicdetail.html?topic_id={topic_id}"
        key = article_link or f"page={obj.get('pageNo','')}-idx={obj.get('indexInPage','')}-at={obj.get('at','')}"
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "at": obj.get("at", ""),
                "dateOnly": obj.get("dateOnly", ""),
                "title": obj.get("title", ""),
                "author": obj.get("author", ""),
                "topicId": topic_id,
                "articleLink": article_link,
                "error": obj.get("error", ""),
                "pageNo": obj.get("pageNo", ""),
                "indexInPage": obj.get("indexInPage", ""),
            }
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "at",
                "dateOnly",
                "title",
                "author",
                "topicId",
                "articleLink",
                "error",
                "pageNo",
                "indexInPage",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    print(f"written: {out_path}")
    print(f"rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

