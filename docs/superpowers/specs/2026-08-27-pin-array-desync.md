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

At the point of failure the parser reads `DefaultTextValue` at 147952 and gets a
bogus FString length of 65280 (`0x0000FF00`) — a length int32 straddling a `0xff`
byte. That 65280 recurs across hundreds of failures, so the misread has a
consistent shape.

**Treat the exact drift size as unknown.** A first reading of these bytes
suggested 2, and a later offset search suggested 1; the second was disproved (see
below) and the first was never independently confirmed. Both were inferences from
a single sample.

## Second pass — what a falsification test added

The Base-history hypothesis was tested by trying to **disprove** it: count pins
with a Base-history `PinFriendlyName` that parse *cleanly*. It survived, but only
in a refined form, and the refinement matters:

| Group | history = -1 | history = 0 (Base) |
|---|---|---|
| Pins in clean nodes (n=78,481) | 62,039 (79%) | **16,442 (21%)** |
| The pin that dies (n=1,528) | 0 | **1,528 (100%)** |

So Base history is **necessary but not sufficient**: every failure is a
Base-history pin, yet only ~8.5% of Base-history pins fail. Something inside that
read varies. String encoding is not it — Namespace/Key/SourceString are ANSI in
100% of both groups.

**The mirror decoder fails identically to the parser** (1,628 of 1,628 failing
nodes). That rules out a parser implementation quirk: this is a format gap, and
re-reading our own code will not find it.

### A real, separate gap found here

60 failing nodes die on `unsupported history 1` — FText **NamedFormat** history.
Neither the parser nor the mirror implements it; only -1 (None) and 0 (Base) are
handled. That is a genuine hole worth its own fix, though it is not the dominant
failure (the ~65280-byte truncation is).

### A lead that was disconfirmed — do not re-run it

Shifting the pin-array start by +1 byte appeared to make 1,601 of 1,628 failing
nodes decode, which looked like a 1-byte under-consumption of the tagged-property
stream. **It is a false positive.** `decodePin` returns early when `bNullPtr` is
non-zero, consuming only 4 bytes, so a misaligned stream "decodes" as a long run
of null pins and never throws. The success criterion — landing inside the export
— was satisfied without a single real pin being read.

Dumping the property boundary disconfirms it directly: failing and clean nodes
look identical there (`sentinel=0`, sane `arrayCount`), and a +1 shift makes the
count read as 0.

**If you write another offset search, the success criterion must be that the
decoded pins are non-null AND the cursor lands exactly on the export end** — not
merely that nothing threw.

### Where that leaves the search

The pin-array start is correct, so the desync begins **inside a pin body**,
after pin 0 parses correctly. Combined with the census, the target is the
Base-history FText read specifically, in the ~8.5% of cases that differ from the
other 91.5%.

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
