# Mid-array pin desync in the offline parser

**Date**: 2026-08-27
**Status**: Localised, NOT fixed. Stopped at a pre-declared budget rather than producing another theory.
**Scale**: 20,598 of 51,563 graph-node exports malformed in UE 5.8's engine plugins alone (40%)
**Related**: D194 (the same silent-truncation failure mode), D195, `docs/reports/graph-node-coverage-audit.md`

## Why this matters more than it looks

The failure is **not** a refusal. A node reports `arrayCount=10` and returns 3 pins,
with a valid sentinel and a valid NodeGuid. Downstream that becomes a graph that
is silently short some pins and edges — exactly the AnimGraph failure mode from
D194, where an incomplete graph still looked like data and only one dangling edge
betrayed it.

That is why admitting new node families (Niagara, ControlRig, SoundCue) should
wait: widening on top of this multiplies silent loss rather than adding coverage.

## Two distinct classes — do not conflate them

| Class | Symptom | Where it dies |
|---|---|---|
| Legacy (`ue5=0`, pre-1012) | garbage `arrayCount` (e.g. -1174405120), no NodeGuid, 0 pins | tagged-property decode, **before** the pin array |
| Modern (incl. 1018) | sane `arrayCount`, valid NodeGuid, parses some pins then dies | mid-array |

A fix for one will not touch the other. Everything below is about the **modern**
class.

## Ruled out — do not re-investigate these

- **A 5.8 layout change.** `UEdGraphPin::Serialize` and `FEdGraphPinType::Serialize`
  are field-for-field identical between 5.6 and 5.8 — same order, same version
  gates. 5.8 adds snapped-pin state, which occupies bits 6/7 of the existing
  `uint32` bitfield and changes no sizes.
- **Custom versions.** Passing and failing modern packages both carry
  `FUE5MainStreamObjectVersion` far above every relevant gate (121 vs 123).
  The audit's "correlates with per-package custom versions" does not hold.
- **The `SourceIndex` gate.** Real bug, fixed in D-log (the field is gated on
  `FUE5MainStreamObjectVersion >= 50` and was skipped unconditionally), but it is
  **not this**: toggling it on a failing package changes nothing.
- **Concurrency / machine load.** Deterministic per asset.
- **`FTextKey` serialization.** `TextKeyUtil::LoadKeyString` is explicitly
  "compatible with the FString serialization" — int32 length, negative for UTF-16.
  Reading Namespace/Key as plain FStrings is correct.
- **UTF-16 FString handling.** `Cursor.readFString` handles negative lengths
  correctly (`charCount * 2` bytes).
- **Reference-array entry size.** 24 bytes per non-null entry
  (`bNullPtr` + `OwningNode` + 16-byte `PinId`), which the parser has right.
  *(A scratch decoder got this wrong at 20 and produced a false lead — check
  this first if you write another one.)*

## Where it actually goes wrong

Census over 515 mid-array failures:

- Failures cluster at the pin **immediately after one whose parse succeeded** —
  most often right after `then` (191 of 515), and at index 1 of 2-pin nodes (200).
- Not class-determined: `K2Node_VariableGet` is 5440 clean against 208 failing,
  `K2Node_CallFunction` 4716 against 190. Same classes, same packages, both
  outcomes. **It is content-dependent.**

Field-level decode of a failing node (`BP_ClothPreview.uasset`,
ChaosClothAssetEditorCore, `K2Node_VariableGet`, `arrayCount=2`):

```
pin[0]  PinName="ChaosClothComponent"  PinFriendlyName: history=-1 -> ""     parses
pin[1]  PinName="self"                 PinFriendlyName: history= 0 -> "Target"  DIES
```

The distinguishing feature of the failing pin is a **non-empty `PinFriendlyName`
carrying FText HistoryType 0 (Base)**. Every clean pin examined had the empty
`history=-1` form.

The drift is small. At the point of failure the parser reads
`DefaultTextValue` at 147952 and gets a bogus FString length of 65280. The raw
bytes place `0xff` at 147958, and a coherent reading — `flags=0` at 147954,
`history=0xff=-1` at 147958, `hasInv=0`, empty text — puts the true field start at
**147954**. That is a **2-byte** drift, not the 4 that a missing int32 would give.

Two bytes is the interesting part: nearly every field here is 4-byte aligned, so
a 2-byte error points at a character-count-versus-byte-count confusion somewhere
in the Base-history read, not at a missing or extra field.

## Next step

Decode the Base-history FText of a failing pin byte by byte against
`FTextHistory_Base::Serialize` and account for every byte between the history
type and `SourceIndex`. The arithmetic on the one sample examined *appeared*
self-consistent (38 bytes for flags + history + three FStrings), which is why
this needs byte-level confirmation rather than another plausible reading —
"appeared consistent" is how the previous four theories survived.

Ground truth is available and was not used here only because no editor was free:
`DumpBPGraph` on a 5.8 build gives the authoritative pin list for a failing
asset, so a diff against it would confirm which pins are lost rather than
inferring it.

**Do not** widen the graph-node predicate before this is fixed.
