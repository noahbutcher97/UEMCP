# Owned registry scan budget and cache

This additive unit qualifies bounded scanner/cache behavior using the existing owned UE5.6 package. It does not replace the consumer registry suite or establish equivalence for consumer scale, performance, class assumptions, old saved formats, or native behavior.

From `server/`:

```powershell
node run-rotation.mjs --test-profile owned-registry-budget-cache --json
```

The profile requires all 23 named cases from `test-owned-registry-budget-cache.mjs`. Run it with project variables cleared, an invalid ambient root with attachment mode unset, and an invalid root with explicit env attachment mode. It always supplies its own scratch root to the actual `executeOfflineTool('query_asset_registry', ...)`; it never consults ambient configuration to select test data. A missing/corrupt corpus, missing case, skip, duplicate case or execution error is not success.

## Inputs and boundaries

The suite validates the immutable `ue5.6-owned-v1` manifest, asset bytes and independent topology oracle, plus the authoring-source hash and authored Blueprint class/type. It creates explicitly enumerated four-, five-, and six-file Content subdirectories in guarded temporary scratch. A second six-file layout checks project-root cache separation: at most 21 copied packages, each verified byte-for-byte against the single owned package. The suite resets the process-local cache between cases and removes only its guarded scratch directory in `finally`.

These are disk-path scanner fixtures. All copies deliberately retain the same internal `/Game/Serialization/BP_OwnedLink` package identity, object name and Blueprint primary class. Renamed disk paths are not independently authored Unreal assets. The response comparator enforces this distinction and rejects a fabricated internal identity derived from a copy's filename.

The existing source computes `hitMaxScan = files.length >= maxScan`. Thus a cap of five yields:

| Layout | Scanned / matched / returned | `truncated` |
| --- | --- | --- |
| Four matching files | 4 / 4 / 4 | false |
| Exactly five matching files | 5 / 5 / 5 | true |
| Six matching files | 5 / 5 / 5 | true |

The exact-cap result conservatively reports that the budget was reached; it does not prove more files exist. For the over-cap case the suite requires five unique paths from the explicit six-file inventory without imposing an undocumented filesystem enumeration order. Uncapped cases require every exact authored disk path.

Additional witnesses separate result pagination from scanning: a result limit of two still scans/matches six and warms all six cache entries; an exact result limit of six below the scan cap returns all six without truncation; a scan cap of three with result limit two scans/matches three and returns two. No-match filters still parse/cache files. An exhausted offset clears pagination truncation only when the scan cap was not reached.

Cache witnesses require exact absolute paths, path/size/mtime/package metadata, cold population, warm entry/payload identity reuse, prefix scoping, and distinct keys for identical relative paths in different roots. Registry queries with a dirty index must reparse all scanned entries; a newer timestamp on one scratch copy must replace only that path's payload. Committed corpus bytes and every copied package remain unchanged after all queries.

Negative controls start from valid actual results/cache entries and alter only cloned responses or copied maps. They reject under/over scan counts, wrong truncation at the exact cap, dropped/duplicate/unowned result paths, confused result-limit counts, missing/extra/relative/foreign cache keys, and replaced warm payloads with equal values. No corpus or live cache payload is corrupted to manufacture a passing test.

## Retained obligations

Retain: partial. No production behavior, existing test, fixture or consumer assertion is removed or changed. `test-query-asset-registry.mjs` keeps its project prerequisite, populated-prefix/performance checks and BlueprintGeneratedClass assumptions. An invalid supplied consumer root still fails that prerequisite; this profile must not mask it or convert it into a skip. `test-owned-asset-registry.mjs` and `test-owned-asset-info.mjs` remain complementary witnesses and are run as regressions.

This maps the bounded remaining scan-cap/cache witnesses (R2/R3/R4 in the ambient inventory) and supplements the existing no-match scan witness R1. It does not qualify consumer diversity, large scans, timing, scanner ordering, new asset identities, native authoring, or an entire legacy suite. Recursive-subdirectory budget behavior and parameter extremes remain outside these witnesses. Registry-level same-mtime size changes, backward timestamps, parse errors, deletion eviction, TTL/performance, and TCP dirty-event propagation remain unqualified here; pointed asset-info tests are complementary, not proof of registry equivalence. There is no retirement, ledger completion, publication or merge approval.
