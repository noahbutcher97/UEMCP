# Parser Extensions Worker — FExpressionInput Native + FieldPathProperty L1 Fix

> **Dispatch**: After Agent 10.5 ships. Sequential with Polish Worker to avoid parser-file collision.
> **Type**: Parser IMPLEMENTATION. Extends `server/uasset-parser.mjs` + `server/uasset-structs.mjs`.
> **Duration**: 1-2 sessions (~2-3 hours).

---

## Mission

Two parser-level follow-ons flagged by Agent 10.5's bulk validation:

1. **FExpressionInput native binary layout** — port from CUE4Parse to resolve the 21,876 `expression_input_native_layout_unknown` markers (relabeled from `unknown_struct` in Agent 10.5 tier 1). Material graph introspection workflows currently dead-end here.
2. **FieldPathProperty nested within structs** — pre-existing L1 scalar dispatcher edge case (e.g., `FGameplayAttribute.Attribute` inside a FGameplayAttribute struct). Currently emits nested `unknown_property_type` markers when it should decode as a FieldPath.

Both are scoped, bounded, reference-backed. No design work.

---

## Item 1 — FExpressionInput native binary layout

### Context

FExpressionInput is a UE material-graph struct (`FExpressionInput`, `FColorMaterialInput`, `FScalarMaterialInput`, `FVectorMaterialInput`, `FVector2MaterialInput`, etc.) that represents a material expression output connection. In ProjectA bulk validation, 99.8% of instances serialize via the native-binary path (flag 0x08) rather than tagged.

Agent 10.5's tier 1 handler covers the ~0.2% tagged path. The native binary layout is NOT reverse-engineered yet.

### Reference port source

CUE4Parse `UE4/Objects/Engine/Materials/FExpressionInput.cs` (master branch). The Deserialize method describes the full binary layout including:
- `ExpressionPtr` — serialized as FPackageIndex (4 bytes)
- `OutputIndex` — int32 (4 bytes)
- `InputName` — FName (8 bytes in UE 5.6)
- `Mask` — int32
- `MaskR`, `MaskG`, `MaskB`, `MaskA` — int32 each (or packed)

Variants like `FScalarMaterialInput` have additional `UseConstant` + `Constant` fields.

### Implementation

Add a handler in `server/uasset-structs.mjs` following the existing tier-1 pattern:

1. Detect native-binary path via flag 0x08 on the outer FPropertyTag.
2. Read the known byte sequence.
3. Return a structured object: `{ expression: {path, index}, output_index, input_name, mask, mask_r, mask_g, mask_b, mask_a }`.
4. For derived variants (MaterialInput<T>), register variant handlers that extend the base reader with the UseConstant+Constant fields.

### Hand-trace first

Before writing code, hand-trace 1-2 FExpressionInput instances from ProjectA material fixtures. Follow Agent 10's pattern — identify a Material `.uasset`, find an export that holds FExpressionInput, extract bytes from `SerialOffset`, decode manually against CUE4Parse's reference layout. Document findings in commit message.

### Test

Extend `server/test-uasset-parser.mjs` with 3-5 assertions on a known ProjectA Material fixture that exercises native FExpressionInput. Verify resolved object shape + resolved `expression.path` reference.

### Bulk validation re-run

After implementation, re-run Agent 10.5's 19K-file bulk validation. Expected: `expression_input_native_layout_unknown` marker count drops from 21,876 → near zero (some edge-case variants may remain; flag any residue).

---

## Item 2 — FieldPathProperty nested within structs

### Context

FFieldPath (UE 5.x `FProperty` path reference — used by `FGameplayAttribute.Attribute`, some reflection APIs) is a UPROPERTY type that Agent 10 did not implement in L1. When encountered INSIDE a struct (e.g., FGameplayAttribute itself decodes via tagged fallback, but its Attribute field hits the L1 dispatcher for FieldPathProperty), the dispatcher emits `{unsupported: true, reason: "unknown_property_type", type: "FieldPathProperty"}` nested inside the struct response.

Agent 10.5 noted this as "pre-existing L1 scalar dispatcher edge case."

### Binary layout (UE 5.x)

FFieldPath serializes as:
- `ResolvedOwner` — TWeakObjectPtr (8 bytes: ObjectIndex + ObjectSerialNumber)
- `Path` — TArray<FName> (int32 count + N × 8 bytes)

### Implementation

1. In `server/uasset-parser.mjs` (or wherever the L1 scalar dispatcher lives), add a case for `FieldPathProperty` / `FFieldPath` type tag.
2. Read the binary layout; return `{ owner: resolvedOwnerPath, path: ["ComponentName1", "ComponentName2", ...] }`.
3. Consider: is this ever tagged? If yes, handle both paths.

### Test

Add 2-3 assertions exercising a known ProjectA asset that holds a FGameplayAttribute or similar. `BPGA_Block` CDO is a candidate — it likely has AttributeSet or ability-cost references involving FGameplayAttribute.

### Bulk validation re-run

Re-run bulk validation; expected: `unknown_property_type` marker count drops for the FieldPathProperty subset.

---

## File scope

| File | Action |
|---|---|
| `server/uasset-parser.mjs` | Item 2 — add FieldPathProperty case to L1 scalar dispatcher |
| `server/uasset-structs.mjs` | Item 1 — add FExpressionInput native handler + variant handlers |
| `server/test-uasset-parser.mjs` | Test assertions for both items |
| (optional) Bulk validation audit doc | Brief re-run summary if marker reductions are noteworthy |

**Do NOT touch**: `offline-tools.mjs` response assembly (Polish Worker's scope), `tcp-tools.mjs`, `plugin/`, `tools.yaml`, `docs/tracking/`.

---

## Implementation order

1. Item 2 (FieldPathProperty) first — smaller, self-contained, lower risk. Single commit.
2. Item 1 (FExpressionInput) — hand-trace + implement base + implement variants. 2-3 commits.
3. Bulk validation re-run.

---

## Constraints

- CUE4Parse master branch for reference (Agent 9.5 correction: UE 5.4+ layout, not pre-5.4).
- Path-limited commits per D49. Desktop Commander for git.
- Tests must stay green (612/612 baseline). Target: +5-10 assertions across the two items.
- Performance regression budget: ≤2% slower on bulk validation (Agent 10.5 baseline 17.1s). Report if exceeded.
- No AI attribution.

---

## Final report

```
Parser Extensions Worker Final Report

Item 1 (FExpressionInput native):     [status]
  Bulk expression_input_native_layout_unknown marker reduction: [N → M]
  Variants handled: [list — FColorMaterialInput, FScalarMaterialInput, etc.]
Item 2 (FieldPathProperty L1):         [status]
  Bulk unknown_property_type FieldPathProperty reduction: [N → M]

Tests: [X]/[Y] — delta vs 612 baseline
Commits: [list with SHAs]
Performance (bulk scan):  [N s vs 17.1 baseline]
Hand-trace documented in commit [SHA]: [yes / no]
Time spent: [N min]
```
