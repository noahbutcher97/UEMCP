# UEMCP Security Policy

> Rules for keeping this public repository free of project-specific names,
> personal identifiers, internal infrastructure references, and credentials.
> Scope is **information disclosure**, not application security or vulnerability
> management.

## Why this exists

UEMCP is published openly on GitHub. The tool itself is project-agnostic, but
it was built and tested against private game projects whose codenames, asset
hierarchies, internal Perforce depots, and developer-specific infrastructure
should not be public. This policy + its enforcement layer (git hooks + scan
scripts + gitignored doc trees) keeps the public artifact clean while letting
local development stay specific and useful.

The threat model is **passive disclosure** — anyone Googling the repo's
codename, anyone scanning GitHub for codename strings, anyone reading a fork's
history. Mitigation is keeping the tokens out of every committed artifact:
file content, file paths, commit messages, author metadata.

## Sensitive-data taxonomy

Four categories of content must not enter committed artifacts. The actual
tokens within each category are **never enumerated in this file** — that
would itself be a leak. They live in `.git/info/forbidden-tokens` per checkout.

### Category A — Project codenames

Names of the private projects this tool was built for. Including capitalized,
lowercased, hyphenated, and spaced variants. Treat the codename itself as the
sensitive value, not the project's existence.

Replacement vocabulary in committed artifacts:

| Context | Use |
|---|---|
| Narrative text | "Project A" / "Project B" / "the primary target" / "the secondary target" |
| Path examples | `path/to/YourProject` (templates), `<PROJECT_ROOT>` (docs), `${UNREAL_PROJECT_ROOT}` (runnable shells) |
| Sibling MCP server names | `jira-<project>` / `perforce-<project>` (pattern, not specific) |

### Category B — Personal identifiers

Surnames, personal email addresses, employer-specific email addresses, and
Windows username strings appearing in absolute paths (`C:\Users\<username>`).

Notes:
- The repo owner's first name and GitHub handle are public via the repo's URL
  and so are not in scope. Surname is in scope.
- Author/committer metadata on commits is normalized at history-rewrite time
  to a single noreply identity (`*@users.noreply.github.com`). Future commits
  must use the same; configure with:
  ```
  git config user.email "<your-handle>@users.noreply.github.com"
  ```

### Category C — Internal infrastructure references

- Absolute development-machine paths (`<DriveLetter>:\<some-org-tree>\...`)
- Internal Perforce depot identifiers (`//<depot>/...` paths exposing
  team-internal naming)
- Internal hostnames, IPs, VPN endpoints, internal URLs
- Employer or client organization names (when the relationship is private)

Replace with placeholders or generic descriptions ("the team's Perforce
server", "internal CI host").

### Category D — Credentials and secrets

API keys, OAuth tokens, personal access tokens, SSH/PGP private keys, signed
service account credentials, database passwords, JWT bearer tokens.

This category is enforced by **shape-based regexes** in
`.githooks/forbidden-patterns.committed.txt` (committed; the regex shapes are
not themselves sensitive). Coverage includes AWS access keys, GitHub tokens,
Anthropic / OpenAI keys, GCP service account tokens, Slack tokens, GitLab PATs,
PEM private-key headers, and generic high-entropy `password=…` patterns.

Real credentials NEVER belong in this repo regardless of context — including
example configs and test fixtures. Use placeholders (`<your-api-key>`).

## Enforcement layers

Defense in depth:

1. **Process** — this document + a "Public-repo hygiene" section in
   `CLAUDE.md` so agents and humans know the rules before writing.
2. **Pre-commit hook** (`.githooks/pre-commit`) — scans staged additions and
   blocks the commit if any forbidden token appears.
3. **Commit-msg hook** (`.githooks/commit-msg`) — scans the commit message
   text (codenames in commit summaries are a common leak path).
4. **Pre-push hook** (`.githooks/pre-push`) — backstop: scans the diff
   between local and remote refs before push, catching anything that
   bypassed pre-commit (e.g. `--no-verify`, amended commits, fresh clones
   without hooks installed).
5. **Standalone full-tree scan** (`scripts/check-leaks.sh` /
   `scripts/check-leaks.bat`) — scans every tracked file. Run pre-PR or on
   demand for periodic sweeps. Exposed as `npm test` line in the test
   rotation so it runs alongside server unit tests.
6. **Gitignored doc trees** — `docs/handoffs/`, `docs/audits/`,
   `docs/testing/`, `docs/research/` are intentionally untracked.
   Session-local artifacts (agent dispatch briefs, audit reports, manual
   test logs) live there with full project-specific specificity. They are
   useful locally and never leak because they never enter the index.

## Token list lifecycle

`.git/info/forbidden-tokens` is the per-checkout sensitive-token list. It is
inside `.git/`, which git treats as untrackable by definition.

- **First install**: `scripts/install-hooks.bat` (or `.sh`) seeds the file
  with the project's known tokens (the same set used by the historical
  filter-repo scrub) plus regex shapes for known dev-environment paths.
- **Adding tokens**: edit the file directly. Changes apply on next commit.
- **Removing tokens**: same. Use case: when a project is publicly announced
  by its real name, its codename can be removed from the list.
- **Distributing**: this file does not propagate via git. New machines /
  collaborators run `install-hooks` to seed their copy.

## Bypass policy

`git commit --no-verify` and `git push --no-verify` bypass the hooks. They
exist as standard git mechanisms; we cannot prevent them and would not want
to. The policy:

- **Bypass is for emergencies only.** A real emergency is something like a
  one-off deploy fix where the violation is in a known-safe file you'll
  clean up immediately after.
- **If you bypass, audit your decision.** The next person to clone the repo
  starts hooked from clean again; the bypass only persists in history.
- **The fix is almost always content, not bypass.** If a token was flagged,
  edit the staged content to use the right placeholder.
- **Pre-push is the backstop.** Even if pre-commit was bypassed, pushing
  re-checks. Bypass at push too only if the bypass at commit was justified.

## Adding new categories

If a new threat category emerges (e.g. a new vendor's API token format, a new
private project with its own codenames):

- **Specific tokens** (a project codename, an internal URL): add to
  `.git/info/forbidden-tokens` on each dev machine. Don't commit.
- **Generic shapes** (a new credential format): add a `regex:` line to
  `.githooks/forbidden-patterns.committed.txt` and commit. Safe — the regex
  describes shape, not instances.

If the category is structural enough to warrant its own enforcement (e.g.
"no IP addresses ever"), update this document and the README; otherwise the
existing two-file system handles it.

## Verification & maintenance

- **On every commit**: pre-commit + commit-msg hooks fire automatically.
- **On every push**: pre-push hook fires automatically.
- **On every test run**: `server/test-leak-scan.mjs` invokes the full-tree
  scan as part of the standard rotation.
- **Periodic**: `scripts/check-leaks.bat` for explicit sweeps. Useful when
  tokens are added to the list, to verify no historical content already
  matches.

## Out of scope

- **Server-side enforcement**: GitHub does not run pre-receive hooks on
  free / Pro accounts. We rely on client-side hooks + the discipline of
  a small contributor base. If the threat model expands (more contributors,
  higher leak cost), GitHub Enterprise or a self-hosted git server would
  add server-side enforcement.
- **Vulnerability disclosure**: this policy is about information leakage
  in tracked content. Application-level vulnerabilities (the MCP server's
  attack surface, the C++ plugin's TCP exposure, etc.) are managed
  separately via the broader audit cycle (see `docs/audits/`).
- **Secrets rotation**: this policy catches leaks before they happen. If a
  real credential is exposed despite the hooks (e.g. through bypass or
  history pre-dating the policy), rotation of the leaked credential is
  the standard response — and outside this document's scope.
