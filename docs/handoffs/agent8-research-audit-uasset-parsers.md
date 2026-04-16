# Agent 8 Handoff — Research Audit: Evaluate .uasset Parser Projects for UEMCP

> **Dispatch**: After Agent 7 delivers `docs/research/uasset-property-parsing-references.md`
> **Depends on**: Agent 7 (research collection)
> **Type**: Research + analysis — NO code changes to `server/` or `plugin/`
> **Deliverable**: `docs/research/uasset-parser-audit-and-recommendation.md`

---

## Mission

Read Agent 7's research collection and evaluate each project/resource through the lens of **our specific requirements**. Produce a recommendation on what to port, what to reference, and what to build from scratch for the Level 1+2 parser enhancement (D39).

---

## Our requirements (the evaluation lens)

1. **Language**: Node.js ES modules (.mjs). No TypeScript. No build step. Must integrate cleanly into `server/uasset-parser.mjs`.
2. **Engine versions**: UE 5.6 (ProjectA) and UE 5.7 (ProjectB). UE4 support is irrelevant.
3. **Scope**: Level 1 (FPropertyTag iteration for simple types) + Level 2 (struct deserialization for ~10 target structs). We do NOT need Level 3 (UEdGraph full deserialization) or universal deserialization.
4. **Existing parser**: we already have a working header parser (name table, imports, exports, AR tags). The new code extends it — it doesn't replace it.
5. **Performance**: must handle 19K+ files in bulk scans without hanging. Per-file property reads should be <50ms on SSD.
6. **Correctness over completeness**: it's fine to skip unrecognized property types (log and advance by `size` bytes). It's NOT fine to silently return wrong values.
7. **No external runtime dependencies**: no .NET, no Python, no WASM. Pure JS.

---

## Evaluation tasks

### Task 1: Project-by-project assessment

For each project in Agent 7's §1 catalog:

- **Relevance score** (1-5): how useful is this for our Level 1+2 scope?
- **Portability to JS**: can the parsing logic be ported to JS? How much effort? Are there language-specific features (C# generics, Rust traits) that make porting non-trivial?
- **What to lift**: specific files, functions, or data structures worth porting. Be concrete — name the file/class/function.
- **What to skip**: parts of the project that are irrelevant to our scope.
- **Version coverage gap**: does it handle UE 5.6/5.7, or is it stuck on older versions?

### Task 2: FPropertyTag implementation comparison

Compare how the top 3 projects implement FPropertyTag iteration:
- Entry point function (name, signature)
- How they handle the tag loop (read name → check for None → read type → read size → dispatch)
- How they handle unknown/unrecognized types (skip by size? error? crash?)
- How they handle nested properties (ArrayProperty containing StructProperty, etc.)
- How they handle version-gated serialization changes

### Task 3: Struct handler assessment

For each of our 10 target structs (FVector, FRotator, FTransform, FQuat, FLinearColor, FColor, FGameplayTag, FGameplayTagContainer, FSoftObjectPath, FGuid):
- Which projects have a handler for it?
- Is the handler UE5-correct (doubles vs floats for vectors)?
- Can the handler be ported to JS as a standalone function?
- Any version-specific gotchas?

### Task 4: Recommendation

Produce a concrete recommendation:

**Build plan**: what the Level 1+2 implementation agent should do, in order.
1. FPropertyTag iteration loop — port from [project X, file Y] or build from [spec Z]
2. Simple type handlers — port from [project X] or build from [format docs]
3. Struct registry pattern — use [approach] from [project X]
4. Each target struct handler — source for each

**Reference files**: specific files from the top projects that the implementation agent should read. Provide exact GitHub URLs or file paths.

**Risks**: anything discovered that makes Level 1 or Level 2 harder than the "2-3 weeks human / 1-2 days agent" estimate suggested.

---

## Input

Read these files before starting:
- `docs/research/uasset-property-parsing-references.md` (Agent 7's deliverable — **primary input**)
- `server/uasset-parser.mjs` (our existing parser — understand what's already built)
- `docs/research/uasset-parser-options-2026-04-14.md` (Agent 3's original parser research)
- `docs/tracking/risks-and-decisions.md` D37, D39 (parser decisions)

---

## Output format

Write `docs/research/uasset-parser-audit-and-recommendation.md` with:

### §1 Project assessments
One subsection per project: relevance score, portability, what to lift, what to skip.

### §2 FPropertyTag implementation comparison
Side-by-side comparison of top 3 implementations. Pseudo-code or code snippets welcome.

### §3 Struct handler matrix
Table: struct name × project → handler exists (Y/N), UE5-correct (Y/N), port effort (Low/Med/High).

### §4 Build recommendation
The concrete plan for the implementation agent. Ordered steps, specific source references, estimated complexity per step.

### §5 Risk assessment
Anything that changes the Level 1+2 feasibility or timeline estimate.

---

## Constraints

- **Research + analysis only** — do not write implementation code, do not edit server files.
- **Be concrete** — "port the FPropertyTag loop from UAssetAPI's PropertyData.cs" is useful. "Look at UAssetAPI for inspiration" is not.
- **Evaluate against OUR requirements**, not general quality. A 5-star C# project that can't be ported to JS scores low.
- **No AI attribution in any files you create.**

---

## Final report format

```
Agent 8 Final Report — Research Audit: .uasset Parser Evaluation

Projects evaluated: [N]
Top recommendation: [project name] — [one-line reason]
FPropertyTag approach: [port from X / build from spec / hybrid]
Struct handlers portable: [N of 10]
Estimated Level 1 effort: [revised estimate]
Estimated Level 2 effort: [revised estimate]
Risks surfaced: [N]
Deliverable: docs/research/uasset-parser-audit-and-recommendation.md ([N] lines)
```
