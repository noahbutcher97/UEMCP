# AUDIT-FIX-2 Worker — RC semantic delegates expansion + toCdoPath fix (F-4+F-5+F-6+F-7)

> **Dispatch**: Fresh Claude Code session. Parallel-safe with AUDIT-FIX-1 (plugin/UEMCP/*) + AUDIT-FIX-3 (server/offline-tools.mjs); this worker is `server/rc-tools.mjs` + `tools.yaml` only.
> **Type**: Implementation — expand 3 RC semantic delegates from single-function stubs to full-coverage implementations promised by yaml descriptions; fix `toCdoPath` helper.
> **Duration**: 0.5-1 session.
> **D-log anchors**: D79 audit findings F-4/F-5/F-6/F-7 (bundled as one batch), D66 (FA-ε verdict + D76 pragmatic simplification of PARTIAL-RC set).
> **Deliverable**: `get_curve_asset` / `get_mesh_info` / `list_material_parameters` cover the full UFUNCTION surface their yaml descriptions promise; `toCdoPath` correctly scopes non-class paths.

---

## Mission

Audit F-4/F-5/F-6 flagged 3 RC semantic delegates as placeholder stubs that pass wire-mock tests but under-deliver versus yaml description. Agent-visible correctness gap: agents call the tool expecting "curve asset full contents" and get FloatCurves only. F-7 is a related bug in `toCdoPath` affecting non-class-path scoping.

Four findings bundled because they all live in `server/rc-tools.mjs` + shared `toCdoPath` utility. One worker, one commit.

---

## Scope — in

### §1 Read audit §F-4 through §F-7

Authoritative scope: `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md` findings F-4, F-5, F-6, F-7. For each:
- Confirm current stub-coverage (grep in rc-tools.mjs for the delegate function).
- Confirm yaml-promised coverage (grep in tools.yaml for the tool's `description` + `returns` block).
- Identify the delta — which UFUNCTIONs / struct fields / properties the yaml claims but the delegate doesn't call.

### §2 get_curve_asset expansion (F-4)

Current coverage per audit: `FloatCurves` only. Per yaml description: should also cover `VectorCurves` + `ColorCurves`.

UE 5.6 `UCurveBase` API:
- `UCurveFloat::FloatCurves` (inherited) — single FRichCurve field
- `UCurveVector::FloatCurves[]` — 3 FRichCurves (X/Y/Z)
- `UCurveLinearColor::FloatCurves[]` — 4 FRichCurves (R/G/B/A)

Approach: dispatch based on asset's `UCurveBase` subclass. Each subclass has a different field name; yaml should document the discriminator.

**Gotcha per D78 pattern**: watch for 5.5→5.6 API drift if the delegate calls methods that were renamed. Check engine source before assuming method names.

### §3 get_mesh_info expansion (F-5)

Current coverage: `GetNumVertices` only. Per yaml: also `GetNumTriangles`, `GetBounds`, possibly material-slot count, LOD count.

UE 5.6 `UStaticMesh` BlueprintCallable UFUNCTIONs per FA-ε §Q1:
- `GetNumVertices(LODIndex=0)` ← current
- `GetNumTriangles(LODIndex=0)`
- `GetBounds()` (from AActor-ish pattern) OR via `UStaticMesh::GetBounds`
- `GetNumLODs()`
- `GetStaticMaterials()` array

All are reflection-callable via `/remote/object/call`. Expand delegate to batch-call all of them + aggregate into single return object.

### §4 list_material_parameters expansion (F-6)

Current coverage: `GetAllScalarParameterInfo` only. Per yaml: also Vector, Texture, (optionally Runtime-Virtual-Texture, Sparse-Volume-Texture in 5.6).

UE 5.6 `UMaterialInterface` reflection UFUNCTIONs:
- `GetAllScalarParameterInfo(OutInfo, OutIds)` ← current
- `GetAllVectorParameterInfo(OutInfo, OutIds)`
- `GetAllTextureParameterInfo(OutInfo, OutIds)`
- Plus value-getters: `GetScalarParameterValue`, `GetVectorParameterValue`, `GetTextureParameterValue`

Expand delegate to call all three info methods + optionally dereference values. Yaml description should flag whether the tool returns just parameter info (name + type) or also current values.

### §5 toCdoPath fix (F-7)

Audit flagged: toCdoPath wrongly scopes non-class paths. Current logic probably:
```js
function toCdoPath(assetPath) {
  return `${assetPath}.${lastName}_C:Default__${lastName}_C`;  // assumes class-style
}
```

Which breaks for non-class assets (e.g., passing a UCurveFloat path produces nonsense). Fix: detect asset category (is the asset a UBlueprint GeneratedClass, or a raw UObject asset?) and branch.

Approach:
- For UBlueprint / UWidgetBlueprint / UAnimBlueprint assets: use `<path>.<Name>_C:Default__<Name>_C` (CDO form).
- For raw UObject assets (UCurveFloat, UStaticMesh, etc.): use `<path>.<Name>` (object form).

Without live RC introspection, heuristic is sufficient — check the path for BP patterns (`/Blueprints/` or `/Characters/`) vs asset patterns (`/Meshes/`, `/Curves/`, `/Materials/`). If ambiguous, the first form is safer; RC returns 404 cleanly for wrong path, and agents retry with the other form.

Better: expose `toAssetPath(assetPath, hint)` where hint = `'cdo' | 'object'` and caller specifies intent.

### §6 Tests

Extend `server/test-rc-wire.mjs` with per-delegate coverage tests:
- `get_curve_asset` against mocked UCurveFloat + UCurveVector + UCurveLinearColor responses
- `get_mesh_info` with all 4+ UFUNCTION responses mocked
- `list_material_parameters` with all 3 info responses mocked
- `toCdoPath` / `toAssetPath` unit tests covering BP vs non-BP paths

Expected +10-20 assertions across the 4 findings.

### §7 Yaml descriptions

If your delegate NOW covers more than the yaml description promises, update yaml. If yaml promised something you can't implement without plugin C++ (e.g., compiled shader uniforms for materials), remove that claim from the description. D44 single-source-of-truth: yaml must match what the code delivers.

---

## Scope — out

- **AUDIT-FIX-1 scope (plugin threading)** — parallel worker owns it. DO NOT touch plugin/*.
- **AUDIT-FIX-3 scope (NodeGuid input bridge)** — parallel worker owns it. DO NOT touch offline-tools.mjs.
- **PARTIAL-RC hybrid-dispatch** — audit noted "commit to RC augmentation or collapse" as open question; that's a larger decision not in your scope.
- **Other audit findings** — your scope is F-4 through F-7 only.
- **New RC endpoints** — work with existing `/remote/object/call` + `/remote/object/property` endpoints.

---

## Reference files

### Tier 1
1. `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md` F-4, F-5, F-6, F-7.
2. `docs/tracking/risks-and-decisions.md` D79 (audit summary + FA-ε recommendations).
3. `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md` §Q1 for per-tool coverage reference.

### Tier 2
4. `server/rc-tools.mjs` — the 3 delegate implementations + toCdoPath.
5. `tools.yaml` — search for the 3 tool entries + verify `description` / `returns` blocks.
6. `server/test-rc-wire.mjs` — extend with coverage tests.

### Tier 3 — UE 5.6 refs
7. `Engine/Source/Runtime/Engine/Classes/Curves/CurveBase.h` + subclasses.
8. `Engine/Source/Runtime/Engine/Classes/Engine/StaticMesh.h`.
9. `Engine/Source/Runtime/Engine/Classes/Materials/MaterialInterface.h`.

---

## Success criteria

1. 3 delegates now cover the full UFUNCTION surface promised by yaml.
2. `toCdoPath` / `toAssetPath` correctly scopes BP vs non-BP paths.
3. Yaml descriptions match delegate behavior (D44 invariant preserved).
4. `test-rc-wire.mjs` extensions verify expanded coverage.
5. Full rotation stays green: 1205 passing / 0 failing (± your 10-20 new assertions).
6. Path-limited commit per D49: `server/rc-tools.mjs` + `tools.yaml` + `server/test-rc-wire.mjs`.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **D49 path-limited**: scope above.
- **No AI attribution**.
- **Single commit preferred**.
- **Report via standard Final Report template** (under 200 words).

---

## Final report

1. Commit SHA.
2. Per-finding delta: before vs after coverage (one-liner each).
3. toCdoPath approach taken (heuristic vs explicit-hint parameter).
4. Assertion count delta + full rotation status.
5. Any yaml descriptions trimmed (if code couldn't deliver a promised field).
6. Hint for follow-on worker if PARTIAL-RC "commit or collapse" decision comes up.
