# Decoupling the commandlet oracles from a live project

**Date**: 2026-08-25
**Status**: Implemented. Option D, with two premises corrected by survey — see *What the survey found*.
**Relates to**: backlog T-1 (fixture philosophy), T-1c (Oracle-A v3), D187 (freshness gate), D188 (discovery migration)

## What the survey found

Before picking a fixture, all 5201 assets under UE 5.6's `Engine/Content` were
measured with our own parser. Two of this document's premises did not survive.

**Engine Blueprints are more complex than the production fixture, not less.**
T-1 worried that engine samples would be too simple and that real-world
complexity — deep collapsed graphs, delegate graphs, macro expansion — would be
lost. For 5.6 that is false:

| Asset | Graph nodes | Roots | Collapsed |
|---|---|---|---|
| `RenderToTexture_LevelBP` | 1679 | 55 | 102 |
| `FS_BombField_Prototype` | 1740 | 18 | 10 |
| `StandardMacros` | 227 | 48 | 58 |
| `BP_OSPlayerR` (production) | 313 | — | 0 |

The largest are too big to commit — oracles run about 1 KB per node, so
`RenderToTexture_LevelBP` would be a 1.7 MB fixture. That is the real constraint
on picking, not complexity.

**No engine Blueprint has a delegate binding.** Zero, across all 5201 assets.
This document pre-authorised recording exactly this ("if none has enough shape,
record that finding"), and it settles step 4: the production fixture stays as a
complexity witness on evidence rather than as a hedge.

**Portability is narrower than §D.1 claimed.** Engine fixtures need an engine
install. A bare CI runner has none, so they skip there exactly as project
fixtures do. The win is not "runs everywhere" — it is trading coupling to a
*mutating private project* for coupling to a *versioned immutable install*.
Drift goes to zero for a given engine version; absence stays possible. §D.1's
"ship gate" wording overpromised and is corrected here.

## What shipped

`BP_Sky_Sphere` (122 nodes, 4 graphs, 290 edges — ordinary Actor shape) and
`StandardMacros` (227 nodes, 24 graphs, 654 edges — dense tunnel/macro shape),
both dumped from 5.6.1 with the existing commandlet. Both reach 100% hybrid edge
coverage against the parser, with zero malformed nodes and zero dangling edges.

Resolution lives in `server/engine-fixtures.mjs` (TDD, 20 assertions) and is
kept separate from `findContentAsset` so a project asset can never shadow an
engine one.

Coverage restored, running with **no project attached**:

| Suite | Before | After |
|---|---|---|
| `test-s-b-base-differential` | 3 | 32 |
| `test-uasset-parser` CP1 | 235 | 245 |

**One hazard found and closed while building this.** Resolving `/Engine/`
by "newest installed engine" silently read UE 5.8's copy of an asset when 5.6
was meant — the same path holds different bytes in each version, it parses
cleanly, and it disagrees with the oracle in a way that reads as a parser
regression. `resolveAssetDiskPath` now declines an `/Engine/` read unless the
engine is named (`UE_ENGINE_ROOT` or an explicit argument), and
`resolveEngineRoot({preferVersion})` never falls back to another version.
Guessing produced confident wrong data; declining produces a recoverable
`asset_not_found`.

## Why this was scheduled separately

The T-1b pass just landed removed content coupling from the `BPGA_Block` L1 and L2 gates by separating parser-behaviour assertions from content inventory. **That technique does not work for the two remaining coupled tests**, and applying it anyway would quietly destroy them.

`CP1/BP_OSPlayerR` (in `test-uasset-parser.mjs`) and `test-s-b-base-differential.mjs` are not pinning counts for convenience. They run a **differential**: parser output versus a golden JSON produced by `UDumpBPGraphCommandlet`, matched **by node GUID**, comparing per-pin link resolution. The golden file is the independent source of truth — UE's own `LoadObject<UBlueprint>` walking every authored graph.

Loosen those assertions and there is no comparison left. The test becomes a tautology.

## Current state

`BP_OSPlayerR` grew from **210 to 309** graph-node exports. The committed oracle describes the 210-node Blueprint, so it is a snapshot of a different asset — not a stale number to bump. Two freshness markers report this and skip the exact assertions (D187 behaviour, exit stays green).

Coverage currently switched off:

| Test | Marker | What is not running |
|---|---|---|
| `test-uasset-parser.mjs` | `CP1/BP_OSPlayerR` | pin-block ↔ oracle GUID match, per-node pin-count containment |
| `test-s-b-base-differential.mjs` | `BP_OSPlayerR` | full edge-topology differential (ID-match on every edge) |

**Corrected 2026-08-27**: this table said the other four fixtures "still pass".
`TestCharacter` no longer exists in the project at all — deleted, not moved — and
both suites now skip it with a label. `BP_OSPlayerR` has also drifted further
since this was written (309 → 313 nodes, 608 → 846 edges). Only
`BP_OSPlayerR_Child`, `_Child1` and `_Child2` still run.

Both are exactly the recurrence this document predicted, and both are now
covered by the engine fixtures rather than by refreshing these.

## The trap to avoid

**Never regenerate a golden from our own parser.** The oracle exists to catch parser regressions; recording what the parser currently emits makes it self-confirming and converts a regression detector into a rubber stamp. Regeneration must come from the commandlet, which is why every refresh so far (D187, D188) ran `UnrealEditor-Cmd.exe -run=DumpBPGraph`.

This is the single most important constraint in this document.

## Options

### A — Refresh the oracle from the commandlet (tactical)

Re-run `DumpBPGraph` against the current `BP_OSPlayerR`, commit the regenerated JSON, update the expected node count. Precedent: D187 refreshed the same fixture at 600→608 edges / 205→210 nodes; D188 repeated it after a content reorg.

Restores coverage in roughly one session. Guarantees recurrence: this is the third drift event on this asset (D71, D187, now). Each cycle costs a session and, in between, the coverage is off.

### B — Migrate to engine-stable Blueprints (T-1c)

Regenerate the Oracle-A corpus against Blueprints under `Engine/Content`, which are stable within a UE point release and identical on every machine. Removes project coupling permanently and makes the differential runnable by contributors with no project access.

T-1 defers this as "larger", and flags the real cost: engine sample Blueprints are simpler than a production character, so some real-world complexity — deep collapsed graphs, delegate-signature graphs, macro expansion — may be lost. That complexity is part of why the fixture is valuable.

### C — Commit a frozen copy of the Blueprint

Not viable. This repository is public and the source project is NDA-protected. Ruled out on those grounds, not technical ones.

### D — Split the corpus (recommended)

Treat the two roles separately, because they are separate:

1. **Portable core** — one or two `Engine/Content` Blueprints as engine-stable fixtures, exercising the differential end to end: GUID matching, pin resolution, edge emission. Runs everywhere, never drifts, and is the ship gate.
2. **Complexity witness** — keep one production Blueprint as an explicitly dev-time fixture, marked as such, refreshed only when someone is already doing commandlet work. Its drift stays a non-strict marker and never gates.

This matches T-1's own tiering (*synthetic / engine-stable / project-specific, the last being "dev-time sanity only, not ship-gate"*) and stops the recurring cost without discarding real-world coverage.

## Recommended sequence

1. **Pick the engine Blueprint.** Survey `Engine/Content` for a Blueprint with more than one graph, at least one collapsed node, and a delegate binding. If none has enough shape, record that finding — it is the argument for keeping a complexity witness.
2. **Generate its oracle** with `DumpBPGraph`, exactly as the project fixtures were produced.
3. **Add it as a portable fixture** alongside the existing ones; the differential already iterates a fixture list, so this is additive and low risk.
4. **Re-tier the production fixture**: mark it dev-time, keep its freshness marker non-gating, and note in the fixture README that it refreshes opportunistically rather than on a schedule.
5. **Only then** decide whether to refresh `BP_OSPlayerR` (option A) — with a portable fixture in place, that refresh becomes optional rather than load-bearing.

## Cost and trigger

T-1 estimates T-1c as larger than T-1b and defers it pending pressure. The pressure now exists: three drift events on one asset, and coverage currently off.

Estimate: **1 session** for steps 1–3 (survey, generate, wire in an additive fixture), **~0.5** for steps 4–5. Materially less than T-1's T-1c framing, because this proposal does not regenerate the whole corpus — it adds a portable fixture beside it.

**Do not start** without an editor able to run `UnrealEditor-Cmd.exe -run=DumpBPGraph`. Every step that matters depends on the commandlet, and the one shortcut available — regenerating from our own parser — is the one that must never be taken.
