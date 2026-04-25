#!/usr/bin/env bash
# scripts/check-leaks.sh — scan all tracked files for forbidden tokens.
#
# Use this for periodic sweeps and pre-PR review. The pre-commit hook only
# scans the patch being committed; this script scans the whole working tree
# of tracked files.
#
# Excludes the pattern-source files themselves (which legitimately contain
# the patterns and would always self-match).
#
# Exit 0 = clean. Exit 1 = at least one match (printed to stderr).

set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$repo_root" ]]; then
  echo "ERROR: not inside a git repo." >&2
  exit 1
fi

cd "$repo_root"

# Collect tracked files, excluding the pattern-source file (would self-match)
tracked="$(git ls-files | grep -v -E '^\.githooks/forbidden-patterns\.committed\.txt$' || true)"

if [[ -z "$tracked" ]]; then
  echo "[check-leaks] No tracked files."
  exit 0
fi

# Build content stream: prefix each line with FILENAME:LINENO so output is useful.
# Skip binary files (NUL byte detection in first 8KB).
content_stream() {
  while IFS= read -r f; do
    if [[ -f "$f" ]] && head -c 8000 -- "$f" 2>/dev/null | LC_ALL=C grep -q $'\x00'; then
      continue
    fi
    grep -nH "" "$f" 2>/dev/null || true
  done <<< "$tracked"
}

content_stream | bash .githooks/check-tokens.sh --label "tracked files (full-tree scan)"
ec=$?

if [[ $ec -eq 0 ]]; then
  count=$(echo "$tracked" | wc -l)
  echo "[check-leaks] OK — $count tracked files (excl. pattern source), 0 forbidden tokens."
fi

exit $ec
