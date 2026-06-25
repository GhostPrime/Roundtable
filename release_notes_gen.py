#!/usr/bin/env python3
"""
release_notes_gen.py
--------------------
Automates a manual changelog/release-notes process for a Git repo.

Given two refs (tags, branches, or commit SHAs), it:
  1. Pulls the merged commits between them from the GitHub API.
  2. Sends them to an LLM (Claude) to produce categorized release notes
     (Features / Fixes / Maintenance / Other) and to flag higher-risk changes
     a release manager should review before sign-off.
  3. Writes clean Markdown release notes to stdout or a file.

This is a BYOK tool: it reads credentials from environment variables and never
stores or transmits them anywhere except the GitHub and Anthropic APIs.

Setup
-----
    pip install requests
    export ANTHROPIC_API_KEY="sk-ant-..."      # required
    export GITHUB_TOKEN="ghp_..."              # optional, raises rate limits / private repos

Usage
-----
    python release_notes_gen.py --repo owner/name --from v1.2.0 --to v1.3.0
    python release_notes_gen.py --repo GhostPrime/Roundtable --from v0.1.0 --to HEAD -o NOTES.md

Run it against your own repo (e.g. Roundtable) to generate real output you can
screenshot/commit, which makes the resume bullet fully truthful.
"""

import argparse
import json
import os
import sys
import urllib.parse

import requests

GITHUB_API = "https://api.github.com"
ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-4-6"  # change to whatever model you have access to


def gh_headers():
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def get_commits(repo, base, head):
    """Return the list of commits between base..head using GitHub's compare API."""
    url = f"{GITHUB_API}/repos/{repo}/compare/{urllib.parse.quote(base)}...{urllib.parse.quote(head)}"
    resp = requests.get(url, headers=gh_headers(), timeout=30)
    if resp.status_code != 200:
        sys.exit(f"GitHub API error {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    commits = []
    for c in data.get("commits", []):
        message = c["commit"]["message"].splitlines()[0]  # subject line only
        author = c["commit"]["author"]["name"]
        sha = c["sha"][:7]
        commits.append({"sha": sha, "author": author, "message": message})
    return commits


def build_prompt(repo, base, head, commits):
    commit_lines = "\n".join(f"- {c['sha']} {c['message']} ({c['author']})" for c in commits)
    return f"""You are a release manager preparing release notes for the repository {repo}, \
covering changes from {base} to {head}.

Here are the merged commits:
{commit_lines}

Produce Markdown release notes with these sections, omitting any that are empty:
## Features
## Fixes
## Maintenance / Internal
## Other

Then add a final section:
## Risk Review
List any changes a release manager should manually verify before sign-off \
(e.g. anything touching auth, data migration, configuration, build/CI, or core \
control logic). For each, give a one-line reason. If nothing looks risky, say so explicitly.

Be concise. Group related commits. Do not invent changes that are not in the list. \
Use only plain ASCII punctuation (regular hyphens -, not em-dashes or arrows)."""


def generate_notes(prompt):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY is not set.")
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": MODEL,
        "max_tokens": 1500,
        "messages": [{"role": "user", "content": prompt}],
    }
    resp = requests.post(ANTHROPIC_API, headers=headers, data=json.dumps(body), timeout=60)
    if resp.status_code != 200:
        sys.exit(f"Anthropic API error {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    return "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")


def sanitize(text):
    """Replace common non-ASCII punctuation with plain ASCII so the output
    renders cleanly everywhere, regardless of what the model emitted."""
    replacements = {
        "\u2014": "-", "\u2013": "-",          # em / en dash
        "\u2192": "->", "\u2190": "<-",         # arrows
        "\u2018": "'", "\u2019": "'",           # smart single quotes
        "\u201c": '"', "\u201d": '"',           # smart double quotes
        "\u2026": "...", "\u2022": "-",          # ellipsis, bullet
        "\u00a0": " ",                            # non-breaking space
    }
    for bad, good in replacements.items():
        text = text.replace(bad, good)
    # Drop any remaining non-ASCII so nothing renders as a box
    return text.encode("ascii", "ignore").decode("ascii")


def main():
    parser = argparse.ArgumentParser(description="Generate AI-assisted release notes from Git history.")
    parser.add_argument("--repo", required=True, help="owner/name, e.g. GhostPrime/Roundtable")
    parser.add_argument("--from", dest="base", required=True, help="base ref (tag/branch/SHA)")
    parser.add_argument("--to", dest="head", default="HEAD", help="head ref (default: HEAD)")
    parser.add_argument("-o", "--output", help="write notes to this file instead of stdout")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch commits and print them without calling the LLM (no Anthropic key needed)")
    args = parser.parse_args()

    commits = get_commits(args.repo, args.base, args.head)
    if not commits:
        sys.exit("No commits found in that range.")
    print(f"Found {len(commits)} commits.", file=sys.stderr)

    if args.dry_run:
        for c in commits:
            print(f"{c['sha']} {c['message']} ({c['author']})")
        print(f"\n[dry-run] {len(commits)} commits fetched OK. Skipped LLM call.", file=sys.stderr)
        return

    print("Generating notes...", file=sys.stderr)

    notes = generate_notes(build_prompt(args.repo, args.base, args.head, commits))
    output = sanitize(notes.strip()) + "\n"

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Wrote {args.output} (clean ASCII)", file=sys.stderr)
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(output)


if __name__ == "__main__":
    main()
