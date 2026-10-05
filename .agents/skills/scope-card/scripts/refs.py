#!/usr/bin/env python3
"""Clone or refresh the reference repos for scope-card scouts and print their SHAs.

Usage: refs.py sync

Reads ~/.config/rakazo/scope-card.json (refsDir, referenceRepos). Clones are shallow, filter
large blobs, skip Git LFS, and leave binaries out when "sparse" is set. A clone is refreshed
when its last fetch is older than 7 days, never when "frozen" is set. Nothing is installed,
built or run inside a clone. Untracked files a user adds to a clone are kept.
"""
import json
import os
import subprocess
import sys
import time

CONFIG = os.path.expanduser("~/.config/rakazo/scope-card.json")
DEFAULTS = [
    {"name": "openclaw", "url": "https://github.com/openclaw/openclaw", "sparse": True},
    {"name": "hermes-agent", "url": "https://github.com/NousResearch/hermes-agent"},
]
BINARY_PATTERNS = [
    "/*", "!*.png", "!*.jpg", "!*.jpeg", "!*.gif", "!*.webp", "!*.mp4", "!*.mov",
    "!*.zip", "!*.woff*", "!*.ttf", "!*.pdf", "!*.ico", "!*.icns",
]
STALE_SECONDS = 7 * 24 * 3600
ENV = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}


def git(*args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def head(path):
    return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], env=ENV, check=True,
                          capture_output=True, text=True).stdout.strip()


def clone(repo, path):
    args = ["clone", "-q", "--depth", "1", "--filter=blob:limit=1m"]
    if repo.get("sparse"):
        args.append("--no-checkout")
    git(*args, repo["url"], path)
    if repo.get("sparse"):
        git("sparse-checkout", "set", "--no-cone", *BINARY_PATTERNS, cwd=path)
        git("checkout", "-q", cwd=path)


def refresh(path):
    marker = os.path.join(path, ".git", "FETCH_HEAD")
    if not os.path.exists(marker):
        marker = os.path.join(path, ".git", "HEAD")
    if time.time() - os.path.getmtime(marker) < STALE_SECONDS:
        return
    git("fetch", "-q", "--depth", "1", "origin", cwd=path)
    git("reset", "-q", "--hard", "FETCH_HEAD", cwd=path)


def main():
    if sys.argv[1:] != ["sync"]:
        sys.exit(__doc__)
    config = {}
    if os.path.exists(CONFIG):
        with open(CONFIG) as fh:
            config = json.load(fh)
    refs_dir = os.path.expanduser(config.get("refsDir", "~/dev/refs"))
    os.makedirs(refs_dir, exist_ok=True)
    for repo in DEFAULTS + config.get("referenceRepos", []):
        path = os.path.join(refs_dir, repo["name"])
        if not os.path.isdir(path):
            clone(repo, path)
        elif not repo.get("frozen"):
            refresh(path)
        slug = repo["url"].removeprefix("https://github.com/").removesuffix(".git")
        print(f"{repo['name']}\t{path}\thttps://github.com/{slug}/blob/{head(path)}/")


if __name__ == "__main__":
    main()
