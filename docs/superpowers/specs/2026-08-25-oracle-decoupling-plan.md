# Decoupling the commandlet oracles from a live project

**Date**: 2026-08-25
**Status**: Scheduled, not implemented
**Relates to**: backlog T-1 (fixture philosophy), T-1c (Oracle-A v3), D187 (freshness gate), D188 (discovery migration)

## Why this is scheduled separately

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

The other four fixtures in the differential (`BP_OSPlayerR_Child`, `_Child1`, `_Child2`, `TestCharacter`) still pass — only the parent Blueprint drifted.

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
