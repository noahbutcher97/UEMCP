# Compile gate: content-based verdicts and a JSON contract for the hook (EN-26, EN-27)

Date: 2026-09-13. Status: approved for planning (decided by the orchestrator under the standing "proceed" instruction; assumptions are listed in §6).

## 1. Problem

`verify-deploy.mjs` decides `SYNC` / `NEEDS-SYNC` / `NEEDS-BUILD` / `NEEDS-DEPLOY` from file modification times alone. Two consequences surfaced the day the pre-push compile gate went live:

- **False staleness after a checkout or merge (EN-27).** `git merge`, `git checkout`, and `git stash pop` rewrite the plugin source files they touch, so their mtimes become "now". Every built target then reads `NEEDS-DEPLOY — DLL predates HEAD source` even though the deployed trees are byte-identical to the repo, and the gate refuses the push until each target is synced and rebuilt again. The first push under the gate needed two extra rebuilds and a coordination window with the session that owns one of the targets.
- **A prose contract (EN-26).** `.githooks/pre-push` decides by grepping the human-readable output for the `Verdict:` prefix and the reason substrings `DLL missing` / `not built`. Two suites now pin those strings, but the contract is still text meant for people.

## 2. Goals

1. A target whose deployed plugin content equals the repo's plugin content, and whose DLL was built after that content was deployed, reads `SYNC` regardless of timestamps.
2. The hook consumes a machine-readable verdict and never parses prose.
3. No change to the human-readable output's meaning; one extra clause on a verdict line is acceptable.
4. Everything is proven by the rotation: the classifier's new inputs are pure and unit-tested; the hook's shape is pinned by `test-pre-push-gate.mjs`.

Non-goals: changing how `sync-plugin.bat` copies files; changing `run-native-tests`; any editor interaction.

## 3. Design

### 3.1 Content identity for the plugin tree

Add a pure helper `hashPluginTree(rootDir, fsImpl)` in a new module `server/plugin-content-hash.mjs`: walks `Source/**` plus `UEMCP.uplugin` under the given plugin root, in sorted relative-path order, and returns a SHA-256 hex digest over `relativePath + "\0" + fileBytes` for each file (path separators normalised to `/`, no mtimes, no directory entries). `Binaries/`, `Intermediate/`, and the deploy marker are excluded. The same function hashes both the repo's `plugin/UEMCP` and a target's `Plugins/UEMCP`, so equality means byte-identical content.

### 3.2 The deploy marker records what was synced and when

`sync-plugin-helper.mjs` already writes `.uemcp-deploy-marker.json` (W-L, D138) with the plugin version. Extend the marker with `sourceHash` (from §3.1, computed over the repo tree at sync time) and `syncedAt` (ISO time). Markers without these fields stay valid; the classifier treats them as "unknown content".

**Amendment (2026-09-14):** `sync-plugin.bat` rewrites the marker on every sync, including a redundant one whose copied content is byte-identical to what was already deployed, so `syncTime` used to advance regardless. `classifyVerdict`'s content rule reads `syncTime` as "when this content was deployed"; an advancing timestamp on unchanged content made an already-current DLL look like it predated the sync, demanding a rebuild nobody needed. The write path (`nextMarkerFields` in `sync-plugin-helper.mjs`) now reads the prior marker before writing: when the prior marker's `sourceHash` is a string equal to the incoming `sourceHash`, `syncTime` carries forward unchanged; otherwise it is set to now. A new field `lastSyncAt` (ISO now) always advances, so the most recent copy is still recorded for humans even when `syncTime` did not move. `markerSyncedAtMs` is unaffected — it still prefers `syncedAt`, then `syncTime`.

### 3.3 Classifier inputs and rules

`classifyDeployState` gains three optional inputs, all computed by the caller: `repoSourceHash`, `deployedSourceHash`, `markerSourceHash`, plus `markerSyncedAtMs`. Rules, applied before the existing mtime rules:

- If `deployedSourceHash === repoSourceHash`: the source is synced by content. Then, if a DLL exists and `dllMtime >= markerSyncedAtMs` (or, with no marker time, `dllMtime >= deployedSrcMtime`), the verdict is `SYNC` with reason `content-identical to repo; DLL built after the last sync`. If the DLL is older than the last sync, `NEEDS-BUILD` with reason `content-identical to repo; DLL predates the last sync`. If no DLL, the existing never-built rules apply.
- If the hashes differ, fall through to the existing mtime-based rules unchanged (they remain right when content really differs).
- The mtime rules are the fallback, never the override: a content match wins over a timestamp mismatch.

The verdict object gains `contentIdentical: true | false | null` (null when a hash could not be computed) so consumers need not parse reasons.

### 3.4 `--json` output

`verify-deploy.mjs --json` prints one JSON document to stdout and nothing else: `{ "version": 1, "profile": <name|null>, "targets": [ { "uprojectPath", "alias", "verdict", "reason", "contentIdentical", "dllExists", "editors": [<pids or command-line stems>], "mcpPointsHere" } ], "exitCode": 0|1|2 }`, with the same exit code as the text mode. `--json` implies `--no-color`; `--quiet` is ignored with it. Errors that today print `[ERROR] ...` and exit 2 print `{ "version": 1, "error": "<message>", "exitCode": 2 }` and exit 2, so the hook can distinguish "could not evaluate" from "evaluated".

### 3.5 The hook consumes JSON

`.githooks/pre-push` calls `node server/verify-deploy.mjs --json --profile <gate profile>`, parses it with a `node -e` one-liner (no jq dependency), and blocks when any target has `verdict` in `NEEDS-SYNC | NEEDS-BUILD | NEEDS-DEPLOY` **and** `dllExists === true` (never-built targets are ignored, as today). When the document carries `error`, or `node` fails, it prints the existing `compile gate could not evaluate` line and allows the push. The block message prints the targets' verdict lines from the JSON, not from prose. `test-pre-push-gate.mjs` is updated to pin the JSON consumption (the `--json` flag, the `dllExists` check, the three verdict names, the could-not-evaluate phrase) and to drop the prose-substring pins; `test-verify-deploy.mjs` keeps pinning `bold('Verdict:')` only if the human output is still consumed anywhere (it is not, after this change; drop that pin and replace it with JSON-shape assertions).

## 4. Testing

- `test-plugin-content-hash.mjs` (new): deterministic digest over an in-memory `fsImpl` fixture; path order independence; mtimes ignored; `Binaries/` and marker excluded; a one-byte change changes the digest.
- `test-verify-deploy.mjs`: the content rules (identical + DLL after sync → SYNC; identical + DLL before sync → NEEDS-BUILD; identical + no DLL → never-built rules; hashes differ → mtime rules unchanged; missing hashes → mtime rules); `--json` document shape, error document shape, exit code parity with text mode (drive the printer through its existing seam or a small extracted `buildJsonReport(targets)` function).
- `test-sync-plugin-helper.mjs`: the marker round-trips `sourceHash` and `syncedAt`; an old marker without them still reads.
- `test-pre-push-gate.mjs`: the new pins.
- Rotation grows by the new assertions; the plan states the expected total. Live proof: after a `git merge --no-ff` of a doc-only branch, or simply `touch`ing a plugin source file, `verify-deploy` still reports `SYNC` for a built target; and the three manual gate probes from WS2 (plugin-touching range with a SYNC profile → pass; bogus profile → could-not-evaluate line; `UEMCP_SKIP_COMPILE_GATE=1` → silent) pass again.

## 5. Sequencing

1. Content hash module + tests. 2. Marker extension + tests. 3. Classifier rules + `--json` + tests. 4. Hook + gate suite + docs (CLAUDE.md gate sentence, EN-26/EN-27 marked DONE). One branch, one implementer at a time, task review after each, whole-branch review at the end.

## 6. Assumptions (decided without the user; revisit if wrong)

- Hashing every plugin source file per target per run is acceptable (about 80 files, well under 100 ms).
- The repo tree, not `git HEAD`, is the reference: the gate runs on a clean tree at push time, and every other `verify-deploy` use compares against the working tree already.
- `sync-plugin.bat` keeps xcopy semantics; only the marker gains fields. A target synced before this change has no `sourceHash` in its marker until the next sync; the deployed-vs-repo hash comparison still works without it, only the "DLL after last sync" check falls back to the deployed source mtime.
