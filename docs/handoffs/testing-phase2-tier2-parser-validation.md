# Handoff: Tier-2 Parser Validation against ProjectA Content

**Audience**: Agent 5 (testing + audit agent)
**Host**: Claude Code running in `D:\UnrealProjects\5.6\ProjectA` with uemcp MCP connected
**Mission**: Drive a structured manual validation pass against the UEMCP offline parser tools using real ProjectA content, surface bugs the mocked unit tests cannot catch, and file findings as sealed audit documents.
**Status on dispatch**: Phase 2 complete and committed (main @ 2611833). All 315 unit assertions pass. Server binary was broken pre-dispatch by a duplicated-tail corruption; fixed in commit 5bbce97. Tier-2 validation begins now.

---

## 1. Context you must read before acting

Read these in order. Do not skip. If any file is missing, stop and report.

1. `D:\DevTools\UEMCP\CLAUDE.md` — project overview, 4-layer architecture, D-log reference, file layout, code standards
2. `D:\DevTools\UEMCP\docs\tracking\risks-and-decisions.md` — D-log entries D1 through D37 (tail)
3. `D:\DevTools\UEMCP\docs\specs\conformance-oracle-contracts.md` — optional, for understanding the TCP side you are NOT testing
4. `D:\DevTools\UEMCP\server\offline-tools.mjs` — skim the 13 tool handlers; note which call into `uasset-parser.mjs`
5. `D:\DevTools\UEMCP\server\uasset-parser.mjs` — binary reader under test; understand the FPackageFileSummary → name table → import/export → FAssetRegistryData chain (D37)
6. `D:\DevTools\UEMCP\docs\audits\` — skim recent audits to match format conventions
7. Prior handoff (consumed): the broader Phase 3 research handoff that this session replaced is gone. Noah's workflow deletes handoffs after consumption.

**Ground truth for your mission**: `docs/research/phase3-design-research.md` is Agent 4's deliverable covering Phase 3 buckets 3A–3F. You are NOT implementing from it. You are validating Phase 2's offline tools against production content so Phase 3 starts from a known-solid base.

---

## 2. Known finding already surfaced

A finding was discovered in the opening scans; log it in your audit doc without re-discovering it.

**Finding F0 — Response verbosity exceeds MCP token cap**
- Severity: High (usability, not correctness)
- Reproduction: `query_asset_registry path_prefix:/Game/Blueprints/ limit:2000 max_scan:20000`
- Symptom: 16 files → 817 KB response; Claude Code exceeded inline token cap and saved output to disk
- Root cause hypothesis: each result includes the raw Base64-encoded `ActorMetaData` tag blob (~50 KB/asset) even though callers rarely decode it
- Impact: the tool is effectively unusable from an agent context for any folder with more than ~15 assets — which is every real folder in ProjectA
- Suggested fix directions (do not implement — just capture):
  - `verbose: false` default that strips raw binary tag payloads
  - Keep decoded scalar tags (name, parent class, interfaces, native class family)
  - Add `max_response_bytes` soft cap with truncation counter
  - Optional `include: [...]` projection param

Your audit doc must open with F0 and then accumulate new findings as F1, F2, …

---

## 3. Test matrix

Nine content categories × four parser-backed tools + nine other offline tools. Run the matrix in the order below — earlier rows are safer, later rows are the stress surface.

### 3A — Parser-backed tool coverage

| # | Tool | Input | Purpose |
|---|------|-------|---------|
| 1 | `query_asset_registry` | `path_prefix:/Game/Blueprints/` | Baseline (already run; clean) |
| 2 | `query_asset_registry` | `path_prefix:/Game/Characters/` | Character BPs — medium size |
| 3 | `query_asset_registry` | `path_prefix:/Game/GAS/` | GAS BPs — lots of BP-generated classes, worst-case AR tag variety |
| 4 | `query_asset_registry` | `path_prefix:/Game/Animations/` | Montages, AnimBPs, AnimNotifies — different export types |
| 5 | `query_asset_registry` | `path_prefix:/Game/Data/` | DataTables, StringTables, DataAssets |
| 6 | `query_asset_registry` | `path_prefix:/Game/UI/` | UMG widgets — WidgetBlueprint class |
| 7 | `query_asset_registry` | `path_prefix:/Game/Materials/` | Materials, MaterialInstances — no BP class at all |
| 8 | `query_asset_registry` | `path_prefix:/Game/Maps/` or `/Game/Levels/` | `.umap` files specifically (parser takes a separate path here) |
| 9 | `query_asset_registry` | `class_name:DataTable` | Class-name filter — exercises the AR tag decoder specifically |
| 10 | `query_asset_registry` | `class_name:StringTable` | Same, different class |
| 11 | `query_asset_registry` | `class_name:WidgetBlueprint` | UMG class filter |
| 12 | `get_asset_info` | `/Game/Blueprints/Character/BP_OSPlayerR` | Base case; already scans clean inside query_asset_registry |
| 13 | `get_asset_info` | a DataTable path | Non-BP AR metadata |
| 14 | `get_asset_info` | a Material path | Fewest tags; edge case |
| 15 | `get_asset_info` | a WidgetBlueprint path | UMG tags |
| 16 | `get_asset_info` | a path that does NOT exist | Error envelope shape |
| 17 | `inspect_blueprint` | `/Game/Blueprints/Character/BP_OSPlayerR` | Export-table walk on a complex BP |
| 18 | `inspect_blueprint` | a GA_OS* ability BP | BP deriving from C++ base class |
| 19 | `inspect_blueprint` | a WidgetBlueprint path | Non-actor BP |
| 20 | `inspect_blueprint` | a small BP (BP_PunchingBag or similar) | Minimum case |
| 21 | `list_level_actors` | the main playable map | Actor enumeration; class+name only per YAGNI |
| 22 | `list_level_actors` | a small test map | Minimum case |
| 23 | `list_level_actors` | a persistent level referencing sublevels | Sublevel handling edge case |

### 3B — Other offline tools (sanity only, one call each is enough)

| # | Tool | Input |
|---|------|-------|
| 24 | `project_info` | (none) |
| 25 | `list_plugins` | (none) |
| 26 | `get_build_config` | (none) |
| 27 | `list_config_values` | `config_file:DefaultGame.ini` |
| 28 | `list_config_values` | `config_file:DefaultEngine.ini` with a `section` filter |
| 29 | `list_gameplay_tags` | (none) |
| 30 | `search_gameplay_tags` | `query:Attack` |
| 31 | `list_data_sources` | (none) |
| 32 | `read_datatable_source` | path to one table discovered in #31 |
| 33 | `read_string_table_source` | path to one string table discovered in #31 |

---

## 4. For every test, record

Use this exact structure for each row in your audit doc's test log:

```
### T<n> — <tool> <short input>
- Command: <the exact tool call>
- Result: clean | warning | error | timeout
- Files scanned / items returned: <N>
- Response size: <approximate bytes>
- Observations: <anything non-obvious — unknown class names, missing tags, weird paths, decode failures, malformed UTF-8, etc.>
- Finding IDs raised: F<k>, F<k+1>, … or "none"
```

Keep observations terse. Do not paste large JSON blobs into the audit — save them to disk if needed and reference paths.

---

## 5. Finding severity rubric

Use these three tiers. Don't invent a fourth. If something feels like it's between tiers, pick the higher one and say why in the body.

- **High** — tool unusable, returns wrong data, crashes the server, or blocks a downstream Phase 3 decision. F0 is High (tool hits token cap on any real folder).
- **Medium** — tool works but has a sharp edge: confusing error messages, missing-but-should-have field, silent swallowing of edge cases, perf worse than expected but not blocking, inconsistent envelope shape between tools.
- **Low** — cosmetic or nice-to-have: doc/description mismatch, field naming inconsistency, redundant info in response, minor perf.

Each finding gets a one-line severity + one-paragraph body + reproduction steps + suggested fix direction (do NOT implement).

---

## 6. Unknown-error protocol

When a tool does something you didn't expect — crashes, returns malformed JSON, times out, produces nonsense for an otherwise-valid input:

1. **Capture the exact command and full response.** If the response is large, save it under `docs/audits/artifacts/tier2-YYYY-MM-DD/<Tn>-<short>.json` or `.txt`. Reference the path in the audit, don't paste.
2. **Try to narrow.** Shrink the input (smaller path_prefix, fewer files). If the bug survives narrowing, you have a cleaner reproduction.
3. **Do not patch the server.** Your job is to surface and document. Exception: if the server is so broken that no further testing can proceed, stop and escalate back to Noah — do not try to fix it yourself.
4. **Check whether the bug is in the parser or the tool handler.** The parser is `server/uasset-parser.mjs`; the handlers are in `server/offline-tools.mjs`. A malformed export table hints parser; a weird error envelope hints handler. Note the suspicion in the finding body.
5. **One finding per distinct root cause.** Don't file F3, F4, F5 for three symptoms of the same underlying bug — consolidate and list all repros under one finding.

---

## 7. Output protocol

- **Audit document**: `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (use the dispatch date, not the completion date — matches the sealed-audit convention).
- **Structure**:
  1. Preamble: mission, dispatch date, scope, host environment
  2. Findings section: F0 (pre-seeded) then F1, F2, … in order of discovery
  3. Test log: T1 through T33 in matrix order, using the record format in §4
  4. Summary: total tests, clean/warning/error counts, findings-by-severity totals
  5. Proposed D-log entry (see §8)
  6. Sign-off block (leave blank — Noah/orchestrator fills this)
- **Sealed**: once you write the sign-off marker, do NOT edit the document. Corrections go in an `## Amendment A` blockquote at the bottom, per the sealed-audit convention in `memory/convention_sealed_audits.md`.
- **Large artifacts**: save under `docs/audits/artifacts/tier2-2026-04-15/` and reference by relative path.

---

## 8. Termination criteria

Before declaring done, verify all of the following:

1. All 33 matrix rows have a test record (§4 format). Skipped rows must have an explicit `Result: skipped` with reason.
2. Every finding is F-numbered, has severity, has a reproduction, has a suggested fix direction.
3. A proposed D-log entry is drafted at the bottom of the audit — one paragraph, following the house style in `docs/tracking/risks-and-decisions.md`. Do NOT write to `risks-and-decisions.md` yourself; the orchestrator seals D-log entries.
4. The audit doc has a sign-off marker (e.g., `---\n**Sealed**: 2026-04-15`).
5. Any large artifacts are saved to disk and referenced.
6. No uncommitted changes to `server/` — this is a validation pass, not implementation.

---

## 9. Final report format

At the end, post one message back to Noah (or the orchestrator) with this exact structure. Keep it tight — the audit doc has the detail.

```
Tier-2 parser validation complete.

Audit: docs/audits/phase2-tier2-parser-validation-2026-04-15.md
Tests: <clean>/<warning>/<error>/<skipped> of 33
Findings: <count> total — <high>H / <med>M / <low>L
  F0: Response verbosity exceeds MCP token cap (High, pre-seeded)
  F1: <one-line summary> (<severity>)
  F2: ...

Parser health: <one sentence — e.g., "clean across 19k files, no crashes, no malformed parses">
Blocker for Phase 3: <yes/no + one-liner>

Proposed D-log: <one-line summary, drafted in §5 of audit>
```

If you blow through a test and find nothing, say "no findings" explicitly — silence reads as "didn't test."

---

## 10. Out of scope

Do not:
- Implement the F0 fix or any other finding
- Touch TCP tools (Phase 2) or the Remote Control layer (Phase 4 — doesn't exist yet)
- Edit `risks-and-decisions.md` directly
- Refactor the parser even if you spot "obvious" improvements — capture as findings
- Test against ProjectB — this pass is ProjectA-only

Questions you cannot answer from this handoff plus the §1 pre-reads: stop and ask. Do not guess.
