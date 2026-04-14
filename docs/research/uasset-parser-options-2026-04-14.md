# `.uasset` Header Parser — Options & Recommendation

**Date**: 2026-04-14
**Author**: Agent 3 (Track 2c)
**Decision needed from**: Noah
**Blocks**: Track 2a items 1 (`query_asset_registry`), 3 (`inspect_blueprint`), 4 (`list_level_actors`)

## What we need

Per Amendment A on audit §7.2, `query_asset_registry` extracts asset metadata by scanning `.uasset` / `.umap` headers directly rather than parsing `DevelopmentAssetRegistry.bin` (which ProjectB has never cooked and ProjectA's was 6 days stale).

Minimum data extraction surface:

1. `FPackageFileSummary` — tag, versions, NameCount/NameOffset, ExportCount/ExportOffset, ImportCount/ImportOffset, **AssetRegistryDataOffset**, TotalHeaderSize, WorldTileInfoDataOffset (for end-of-block calc).
2. **Name table** — FName entries (FString with optional hash tail depending on version flags).
3. **Export table** — class FName index, object name FName index, outer index, so we can resolve `{class, objectPath}` for `inspect_blueprint` / `list_level_actors`.
4. **FAssetRegistryData block** — for each asset: `ObjectPath` (fstring), `ObjectClassName` (fstring), `Tags[]` of `{Key: fstring, Value: fstring}`. This is where `ParentClass`, `ImplementedInterfaces`, dependencies, etc. live.

Explicit non-goals: property-system deserialization, asset body, PIE-only data, soft object paths, thumbnails, bulk data, preload dependencies. Those are all orthogonal to registry-style queries.

Target: UE 5.6. ProjectB is 5.7, which for package format is a negligible delta (same summary layout; custom version numbers differ but we don't validate against them for read-only metadata).

## Option A — Vendor `blueprintue/uasset-reader-js`

Repository: https://github.com/blueprintue/uasset-reader-js

| Signal | Value |
|---|---|
| License | MIT |
| Stars | 172 |
| Last push | 2026-04-13 (1 day before this doc) |
| Runtime deps | **zero** |
| ES module | yes (`"type": "module"`) |
| Published to npm | **no** — GitHub-only |
| Total LOC | ~1150 (`src/js/main.js`) |
| AssetRegistryData coverage | **yes** — `readAssetRegistryData()` emits `{ObjectPath, ObjectClassName, Tags[{Key,Value}]}` exactly the shape we need |
| Name table | yes — `readNames()` with UE 5.0 source reference |
| Export/Import tables | yes |
| Engine target | UE 5.x explicitly; tests cover real samples |
| Node.js engine pin | **>=25.0.0** (package.json) |
| Test env | `jest --env=jsdom` — browser-oriented |
| API surface | `new ReaderUasset().analyze(Uint8Array)` writes `this.uasset.{header, assetRegistryData, exports, imports, ...}` |

**Pros**
- The tricky parts (fstring with UTF-16 negative-length encoding, custom version tables, conditional fields gated on LegacyFileVersion / FileVersionUE5) are already correct and tested.
- Active maintenance — not a 3-year-dead project.
- MIT + zero runtime deps means vendoring is a clean `cp src/js/main.js server/vendor/uasset-reader.js` plus a thin ESM wrapper.
- Parses exactly the block we care about with the exact shape we want.

**Cons**
- **Not on npm.** Either vendor the single source file (preferred) or add a git dependency (flaky on Windows/P4). No semver.
- **Browser-first packaging.** Uses `window.blueprintUE.uasset` namespace in the built output, and dev tooling leans on jsdom. The `src/js/main.js` source itself is environment-neutral — it operates on `Uint8Array` and is adaptable to Node with minor edits (remove browser-ish `addHexView` bookkeeping or leave it as inert overhead).
- **`engines.node: ">=25.0.0"`.** UEMCP has no Node pin today. Claude Desktop / Cowork users may be on 20-22 LTS. This is advisory (npm warns, doesn't block), but should be validated — the code itself uses no Node-25-only APIs I could spot.
- Carries ~750 LOC of features we don't need (searchable names, gatherable text, thumbnail table, chunk IDs, world tile info, preload dependencies, import type hierarchies). Dead code, but adds surface for bugs we don't care about.
- Vendoring pins us to a snapshot — upstream fixes require manual re-vendor. No security surface here (no network, no code-eval) so not dangerous.

**Effort to integrate**: 0.5–1 day. Copy `src/js/main.js` into `server/vendor/`, strip the `window` / hex-view scaffolding if we want a lean build (or leave as-is for ~40 KB wasted parsing work), expose `ReaderUasset` via ESM `export`, write a narrow `parseAssetHeader(bytes) → {class, objectPath, tags, dependencies}` adapter.

## Option B — Hand-write a minimal reader

Reference source (UE 5.6 install, if present at `C:\Program Files\Epic Games\UE_5.6\Engine\Source\...`):
- `Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp` — serialize layout
- `Runtime/AssetRegistry/Private/AssetRegistryState.cpp` — FAssetRegistryData tag block
- `Runtime/Core/Private/UObject/UnrealNames.cpp` — FName + FString encoding
- Python format specs (read-only reference, not runnable from Node): `CUE4Parse` (https://github.com/FabianFG/CUE4Parse), `UAssetAPI` (https://github.com/atenfyr/UAssetAPI)

**Rough LOC estimate** (Node, snake-case free function style, no hex-view debug):

| Piece | Est. LOC |
|---|---|
| Byte reader primitives (`readInt32LE`, `readInt64LE`, `readFString` incl. UTF-16 negative-length case, `readFGuid`) | ~80 |
| `FPackageFileSummary` (version-gated fields: LegacyFileVersion, UE4/UE5 versions, CustomVersions[], Generations[], etc.) | ~120 |
| Name table walker | ~30 |
| Export table walker (enough for class FName + object name FName + outer index resolution) | ~50 |
| Import table walker (needed to resolve native parent classes referenced by exports) | ~40 |
| FAssetRegistryData block reader | ~40 |
| Top-level `parseAssetHeader()` glue + error handling | ~40 |
| **Total** | **~400 LOC** |

This is a narrow reader — it reads only offsets/sizes we care about and never seeks into property bodies, bulk data, or preload dependency arrays.

**Pros**
- Full control, matches our code standards (snake_case for offline tool params, ESM, JSDoc).
- Zero supply-chain surface. No engines pin, no transitive risk.
- ~400 LOC is maintainable by a single developer; any future UE version delta is a scoped edit.
- No dead features — every line serves a registry query.

**Cons**
- **Format footguns.** `FString` with negative length = UTF-16 (including the terminator length calc). `FName` serialization changed between UE4 and UE5. Custom version tables are optional and gate subsequent field reads. Getting these wrong produces silent offset drift that surfaces as garbage strings downstream.
- **Estimated ~3–4 days** for initial implementation + test harness against real assets from ProjectA and ProjectB, vs. 0.5–1 day for Option A.
- No prior-art tests; we're writing both the parser and the tests that validate it. Option A has an existing jest suite we could port or reference.
- Risk that we miss a UE 5.7 delta (ProjectB) that blueprintue has already absorbed.

## Option C — Hybrid (deferred for now)

Vendor a stripped-down Option A (drop searchable names, gatherable text, thumbnails, chunk IDs, world tile info, preload deps) to get to ~400–500 LOC of maintained-by-us code seeded with known-correct byte reads. Combines Option A's correctness with Option B's leanness. Noted as a post-landing refactor if Option A ships first — not a from-scratch choice.

## Recommendation

**Option A — vendor `blueprintue/uasset-reader-js` source into `server/vendor/uasset-reader.js`.**

Rationale:
1. The fstring/custom-version/name-table minefield is already survived. Hand-writing those for the first time costs us 3 days and still produces higher bug risk than code that's been running against real UE 5 assets in production (the blueprintUE.com site).
2. MIT + zero runtime deps + single source file = vendoring is trivial and the supply-chain surface is "did we inspect the file we copied." Yes, once.
3. Landing `query_asset_registry` fast unblocks five capabilities (`search_assets`, `get_class_hierarchy`, `get_asset_references`, `get_asset_dependencies`, `find_blueprints_implementing_interface`) that are currently TCP-only. Every day Option B takes is a day those stay gated behind a running editor.
4. The Node 25 engines pin is advisory and no feature in the code I inspected requires it — we'll verify on Node 20/22 during integration. If a real incompatibility surfaces, it's a localized fix.

**Proposed integration plan post-sign-off**:
1. Copy `src/js/main.js` (commit `main@<sha>`) to `server/vendor/uasset-reader.js` with a header comment citing source + license.
2. Append a small ESM export block: `export { ReaderUasset };` (the source defines it on `window.blueprintUE.uasset` via a trailing IIFE that we can neutralize).
3. Add `server/offline-parsers.mjs` — thin adapter: `async function parseAssetHeader(filePath) → {class, objectPath, tags: Map, dependencies: string[]}`. Handles file read + `new ReaderUasset().analyze(bytes)` + post-processing.
4. Sanity-test against 5 real samples (3 from ProjectA, 2 from ProjectB — Blueprint, material, sound, umap, data asset) with expected class names / parent classes checked into a fixture.
5. Proceed to `query_asset_registry` (Track 2a item 1), then `inspect_blueprint` + `list_level_actors` (items 3/4).

**If the recommendation is rejected** in favor of Option B, budget 3–4 days and plan a dedicated parser test suite pass with real-asset fixtures before any `query_asset_registry` work.

## Do not proceed without explicit sign-off

Per handoff: "Noah decides after reading — do not implement either option without sign-off." Track 2a item 2 (DataTable/StringTable source readers) proceeds in parallel; Track 2b D31 cleanup also proceeds — neither depends on this decision.
