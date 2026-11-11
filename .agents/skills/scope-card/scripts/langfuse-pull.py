#!/usr/bin/env python3
"""Pull Tangow Langfuse observations into a local JSONL file for the scope-card-trace-scout.

Keys come from the env file named by langfuse.envFile in ~/.config/tangow/scope-card.json
(default ~/.config/langfuse/tangow.env) and never leave this process. LANGFUSE_BASE_URL in that
file overrides the default cloud host. Input and output text is truncated so the file stays
small; it may still contain conversation excerpts, so it lives only in the session scratchpad
and is never pasted into Notion.

Usage:
  langfuse-pull.py OUT.jsonl [--days 7] [--type AGENT|TOOL|GENERATION|...] [--name NAME]
                   [--io-chars 400] [--max 2000]
Prints a one-screen summary (counts by type/name, time range, Langfuse trace URL prefix).
"""
import argparse
import base64
import collections
import datetime as dt
import json
import os
import urllib.parse
import urllib.request

CONFIG = os.path.expanduser("~/.config/tangow/scope-card.json")
DEFAULT_ENV_FILE = "~/.config/langfuse/tangow.env"
DEFAULT_BASE = "https://cloud.langfuse.com"


def env_file():
    path = DEFAULT_ENV_FILE
    if os.path.exists(CONFIG):
        with open(CONFIG) as fh:
            path = (json.load(fh).get("langfuse") or {}).get("envFile", path)
    return os.path.expanduser(path)


def load_keys():
    keys = {}
    with open(env_file()) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                keys[k.strip()] = v.strip().strip('"').strip("'")
    base = keys.get("LANGFUSE_BASE_URL", DEFAULT_BASE).rstrip("/")
    return keys["LANGFUSE_PUBLIC_KEY"], keys["LANGFUSE_SECRET_KEY"], base


def get(base, path, params, auth):
    url = f"{base}/api/public/{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def clip(value, n):
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[: n // 2] + f" …[{len(text)} chars]… " + text[-n // 2 :]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--type")
    ap.add_argument("--name")
    ap.add_argument("--io-chars", type=int, default=400)
    ap.add_argument("--max", type=int, default=2000)
    args = ap.parse_args()

    pub, sec, base = load_keys()
    auth = base64.b64encode(f"{pub}:{sec}".encode()).decode()
    projects = get(base, "projects", {}, auth).get("data") or [{}]
    project_id = projects[0].get("id", "<projectId>")
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)).isoformat()
    params = {
        "limit": 100,
        "fromStartTime": since,
        "fields": "core,basic,metadata,io,usage,metrics",
    }
    if args.type:
        params["type"] = args.type
    if args.name:
        params["name"] = args.name

    rows, cursor = [], None
    while len(rows) < args.max:
        page = get(base, "v2/observations", {**params, **({"cursor": cursor} if cursor else {})}, auth)
        data = page.get("data", [])
        for o in data:
            md = o.get("metadata") or {}
            rows.append({
                "traceId": o.get("traceId"),
                "id": o.get("id"),
                "parent": o.get("parentObservationId"),
                "type": o.get("type"),
                "name": o.get("name"),
                "start": o.get("startTime"),
                "latencyMs": o.get("latency"),
                "level": o.get("level"),
                "status": o.get("statusMessage"),
                "cost": o.get("totalPrice"),
                "botId": md.get("botId"),
                "runId": md.get("runId"),
                "model": md.get("model"),
                "input": clip(o.get("input"), args.io_chars),
                "output": clip(o.get("output"), args.io_chars),
            })
        cursor = (page.get("meta") or {}).get("cursor")
        if not data or not cursor:
            break

    rows = rows[: args.max]
    with open(args.out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    counts = collections.Counter((r["type"], r["name"]) for r in rows)
    starts = [r["start"] for r in rows if r["start"]]
    print(f"{len(rows)} observations -> {args.out}")
    if starts:
        print(f"range {min(starts)} .. {max(starts)}")
    for (t, n), c in counts.most_common(15):
        print(f"{c:5d} {t} {n}")
    print(f"trace url: {base}/project/{project_id}/traces/<traceId>")


if __name__ == "__main__":
    main()
