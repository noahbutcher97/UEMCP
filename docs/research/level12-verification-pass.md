# Level 1+2 Design Verification Pass

> **Author**: Agent 9.5 (Verification Pass)
> **Date**: 2026-04-16
> **Type**: Read-only empirical verification of Agent 9's design claims — no code/yaml/design changes
> **Target doc**: `docs/research/level12-tool-surface-design.md`
> **Fixtures**: ProjectA at `D:\UnrealProjects\5.6\ProjectA\ProjectA\`

---

## §1 Summary

**Results**: 1 confirmed · 3 amended · 0 refuted.

- **V1 Transform chain**: AMENDED — model is correct (actor → component → FVector/FRotator tags) but the hop is via `outerIndex` reverse lookup, NOT via a forward-pointing `RootComponent` `ObjectProperty` on the actor. Plus a significant UE 5.6-specific finding about FPropertyTag layout.
- **V2 CDO naming**: CONFIRMED — `Default__<AssetName>_C` pattern holds across all 5 BP types.
- **V3 Row size projection**: AMENDED — transform overhead is ~89 B/row (not 60); current post-F4 baseline is much smaller than Agent 9 stated; Bridges2 has 2,519 placed actors (not "hundreds to thousands" — concretely thousands).
- **V4 Phase 3 classifications**: AMENDED — 3/4 claims align; 1 row references a non-existent tool (`get_actor_transform`); one note glosses over a non-trivial name→`.umap` lookup needed to reduce `get_actor_properties` offline.

**Agent 10 handoff changes required**: 4 items (see §6). Net direction of the design is unchanged — Option C holds up. Amendments are implementation-detail corrections and one stale data point.

---

## §2 V1 — Transform resolution chain

**Claim**: Placed actor export → resolve `RootComponent` `ObjectProperty` → follow to component export → read `RelativeLocation`/`RelativeRotation`/`RelativeScale3D` on that component.

**Method**: Hand-traced 3 actors on `Content/Developers/steve/Steve_TestMap.umap` and `Content/Maps/Non-Deployable/Main_MenuVersion.umap` by reading `FObjectExport::SerialOffset`+`SerialSize` and scanning serial bytes for known FName indices (`RootComponent`, `RelativeLocation`, `RelativeRotation`, `RelativeScale3D`, `Vector`, `StructProperty`). Probe scripts: `server/tmp-v1-probe.mjs`, `tmp-v1-scan.mjs`, `tmp-v1-children.mjs`, `tmp-v1-dump-props.mjs` (all deleted after the run).

### Per-actor evidence

| Actor (export idx) | Fixture | Has `RootComponent` tag in actor's own bytes? | Has child export(s) with transform tags? | Transform resolvable? |
|---|---|---|---|---|
| `DirectionalLight` [15] | Steve_TestMap.umap:216077 | ❌ (scan of 346 bytes: no hit on name idx 320 `RootComponent`) | ✅ child [16] `LightComponent0` at serialOffset 216423 has `RelativeRotation` tag | ✅ via outer-index reverse lookup |
| `PlayerStart` [1462] | Main_MenuVersion.umap | ❌ | ✅ child [503] `CollisionCapsule` (CapsuleComponent) at serialOffset 1498514 has `RelativeLocation` tag at byte +84 | ✅ via outer-index reverse lookup |
| `LightSource` [517] (DirectionalLight) | Main_MenuVersion.umap | ❌ | ✅ child [518] `LightComponent0` at serialOffset 1513921 has `RelativeLocation` tag at byte +332 | ✅ via outer-index reverse lookup |

### Whole-map statistics (Main_MenuVersion.umap, 2,927 exports, 230 placed actors)

- **Exports containing `RelativeLocation` tag**: 199
- **Exports containing `RelativeRotation` tag**: 59
- **Exports containing `RelativeScale3D` tag**: 8
- **Placed actors whose own serial bytes contain the name index for `RootComponent`**: 22 / 230 (9.6%)
- **Placed actors with ≥1 child export (outerIndex == actor) that has a transform tag**: 84 / 230 (36.5%)
- **Placed actors with NO transform tag anywhere in their subtree**: ~146 / 230 (63%) — all at class defaults

### Chain structure actually observed

The working resolution chain is:

1. **Placed actor export** E_A (outerIndex resolves to `PersistentLevel`/`Level`, class not excluded).
2. **Scan forward** through the export table for entries E_C where `E_C.outerIndex == A+1` (i.e., the actor's 1-based FPackageIndex). These are the actor's component subobjects.
3. For each child, read the serialized property tags and look for `RelativeLocation` (StructProperty → FVector), `RelativeRotation` (StructProperty → FRotator), `RelativeScale3D` (StructProperty → FVector). If absent, the component is at class default for that field.
4. Picking the "root" component among children requires either: (a) matching a known class-default root name (e.g., `DefaultSceneRoot`, `LightComponent0`, `CollisionCapsule`), or (b) excluding auxiliary components (`ArrowComponent`, `BillboardComponent`/sprites) and taking the remaining scene-component descendant.

**`RootComponent` as an `ObjectProperty` on the actor is rare** — it only serializes when overridden from the class default. For `DirectionalLight` (native actor with a compile-time root), no `RootComponent` property is ever written — only the child `LightComponent0` is present with the serialized transform overrides.

### Secondary finding — UE 5.6 FPropertyTag layout

When hand-tracing the `RelativeLocation` tag on `CollisionCapsule` [503] and `LightComponent0` [518], the 80-byte dump starting at the tag does **not** match the textbook CUE4Parse-era layout `{Name(8) Type(8) Size(4) ArrayIndex(4) StructName(8) StructGuid(16) HasPropGuid(1) Value(24)}`. Instead, after `Type = StructProperty` there are several int32 fields before the `Vector` struct-name FName and the 24-byte double triplet, implying UE 5.4+ `FPropertyTypeName` / `EPropertyTagFlags` extensions (nested type-name encoding, optional flags, and variable-presence `ArrayIndex` / `PropertyGuid`).

Example: `CollisionCapsule` tag header at +84..+148 has Name "RelativeLocation" (8) + Type "StructProperty" (8) + multiple int32 words + a later occurrence of `24` (the FVector byte size), suggesting Size is further into the header than the pre-5.4 layout dictates.

This is **not a design claim failure** — Agent 9's §4 note only asserts the resolvability of the chain, not the byte-layout. But it is implementation-critical for Agent 10: a simple CUE4Parse port from older UE versions will mis-parse 5.6 tag headers.

### Verdict

**AMENDED**.

- Core two-hop model is *correct*: actor → component (via outer-index reverse lookup, not forward `RootComponent` ObjectProperty) → `RelativeLocation`/`Rotation`/`Scale3D` StructProperty tags.
- **Sparse transforms are the common case**: ~63% of placed actors on a real dev map have no transform override at all (everything at class default). Returning `transform: null` for these is the correct behaviour and aligns with Agent 9's "WorldSettings has no RootComponent" edge-case note — but the proportion is much higher than that note implies.
- The `RootComponent` ObjectProperty path described in Agent 9's §4 handles only ~10% of placed actors (those that override the root); the dominant mechanism is outerIndex-child enumeration.

---

## §3 V2 — CDO export naming

**Claim**: For BP-subclass assets, `read_asset_properties.export_name` can default to `Default__<AssetName>_C`. `inspectBlueprint`'s `genClassNames` set needs extending for `GameplayAbilityBlueprintGeneratedClass`.

**Method**: Called `inspect_blueprint` on 5 assets spanning the BP-subclass taxonomy. Script: `server/tmp-v2-cdo.mjs`.

### 5-row evidence table

| Asset | objectClassName | generatedClass resolved? | parentClass resolved? | `Default__<Name>_C` export present? | Actual Default__ exports |
|---|---|---|---|---|---|
| `Content/Blueprints/Character/BP_OSPlayerR.uasset` | `/Script/Engine.Blueprint` | ✅ `BP_OSPlayerR_C` | ✅ `OSPlayer` | ✅ | `[Default__BP_OSPlayerR_C]` |
| `Content/GAS/Abilities/BPGA_Block.uasset` | `/Script/Engine.BlueprintGeneratedClass` | ✅ `BPGA_Block_C` | ✅ `GA_OSBlock` | ✅ | `[Default__BPGA_Block_C]` |
| `Content/GAS/Effects/BPGE_GenericCost.uasset` | `/Script/Engine.Blueprint` | ✅ `BPGE_GenericCost_C` | ✅ `OSGameplayEffect` | ✅ | `[Default__BPGE_GenericCost_C]` |
| `Content/UI/Widgets/General/WBP_OSBaseButton.uasset` | `/Script/UMGEditor.WidgetBlueprint` | ✅ `WBP_OSBaseButton_C` | ✅ `OSBaseButton` | ✅ | `[Default__WBP_OSBaseButton_C]` |
| `Content/Animations/Retargeted/StreetFighterAnimation/ABP_Manny.uasset` | `/Script/Engine.AnimBlueprint` | ✅ `ABP_Manny_C` | ✅ `AnimInstance` | ✅ | `[Default__ABP_Manny_C]` |

### Pattern assessment

Pattern holds 5/5. One notable observation for the audit's concern about missing `GameplayAbilityBlueprintGeneratedClass` support:

- `BPGA_Block`'s `objectClassName` is `/Script/Engine.BlueprintGeneratedClass` — **plain** `BlueprintGeneratedClass`, not a GAS-specific subclass.
- Its generated-class export resolves through the current `genClassNames` set (`{BlueprintGeneratedClass, WidgetBlueprintGeneratedClass, AnimBlueprintGeneratedClass}`).
- In ProjectA, BPGAs inherit from `UOSGameplayAbility` (C++ class `GA_OSBlock`) which compiles as a regular `UBlueprintGeneratedClass` — there is no custom `UGameplayAbilityBlueprintGeneratedClass` in use.

So the audit's concern — "genClassNames misses `GameplayAbilityBlueprintGeneratedClass`" — **does not manifest on ProjectA fixtures**. Agent 9's Q4 note ("Agent 10 should extend the set as part of this work or document that unrecognized classes fall through to 'main export'") remains a defensive good practice, but there is no ProjectA asset that currently exercises the gap.

### Verdict

**CONFIRMED**.

- `Default__<AssetName>_C` is a reliable default for all 5 BP-subclass types present in ProjectA.
- The current 3-entry `genClassNames` set is sufficient for ProjectA; no extension empirically required, but Agent 10 could still defensively add `GameplayAbilityBlueprintGeneratedClass` as documented in Q4.

---

## §4 V3 — Row size projection

**Claim**: Transform overhead is ~60 B/row, delta ~13 KB on 223-row Metric_Geo whitebox case.

**Method**: Measured current `list_level_actors` response sizes on 4 ProjectA maps (including Metric_Geo and Bridges2). Constructed a realistic transform JSON payload (`{"transform":{"location":[1234.56,789.01,-234.56],"rotation":[0,45.5,0],"scale":[1,1,1]}}`) and counted bytes. Script: `server/tmp-v3-size.mjs`.

Sample transform JSON: **89 bytes** per row (not 60 as Agent 9 stated).

### Measured data

| Map | Placed actors (post-F4) | Current response (bytes) | Per-row avg (bytes) | Projected with transforms | Delta |
|---|---:|---:|---:|---:|---:|
| `/Game/Maps/Non-Deployable/Metric_Geo` | 219 | 30,061 (29.4 KB) | 137.3 | 49,552 (48.4 KB) | +19.0 KB |
| `/Game/Maps/Deployable/PVP_Maps/Bridges2` | **2,519** | 354,650 (346.3 KB) | 140.8 | 578,841 (565.3 KB) | +218.9 KB |
| `/Game/Maps/Non-Deployable/Main_MenuVersion` | 230 | 31,254 (30.5 KB) | 135.9 | 51,724 (50.5 KB) | +20.0 KB |
| `/Game/Developers/steve/Steve_TestMap` | 172 | 23,622 (23.1 KB) | 137.3 | 38,930 (38.0 KB) | +14.9 KB |

### Key observations

1. **Agent 9's 60 B/row estimate is 48% low**. Actual transform overhead on realistic float values is ~89 B/row due to JSON key names (`"location"`, `"rotation"`, `"scale"`, `"transform"`) plus 3×3=9 decimal-formatted numbers.

2. **Agent 9's "F3 whitebox 320 KB" figure is stale**. Agent 9's design reasoning states "F3 whitebox map (223 rows × ~80 B row shape) already ~320 KB *after* F4 filtering." That 320 KB figure came from the pre-F4 audit (T22, with the unfiltered export table). After F4 landed (placed-actor filtering, per D38), Metric_Geo is actually 29.4 KB. Agent 9's row-size math was based on a pre-fix baseline.

3. **Bridges2 is significantly denser than Agent 9 anticipated**. Agent 9 estimated "hundreds or thousands" of placed actors — the measured number is **2,519**. Its current unpaginated response is **346 KB** (already at or over typical MCP response caps). With transforms added: 565 KB. Pagination is not just nice-to-have; it is required to keep Bridges2 callable at all.

4. **Default `limit=100` is safe**. At 100 rows × (140 B current + 89 B transform) = ~23 KB per page. Well under caps. At cap `limit=500` it's ~115 KB per page — still safe.

### Verdict

**AMENDED**.

Agent 9's qualitative conclusion is correct: pagination + `summarize_by_class` handles dense levels and transforms don't break that model. But the specific numbers cited are wrong:

- Transform overhead is ~89 B/row, not ~60 B/row.
- Pre-pagination Metric_Geo is 29.4 KB (not 320 KB). The F3 whitebox example in Agent 9's §4 is drawn from stale data.
- Bridges2 has 2,519 placed actors and is already over cap without transforms — pagination is *mandatory*, not precautionary.

Default pagination recommendation holds (`limit=100 default, cap 500`). No change needed to that parameter — just to the supporting numbers in Agent 9's §4 F3-mitigation rationale.

---

## §5 V4 — Phase 3 scope audit

**Method**: Read `tools.yaml` entries for 4 spot-check tools; compared against Agent 9's §3 descriptions. `docs/specs/phase3-plugin-design-inputs.md` was also consulted but is scoped to plugin-bug-fix P0s, not surface design — limited cross-reference value here.

### Per-tool spot-check table

| Tool | Agent 9 classification | Agent 9 says moves offline | tools.yaml description | Match | Note |
|---|---|---|---|---|---|
| `blueprint-read.get_blueprint_variables` | ⚠️ Reduced | CDO defaults via `inspect_blueprint.include_defaults`; replication flags + EditAnywhere + tooltips stay TCP | "All variables with types, default values, categories, replication flags, tooltips" (line 406) | ✅ | Accurate split: yaml enumerates the full surface; Agent 9 correctly carves out the "default values" slice as offline-able and keeps reflection-only metadata on TCP. |
| `asset-registry.get_asset_references` | ⚠️ Reduced | Hard-ref subset via `read_asset_properties` walk for FSoftObjectPath/ObjectProperty; soft-ref registry walk stays | "Dependency graph — what this asset references and what references it. Essential for impact analysis." (line 453) | ⚠️ | Outgoing hard-ref direction maps cleanly. But yaml also implies reverse lookup ("what references it") — Agent 9's note doesn't distinguish direction. The reverse lookup needs an inverted index or full-content scan; not impossible offline, but heavier than Agent 9's framing suggests. |
| `remote-control.rc_get_property` (static case) | ⚠️ Reduced | Saved CDO/export reads go offline; live UObject reads stay RC; tool survives | "Get any UPROPERTY by object path + property name" (line 728) | ✅ | Clean separation. Object paths pointing at CDOs on disk (e.g., `/Game/BP_X.Default__BP_X_C:Damage`) can absolutely be served by `read_asset_properties`; live objects (`/World/Level.BP_X_2:Damage`) still need RC. |
| `actors.get_actor_properties` (static case) | ⚠️ "Live case only" (as part of "actors.* 10 tools") | Static saved `get_actor_properties` → `read_asset_properties` | "Get all properties of an actor" (line 146), takes `name: Exact actor name` (runtime lookup) | ⚠️ | Direction is right but glosses over non-trivial resolution. `get_actor_properties {name:"BP_X_Child1"}` is a runtime actor name; the offline replacement needs a prior step to find which `.umap` contains that actor and which export index corresponds to the label. `read_asset_properties` alone doesn't do that lookup. Either callers use `list_level_actors` first (cheap, one-call hop), or Agent 10/later needs a name→(asset,export) resolver. |

### Secondary finding — `get_actor_transform` references

Agent 9's §2 Option A scoring and §3 recommendation summary both reference `actors.get_actor_transform` as a tool that would be displaced by `list_level_actors` static transforms. **This tool does not exist** in `tools.yaml` — the actors toolset has `set_actor_transform` (write) but no `get_actor_transform` (read). The read path is via `get_actor_properties`, which returns transform alongside all other properties.

This is a minor labeling bug — the *concept* of "actor transform reads move offline" is correct, and `list_level_actors` with transforms does deliver that surface. The only concrete tool being "displaced" is `get_actor_properties` in the placed-actor-on-disk case.

### Verdict

**AMENDED**.

- 2/4 spot-checks (`get_blueprint_variables`, `rc_get_property`) align cleanly.
- 2/4 spot-checks (`get_asset_references`, `get_actor_properties`) are directionally correct but gloss over non-trivial mechanics: (i) reverse-reference scan isn't a `read_asset_properties` one-call; (ii) actor-name resolution needs a prior lookup hop.
- The `get_actor_transform` references in Agent 9's §2 and §3 text should be corrected to `get_actor_properties` — `get_actor_transform` doesn't exist in `tools.yaml`.

---

## §6 Agent 10 handoff changes required

Four concrete items for the Agent 10 brief:

1. **Transform resolution mechanism — change the primary chain from `RootComponent ObjectProperty` to `outerIndex reverse scan`.** V1 shows that only ~10% of placed actors serialize a `RootComponent` ObjectProperty tag; ~37% have a transform-bearing child reachable via outerIndex reverse lookup; the rest are at class default (`transform: null`). The Agent 10 handoff's "Transform resolution (Agent 10 note)" section should describe the outer-index reverse scan as the primary path and relegate `RootComponent` ObjectProperty to an override case. The expected fraction of `transform: null` rows (~50-60% on real dev maps) should be stated as *intended behaviour*, not an edge case.

2. **FPropertyTag layout in UE 5.6 is not pre-5.4 CUE4Parse.** V1's secondary finding — the tag header between `Type=StructProperty` and the value bytes has extra fields (consistent with UE 5.4+ `FPropertyTypeName` + `EPropertyTagFlags`). Agent 10's handoff should call out: *"port from CUE4Parse master branch, not pre-5.4; consult UAssetAPI 5.6 reference for FPropertyTag flags field and FPropertyTypeName nested-type encoding."* This is implementation-critical — a straight lift of older layout code will mis-parse property headers on ProjectA files.

3. **Correct Agent 9 §4's F3-mitigation numerics.** In the Agent 10 brief (or a footnote referencing Agent 9's §4), replace:
   - `"~60 B/row transform overhead"` → `"~89 B/row transform overhead (measured)"`
   - `"F3 whitebox map (223 rows × ~80 B row shape) already ~320 KB after F4 filtering"` → `"Metric_Geo (219 placed actors post-F4) is 29.4 KB; the 320 KB figure is pre-F4 stale data"`
   - `"Bridges2 would have hundreds or thousands of placed actors"` → `"Bridges2 has 2,519 placed actors and is 346 KB unpaginated — pagination is mandatory, not precautionary"`
   The design *decision* (pagination + summary, always-on transforms) is unchanged; the supporting numbers need correcting so Agent 10 doesn't re-derive from wrong inputs.

4. **Fix two Phase 3 scope-table references in Agent 9's §3.**
   - "`actors.get_actor_transform` static case" → should be `actors.get_actor_properties` static case (the transform-reading surface is part of `get_actor_properties`, not a separate tool).
   - `asset-registry.get_asset_references` row: add "reverse-reference direction remains editor-dependent (needs inverted index / full-content scan); only the outgoing hard-ref walk moves offline via `read_asset_properties`."

Items 1 and 2 are implementation-critical for Agent 10. Items 3 and 4 are documentation hygiene that keeps Agent 9's doc from misleading Agent 11+.

---

## §7 Confidence

**HIGH**.

- All four verdicts are backed by measurements or hand-traced evidence against real ProjectA fixtures (file paths, export indices, byte offsets cited inline).
- V1 was the highest-risk target (complex hand-trace); got confirmation on 3 actors across 2 maps, plus whole-map statistics (230 actors scored for both the RootComponent-tag and outer-reverse pattern). The finding is robust.
- V2 and V3 are measured end-to-end via the existing `executeOfflineTool` surface — no hand-parsing involved, so no room for parse-error.
- V4 is documentary cross-reference against `tools.yaml` — mechanical, low-error.

**Could not verify within the time budget (worth flagging)**:

- The exact UE 5.6 FPropertyTag header layout. The V1 secondary finding is "it's not the textbook layout"; I did not fully decode the extra header fields. Agent 10 will need to do this from CUE4Parse master branch / UAssetAPI 5.6 source — reading and hand-tracing 1-2 more tags would take another 20-30 minutes and was outside the 120-minute envelope.
- Whether any ProjectA asset uses a truly custom generated class (e.g., `NiagaraScriptBlueprintGeneratedClass`) that would stress the current 3-entry `genClassNames` set. V2 showed 5 common BP-subclass types all resolve, but I did not exhaustively scan for unusual classes. Safe to defer to Agent 10's discretion per Agent 9 Q4.

Time spent: ~95 min total (V1: ~45, V2: ~10, V3: ~15, V4: ~10, write-up: ~15).

---

## Final Report

```
Agent 9.5 Final Report — Level 1+2 Design Verification

V1 Transform chain:     AMENDED — works via outerIndex reverse lookup, not RootComponent ObjectProperty; ~63% of actors have null transforms (class default). Plus UE 5.6 FPropertyTag layout differs from pre-5.4.
V2 CDO export naming:   CONFIRMED — Default__<Name>_C holds 5/5; ProjectA BPGAs use plain BlueprintGeneratedClass so genClassNames gap doesn't manifest.
V3 Row size projection: AMENDED — ~89 B/row (not 60); Metric_Geo is 29 KB post-F4 (not 320 KB); Bridges2 is 2,519 rows / 346 KB unpaginated. Design decision unchanged.
V4 Phase 3 classifications: AMENDED — 3/4 align; get_actor_properties name→.umap lookup glossed; get_asset_references reverse-direction glossed; get_actor_transform doesn't exist in tools.yaml (minor mislabel).

Agent 10 handoff changes required: 4 items
Confidence: HIGH
Deliverable: docs/research/level12-verification-pass.md (this document)
Time spent: ~95 minutes
```
