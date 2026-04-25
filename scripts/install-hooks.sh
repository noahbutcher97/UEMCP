#!/usr/bin/env bash
# scripts/install-hooks.sh — wire git's hooksPath to .githooks/ and create a
# stub forbidden-tokens file (the actual sensitive tokens are added by the
# operator post-install, never via this tracked script).
#
# Idempotent: safe to re-run.
# Opt-out from setup-uemcp.bat via env: SETUP_SKIP_HOOKS=1

set -e

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$repo_root" ]]; then
  echo "ERROR: not inside a git repo." >&2
  exit 1
fi

cd "$repo_root"

echo "[install-hooks] Setting core.hooksPath = .githooks ..."
git config core.hooksPath .githooks

# Make scripts executable on Unix-y systems (Windows ignores; .bat shim handles it)
chmod +x .githooks/pre-commit .githooks/commit-msg .githooks/pre-push .githooks/check-tokens.sh 2>/dev/null || true

local_tokens=".git/info/forbidden-tokens"
if [[ -f "$local_tokens" ]]; then
  echo "[install-hooks] $local_tokens already exists — leaving it alone."
else
  mkdir -p .git/info
  cat > "$local_tokens" <<'STUB_EOF'
# .git/info/forbidden-tokens — your specific sensitive strings.
#
# This file is per-checkout (under .git/) and never tracked or pushed.
# Edit it freely; changes take effect on the next commit (no install rerun).
#
# Format:
#   # comment lines start with hash
#   <literal>                  # case-insensitive substring match
#   regex:<pattern>            # extended regex, case-insensitive
#
# Generic credential shapes (API keys, PEM headers) live in the tracked
# .githooks/forbidden-patterns.committed.txt file. THIS file is for tokens
# specific to YOUR projects / environment — codenames, surnames, dev paths,
# internal infrastructure references.
#
# === ADD YOUR TOKENS BELOW THIS LINE ===
#
# Suggested categories — fill in your actual values:
#
# Project codenames:
#   <ProjectCodename>
#   <projectcodename>
#
# Personal info:
#   <YourSurname>
#   <your-personal-email@example.com>
#   <Windows-username-from-paths>
#
# Internal infrastructure:
#   //<perforce-depot-path>
#   <internal-hostname-or-domain>
#
# Absolute dev paths (regex):
#   regex:[A-Z]:[/\\]+<top-level-dir>[/\\]+<project-folder>
#
# After editing this file, run `scripts/check-leaks.sh` to verify the
# tracked tree currently has no matches against your token list.
STUB_EOF
  echo "[install-hooks] Created stub $local_tokens"
  echo "[install-hooks] EDIT THAT FILE NOW with your project's actual sensitive tokens."
  echo "[install-hooks] (See docs/security-policy.md for the data-categories rationale.)"
fi

# Sanity check: bash availability for the hook scripts
if ! command -v bash >/dev/null 2>&1; then
  echo "[install-hooks] WARNING: bash not on PATH. Hooks need Git Bash to run."
  echo "[install-hooks] On Windows, install Git for Windows (which ships bash)."
fi

echo ""
echo "[install-hooks] Done."
echo "[install-hooks] Hooks active for this checkout."
echo "[install-hooks] Verify with: scripts/check-leaks.sh"
