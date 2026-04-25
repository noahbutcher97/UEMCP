# UEMCP Git Hooks

Pre-commit / commit-msg / pre-push hooks that scan staged content for tokens
that must not enter this public repository: project codenames, personal
identifiers, absolute development paths, internal infrastructure references,
and credentials.

## Why

This repo is public. Background: see `docs/security-policy.md` for the full
threat model and rationale. The hook is a defense-in-depth layer — it does not
replace process discipline; it catches the times discipline lapses.

## How it works

```
.githooks/
├── pre-commit                          ← scans `git diff --cached` (added lines)
├── commit-msg                          ← scans the commit message text
├── pre-push                            ← scans the diff between local and remote
├── check-tokens.sh                     ← shared scanning library
├── forbidden-patterns.committed.txt    ← generic regex shapes (tracked, no leaks)
└── README.md                           ← this file

.git/info/forbidden-tokens              ← YOUR tokens (per-checkout, NEVER tracked)
```

The hook reads patterns from **two** sources:

1. **`.githooks/forbidden-patterns.committed.txt`** — generic shapes (API key
   formats, PEM headers, password=… patterns). Tracked, safe to commit because
   no specific sensitive values appear here.

2. **`.git/info/forbidden-tokens`** — your project's actual sensitive strings
   (codenames, surnames, dev paths). Lives inside `.git/`, which is per-checkout
   and never pushed, so the tokens themselves don't leak through this file.

Either or both files can exist; if neither exists, the hook prints a setup
hint and exits 0 (clean).

## Install (once per checkout)

```cmd
scripts\install-hooks.bat
```

(Git Bash / WSL / macOS / Linux: `scripts/install-hooks.sh`.)

The install script:

1. Sets `git config core.hooksPath .githooks` so git uses these scripts.
2. Creates `.git/info/forbidden-tokens` from a template if it doesn't exist.
3. Prints next-steps guidance.

`setup-uemcp.bat` invokes this automatically on new-machine onboarding unless
you set `SETUP_SKIP_HOOKS=1` to opt out.

## Pattern syntax

In either file:

- `# comment` — ignored
- `MyProject` — literal substring, case-insensitive
- `regex:D:[/\\]+SomeDir` — extended regex, case-insensitive

Edit `.git/info/forbidden-tokens` to add or remove tokens. Changes take effect
on the next commit; no install-rerun needed.

## What gets scanned

| Hook | Input | Catches |
|---|---|---|
| `pre-commit` | Added lines in `git diff --cached -U0` | Most leaks before they enter local history |
| `commit-msg` | The commit message text (excluding `#` lines) | Codenames in commit summaries / bodies |
| `pre-push` | Added lines in unpushed commits + their messages | Anything bypassed locally (e.g. `--no-verify`, amended commits, fresh-clone-without-hooks) |

The pre-push hook is the load-bearing safety net — even if a developer commits
locally without hooks installed, pushing requires the hook check to pass.

## Bypassing (rare emergencies only)

```cmd
git commit --no-verify
git push --no-verify
```

If you find yourself reaching for `--no-verify`, the right answer is almost
always to fix the content instead. Genuine emergencies (e.g. you need to ship
a one-off deploy for an outage and the violation is in an unrelated file
you'll fix in the next commit) are the only legitimate use case.

## Performance

Pre-commit scans only added lines (not whole files), so cost scales with
patch size. Typical commit (≤200 lines changed): ~20-50ms.

Pre-push scales with the size of the outgoing diff vs. remote — typically
small unless you're force-pushing a large rewrite.

`scripts/check-leaks.bat` runs the same scan against all currently-tracked
files (whole-tree scan) — use this for periodic sweeps or pre-PR review.

## Adding new patterns

If a new category of sensitive data emerges:

- **Specific value** (a project codename, a person's name, an internal URL):
  add to `.git/info/forbidden-tokens` on every dev machine. Don't commit it.
- **Generic shape** (a new credential format from a new vendor, e.g.
  `xyz_pat_[A-Za-z0-9]{32}`): add a `regex:` line to
  `.githooks/forbidden-patterns.committed.txt` and commit. Safe to share —
  the regex describes the SHAPE, not actual instances.

## Failure modes & recovery

**Hook reports a match in a file you didn't intend to flag**:
The token list is overly aggressive for that file. Options:
1. Adjust the pattern to be more specific (preferred).
2. Replace the offending content with a placeholder.
3. As last resort: `git commit --no-verify` (and audit your decision).

**Hook fires on legit content** (e.g. a security policy doc that mentions
the categories):
The doc should describe categories abstractly without specific tokens.
That's why `docs/security-policy.md` doesn't list project names directly.

**Hook silently does nothing**:
- Run `git config core.hooksPath` — should print `.githooks`.
- Run `bash .githooks/pre-commit` standalone — should print "[check-tokens]
  No patterns loaded" if `.git/info/forbidden-tokens` is missing.
- Re-run `scripts\install-hooks.bat`.

**Hook fails on Windows with "command not found: bash"**:
Install [Git for Windows](https://git-scm.com/download/win), which ships with
Git Bash. Hooks need bash; cmd.exe / PowerShell only invoke them.
