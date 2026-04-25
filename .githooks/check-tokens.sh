#!/usr/bin/env bash
# .githooks/check-tokens.sh — shared scanning library for pre-commit, commit-msg,
# pre-push hooks (and the standalone scripts/check-leaks.sh tool).
#
# Reads:
#   .git/info/forbidden-tokens                  (per-checkout, NOT tracked)
#   .githooks/forbidden-patterns.committed.txt  (generic shapes, tracked)
#
# Format of either file:
#   - One pattern per line, # for comments, blank lines OK
#   - Lines beginning with `regex:` are extended-regex (case-insensitive)
#   - Other lines are literal substrings (case-insensitive)
#
# Usage: pipe content to scan on stdin:
#   echo "$content" | check-tokens.sh --label "<source label for error msg>"
#
# Exit 0 on clean, 1 on any match. Matched lines printed to stderr.

set -u

label="${1:-content}"
if [[ "$label" == "--label" ]]; then
  label="${2:-content}"
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
local_tokens="$repo_root/.git/info/forbidden-tokens"
committed_patterns="$repo_root/.githooks/forbidden-patterns.committed.txt"

literals_file="$(mktemp)"
regexes_file="$(mktemp)"
cleanup() { rm -f "$literals_file" "$regexes_file"; }
trap cleanup EXIT

for src in "$local_tokens" "$committed_patterns"; do
  [[ -f "$src" ]] || continue
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// /}" ]] && continue
    [[ "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == regex:* ]]; then
      printf '%s\n' "${line#regex:}" >> "$regexes_file"
    else
      printf '%s\n' "$line" >> "$literals_file"
    fi
  done < "$src"
done

if [[ ! -s "$literals_file" && ! -s "$regexes_file" ]]; then
  echo "[check-tokens] No patterns loaded — nothing to scan." >&2
  echo "[check-tokens] Run scripts/install-hooks.bat (or .sh) to set up." >&2
  exit 0
fi

content="$(cat)"
if [[ -z "$content" ]]; then
  exit 0
fi

found=0
output=""

if [[ -s "$literals_file" ]]; then
  matches="$(printf '%s\n' "$content" | grep -F -i -n -f "$literals_file" || true)"
  if [[ -n "$matches" ]]; then
    found=1
    output+=$'\n--- Literal-token matches ---\n'
    output+="$matches"
  fi
fi

if [[ -s "$regexes_file" ]]; then
  matches="$(printf '%s\n' "$content" | grep -E -i -n -f "$regexes_file" || true)"
  if [[ -n "$matches" ]]; then
    found=1
    output+=$'\n--- Regex-pattern matches ---\n'
    output+="$matches"
  fi
fi

if [[ $found -eq 1 ]]; then
  {
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo " ✗ Forbidden token detected in $label"
    echo "════════════════════════════════════════════════════════════════"
    printf '%s\n' "$output" | head -40
    echo ""
    echo " Why this matters: this repo is public. Project codenames, personal"
    echo " info, internal paths, and credentials must not enter committed"
    echo " content. See docs/security-policy.md for the full rationale."
    echo ""
    echo " Fix: edit the staged content to remove or replace the flagged token."
    echo "      Generic placeholders: 'Project A' / 'Project B' /"
    echo "      'path/to/YourProject' / '<PROJECT_ROOT>'."
    echo ""
    echo " Token list:    .git/info/forbidden-tokens (edit to add/remove)"
    echo " Generic file:  .githooks/forbidden-patterns.committed.txt"
    echo ""
    echo " Emergency bypass (rare, audit your decision):"
    echo "   git commit --no-verify"
    echo "   git push --no-verify"
    echo ""
  } >&2
  exit 1
fi

exit 0
