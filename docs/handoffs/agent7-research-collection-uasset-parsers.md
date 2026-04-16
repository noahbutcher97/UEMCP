# Agent 7 Handoff — Research Collection: .uasset Binary Parsing Projects

> **Dispatch**: 2026-04-16
> **Depends on**: nothing (can start immediately, parallel with Agent 6)
> **Type**: Pure research — NO code changes, NO file edits in `server/` or `plugin/`
> **Deliverable**: `docs/research/uasset-property-parsing-references.md`

---

## Mission

Cast a wide net to find ALL existing projects, libraries, documentation, and reference code related to parsing Unreal Engine `.uasset` / `.umap` binary files — specifically the **serialized object property data** beyond the file header. We need this to inform our Level 1+2 parser enhancement (D39).

Our current parser (`server/uasset-parser.mjs`) already handles:
- FPackageFileSummary (file header)
- Name table
- FObjectImport table (40-byte stride, UE 5.0+)
- FObjectExport table (112-byte stride)
- FPackageIndex resolution
- FAssetRegistryData tag block

What we need to add (and need references for):
- **Level 1**: FPropertyTag iteration — reading tagged properties from export serialized data (property name, type, value for simple types)
- **Level 2**: Struct deserialization — FVector, FRotator, FTransform, FLinearColor, FGameplayTag/Container, FSoftObjectPath, and other common UE structs

---

## Search targets

### 1. Major open-source projects

Find and document each of these (and any others discovered):

- **UAssetAPI** (C#, atenfyr/UAssetAPI on GitHub) — most complete community .uasset parser
- **CUE4Parse** (C#, FabianFG/CUE4Parse) — used by FModel, game asset extraction
- **FModel** (C#/Java) — asset viewer built on CUE4Parse
- **UAssetGUI** — GUI wrapper around UAssetAPI
- **UnrealPak** / **u4pak** — .pak file tools (may contain .uasset parsing)
- **UE4SS** (C++) — modding framework with property reflection
- **Unreal.js** / **node-ue4** / any Node.js or JavaScript implementations
- **Python implementations** — any Python .uasset parsers (unreal-toolkit, pyunrealpak, etc.)
- **Rust implementations** — any Rust crate for .uasset parsing

For each project found, record:
- Repository URL
- Language
- Last commit date (is it maintained?)
- UE version coverage (UE4 only? UE5? Which minor versions?)
- What parsing depth it achieves (header only? tagged properties? full deserialization? custom Serialize overrides?)
- License
- Quality signal (stars, contributors, documentation quality)

### 2. Format documentation

- **UE source**: `FPropertyTag` serialization in `CoreUObject/Private/UObject/Property*.cpp`
- **Community wikis**: UE4 modding wikis, .uasset format documentation
- **Epic's official docs**: any public documentation of the binary format
- **Blog posts / writeups**: anyone who has documented their experience parsing .uasset files
- **Struct layouts**: documented binary layouts for FVector, FRotator, FTransform, FLinearColor, FGameplayTag, FGameplayTagContainer, FSoftObjectPath in UE5

### 3. JavaScript/TypeScript specific

This is highest priority since our parser is JS (Node.js ES modules):
- Any npm packages for .uasset parsing
- Any TypeScript type definitions for UE binary structures
- Any JS ports of UAssetAPI or CUE4Parse
- Any WebAssembly builds of C#/Rust parsers usable from Node

### 4. FPropertyTag format specifics

For each source found, extract or note where to find:
- The FPropertyTag binary layout (field order, sizes, flags)
- How `ArrayProperty`, `StructProperty`, `MapProperty`, `SetProperty` are serialized (container types)
- How `ObjectProperty` / `SoftObjectProperty` references work (package index? path string?)
- How `EnumProperty` values are stored
- The `None` terminator convention
- Version-specific differences between UE 5.6 and 5.7 (if any)
- How `CustomVersions` in the file header gate serialization format changes

### 5. Struct binary layouts (Level 2 targets)

For each struct, find the exact binary layout (field order, types, sizes):
- FVector (3 × double in UE5 — confirm)
- FRotator (3 × double in UE5 — confirm)
- FTransform (FQuat + FVector + FVector — confirm layout order and sizes)
- FQuat (4 × double — confirm)
- FLinearColor (4 × float — confirm)
- FColor (4 × uint8 — confirm)
- FGameplayTag (single FName — confirm)
- FGameplayTagContainer (array of FGameplayTag — confirm serialization)
- FSoftObjectPath (FName + FString — confirm, check version changes)
- FGuid (4 × uint32 — confirm)
- FName serialization within property data (index + number? or string?)

---

## Output format

Write `docs/research/uasset-property-parsing-references.md` with:

### §1 Project catalog
Table of all projects found: name, language, URL, last updated, UE version range, parsing depth, license, quality notes.

### §2 JavaScript/Node.js landscape
Dedicated section — what exists in JS, quality assessment, whether anything is directly usable or portable.

### §3 FPropertyTag format reference
Consolidated binary layout documentation from the best sources found. Include byte offsets, field types, and the iteration algorithm.

### §4 Struct layout reference
Table of target structs with binary layout (field name, type, byte offset, size). Note any version-dependent differences.

### §5 Recommended sources for our implementation
Rank the top 3-5 sources by usefulness for our specific case (Node.js, UE 5.6+5.7, Level 1+2 scope). For each, note what we can lift directly vs what needs adaptation.

### §6 Risks and unknowns
Anything the research surfaced that complicates Level 1+2: version skew, custom serialization gotchas, struct layouts that differ between 5.6 and 5.7, etc.

---

## Constraints

- **Research only** — do not write any code, do not edit any server files.
- **Web search is your primary tool** — search GitHub, npm, crates.io, UE forums, modding wikis, blog posts.
- **Breadth over depth** — the audit agent (Agent 8) will do the deep evaluation. Your job is to find everything and catalog it.
- **Include dead/unmaintained projects** — they may still have useful format documentation even if the code is stale.
- **No AI attribution in any files you create.**

---

## Final report format

```
Agent 7 Final Report — Research Collection: .uasset Parsers

Projects found: [N]
JS/Node implementations found: [N]
Format documentation sources: [N]
Struct layouts confirmed: [N of target list]
Deliverable: docs/research/uasset-property-parsing-references.md ([N] lines)
Key finding: [one-line summary of most important discovery]
```
