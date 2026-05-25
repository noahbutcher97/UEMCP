# Class-Resolution Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every live-editor `UClass` resolution through one shared **load-first** resolver so cold `/Game` Blueprint classes resolve without being opened in-session, and add a rotation guard against regression.

**Architecture:** Add `UEMCP::ResolveClass(Identifier, RequiredBase)` to `HandlerCommon.{h,cpp}` (load-from-disk for paths, `FindFirstObjectSafe` for native short names). Migrate all five resolution sites + `ReflectionWalker::ResolveClass` to call it, deleting the hand-rolled `FindObject`/`LoadClass` chains. Lock it in with a `server/test-class-resolution-audit.mjs` static scan. **There is no C++ unit-test harness in this repo** — C++ correctness is validated by *compilation* (per task) plus a *live editor smoke* (final task); the `.mjs` guard is a structural regression lock, not a behavior test.

**Tech Stack:** C++ (UE 5.3/5.6/5.7 editor plugin), Node ESM (`.mjs`) for the guard + rotation runner. Builds via `sync-plugin.bat` + engine `Build.bat`.

**Spec:** `docs/specs/2026-05-25-class-resolution-consolidation-design.md`

**Codename hygiene:** This is a committed doc — build commands use placeholder project paths. Hydrate `<PROJ57_UPROJECT>` / `<PROJ53_UPROJECT>` and the `<Proj57>Editor` / `<Proj53>Editor` target names from your `.uemcp-targets.txt` (gitignored). Engine roots: `C:\Program Files\Epic Games\UE_5.7` and `UE_5.3`. Use Desktop Commander `start_process` with `shell:"cmd"` for git per CLAUDE.md.

**Per-task build loop (fast, incremental):** after editing repo C++, deploy + build one project to confirm it compiles:
```
& "D:\DevTools\UEMCP\sync-plugin.bat" "<PROJ57_UPROJECT>" -y
"/c/Program Files/Epic Games/UE_5.7/Engine/Build/BatchFiles/Build.bat" <Proj57>Editor Win64 Development -project="<PROJ57_UPROJECT>" -waitmutex
```
Success signal: UBT reaches `[N/N] WriteMetadata <Proj57>Editor.target` with `UnrealEditor-UEMCP.dll` linked, 0 errors. (Run engine builds **serially** — parallel `Build.bat` races on UBT's shared logfile, D168.)

---

### Task 1: Shared load-first resolver `UEMCP::ResolveClass`

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Public/HandlerCommon.h` (add declaration in `namespace UEMCP`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/HandlerCommon.cpp` (add definition + includes)

- [ ] **Step 1: Declare the resolver in `HandlerCommon.h`**

Add inside the existing `namespace UEMCP { ... }` block, next to the `ResolveBlueprint` declaration:

```cpp
	/**
	 * Load-first UClass resolution from a flexible identifier.
	 *
	 * Path-shaped input (contains '/') loads from disk so a cold /Game Blueprint
	 * class resolves WITHOUT being opened in the editor this session; short names
	 * resolve native (always-loaded) classes. Returns nullptr if unresolved, or
	 * if RequiredBase is set and the resolved class is not a child of it.
	 *
	 * PRECONDITION: must be called on the game thread (LoadClass/LoadObject/TryLoad
	 * require it). All current callers already marshal via MCPThreadMarshal, so
	 * this stays a pure synchronous helper and does NOT re-marshal.
	 */
	UClass* ResolveClass(const FString& Identifier, UClass* RequiredBase = nullptr);
```

- [ ] **Step 2: Define the resolver in `HandlerCommon.cpp`**

Add these includes near the top (after the existing includes; `Engine/Blueprint.h` and `UObject/SoftObjectPath.h` are already present per the current file):

```cpp
#include "UObject/UObjectGlobals.h"   // LoadClass, FindFirstObjectSafe, EFindFirstObjectOptions
#include "UObject/Class.h"            // UClass
```

Add the definition inside `namespace UEMCP { ... }` (after `ResolveBlueprint`):

```cpp
	UClass* ResolveClass(const FString& Identifier, UClass* RequiredBase)
	{
		if (Identifier.IsEmpty())
		{
			return nullptr;
		}

		UClass* Resolved = nullptr;

		if (Identifier.Contains(TEXT("/")))
		{
			// Path-shaped → load from disk.
			Resolved = LoadClass<UObject>(nullptr, *Identifier);

			// Package-only path (no '.') → synthesize the Blueprint generated-class path.
			if (!Resolved && !Identifier.Contains(TEXT(".")))
			{
				int32 SlashIdx = INDEX_NONE;
				if (Identifier.FindLastChar(TEXT('/'), SlashIdx) && SlashIdx + 1 < Identifier.Len())
				{
					const FString Leaf = Identifier.Mid(SlashIdx + 1);
					const FString BpClassPath = Identifier + TEXT(".") + Leaf + TEXT("_C");
					Resolved = LoadClass<UObject>(nullptr, *BpClassPath);
				}
			}

			// Soft-path fallback: resolves a UBlueprint asset → its GeneratedClass,
			// or a UClass object directly.
			if (!Resolved)
			{
				const FSoftObjectPath Soft(Identifier);
				if (UObject* Obj = Soft.TryLoad())
				{
					if (UBlueprint* BP = Cast<UBlueprint>(Obj))
					{
						Resolved = BP->GeneratedClass;
					}
					else if (UClass* AsClass = Cast<UClass>(Obj))
					{
						Resolved = AsClass;
					}
				}
			}
		}
		else
		{
			// Short name → native in-memory lookup (native classes are always loaded;
			// FindFirstObjectSafe won't assert during GC / package-save).
			Resolved = FindFirstObjectSafe<UClass>(*Identifier, EFindFirstObjectOptions::NativeFirst);
			if (!Resolved && !Identifier.StartsWith(TEXT("U")))
			{
				const FString WithPrefix = TEXT("U") + Identifier;
				Resolved = FindFirstObjectSafe<UClass>(*WithPrefix, EFindFirstObjectOptions::NativeFirst);
			}
		}

		if (Resolved && RequiredBase && !Resolved->IsChildOf(RequiredBase))
		{
			return nullptr;
		}
		return Resolved;
	}
```

- [ ] **Step 3: Build to confirm it compiles (nothing calls it yet)**

Run the per-task build loop (sync + `Build.bat` against the 5.7 project).
Expected: `[N/N] WriteMetadata`, `UnrealEditor-UEMCP.dll` linked, 0 errors. (`ResolveClass` is defined but unused — UE/MSVC does not error on unused non-static namespace functions.)

- [ ] **Step 4: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/HandlerCommon.h plugin/UEMCP/Source/UEMCP/Private/HandlerCommon.cpp
git commit -m "Add shared load-first UEMCP::ResolveClass resolver (class-resolution consolidation)"
```

---

### Task 2: `ReflectionWalker::ResolveClass` delegates to the shared resolver

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/ReflectionWalker.cpp:264-294` (replace the body; the function is the file-local `ResolveClass(const FString& Path)`)

- [ ] **Step 1: Confirm `HandlerCommon.h` is included**

`ReflectionWalker.cpp` already includes `MCPCommandRegistry.h` / `MCPResponseBuilder.h`. Add this include if not present (check the include block near the top):

```cpp
#include "HandlerCommon.h"
```

- [ ] **Step 2: Replace the `ResolveClass` body with delegation**

Replace the entire existing function (the `_C`-synthesis + `LoadClass` + `SoftObjectPath::TryLoad` block, currently lines ≈264-294) with:

```cpp
		UClass* ResolveClass(const FString& Path)
		{
			// Delegates to the single shared resolver (HandlerCommon). The shared
			// resolver does the same _C synthesis + LoadClass + SoftPath.TryLoad,
			// plus native short-name lookup (a harmless superset for this caller).
			return UEMCP::ResolveClass(Path);
		}
```

- [ ] **Step 3: Build to confirm it compiles**

Run the per-task build loop.
Expected: `[N/N] WriteMetadata`, DLL linked, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/ReflectionWalker.cpp
git commit -m "ReflectionWalker::ResolveClass delegates to shared UEMCP::ResolveClass"
```

---

### Task 3: `AnimationHandlers::ResolveNotifyClass` — the anchor-case fix

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp:231-255` (replace the `ResolveNotifyClass` body)

- [ ] **Step 1: Confirm `HandlerCommon.h` is included**

Add near the top of `AnimationHandlers.cpp` if absent:

```cpp
#include "HandlerCommon.h"
```

- [ ] **Step 2: Replace `ResolveNotifyClass` with shared-resolver candidates**

Replace the entire function (currently the `FindObject<UClass>`-only + `TObjectIterator<UClass>` block, lines ≈231-255) with:

```cpp
	UClass* ResolveNotifyClass(const FString& NotifyClassName)
	{
		// Load-first via the shared resolver, then the two engine short-name shapes.
		// No RequiredBase: the montage handler validates the notify type afterward
		// (behavior preserved). The deleted FindObject/TObjectIterator paths were
		// loaded-only — a cold /Game Blueprint notify now resolves because the
		// shared resolver loads /Game paths from disk.
		if (UClass* C = UEMCP::ResolveClass(NotifyClassName))
		{
			return C;
		}
		if (UClass* C = UEMCP::ResolveClass(FString::Printf(TEXT("/Script/Engine.%s"), *NotifyClassName)))
		{
			return C;
		}
		return UEMCP::ResolveClass(FString::Printf(TEXT("/Script/Engine.AnimNotify_%s"), *NotifyClassName));
	}
```

- [ ] **Step 3: Build to confirm it compiles**

Run the per-task build loop.
Expected: `[N/N] WriteMetadata`, DLL linked, 0 errors. If `TObjectIterator` was the only use of its header, no include cleanup is needed (it lives in always-included `UObject/UObjectIterator.h` via engine PCH).

- [ ] **Step 4: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp
git commit -m "AnimationHandlers::ResolveNotifyClass uses shared load-first resolver (fixes cold /Game notify class)"
```

---

### Task 4: `BlueprintHandlers` — migrate all four sites

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp` (four sites: ≈756, ≈1045, ≈1124, ≈1809)

- [ ] **Step 1: Confirm `HandlerCommon.h` is included**

Add near the top of `BlueprintHandlers.cpp` if absent:

```cpp
#include "HandlerCommon.h"
```

- [ ] **Step 2: Class-pin default (≈756-761)**

Replace:

```cpp
						UClass* Class = LoadObject<UClass>(nullptr, *ClassName);
						if (!Class)
						{
							const FString EngineClassName = FString::Printf(TEXT("/Script/Engine.%s"), *ClassName);
							Class = LoadObject<UClass>(nullptr, *EngineClassName);
						}
```

with:

```cpp
						UClass* Class = UEMCP::ResolveClass(ClassName);
						if (!Class)
						{
							Class = UEMCP::ResolveClass(FString::Printf(TEXT("/Script/Engine.%s"), *ClassName));
						}
```

- [ ] **Step 3: Actor-class resolve (≈1045-1056)**

Replace:

```cpp
					UClass* Found = nullptr;
					if (ClassName == TEXT("APawn"))      Found = APawn::StaticClass();
					else if (ClassName == TEXT("AActor")) Found = AActor::StaticClass();
					else
					{
						const FString EnginePath = FString::Printf(TEXT("/Script/Engine.%s"), *ClassName);
						Found = LoadClass<AActor>(nullptr, *EnginePath);
						if (!Found)
						{
							const FString GamePath = FString::Printf(TEXT("/Script/Game.%s"), *ClassName);
							Found = LoadClass<AActor>(nullptr, *GamePath);
						}
					}
```

with:

```cpp
					UClass* Found = nullptr;
					if (ClassName == TEXT("APawn"))      Found = APawn::StaticClass();
					else if (ClassName == TEXT("AActor")) Found = AActor::StaticClass();
					else
					{
						// Gains /Game actor-Blueprint support over the old /Script-only chain.
						const TArray<FString> Candidates = {
							ClassName,
							FString::Printf(TEXT("/Script/Engine.%s"), *ClassName),
							FString::Printf(TEXT("/Script/Game.%s"), *ClassName),
						};
						for (const FString& Candidate : Candidates)
						{
							Found = UEMCP::ResolveClass(Candidate, AActor::StaticClass());
							if (Found) break;
						}
					}
```

- [ ] **Step 4: Add-component (≈1124-1148)**

Replace the whole interleaved `LoadClass`/`FindObject` block (from `UClass* ComponentClass = LoadClass<UActorComponent>...` through the final `FindObject<UClass>(nullptr, *Both)` branch) with:

```cpp
				// Build candidate identifiers, resolve each load-first, filtered to UActorComponent.
				TArray<FString> Candidates;
				Candidates.Add(ComponentType);
				if (!ComponentType.EndsWith(TEXT("Component")))
				{
					Candidates.Add(ComponentType + TEXT("Component"));
				}
				if (!ComponentType.StartsWith(TEXT("U")))
				{
					Candidates.Add(TEXT("U") + ComponentType);
					if (!ComponentType.EndsWith(TEXT("Component")))
					{
						Candidates.Add(TEXT("U") + ComponentType + TEXT("Component"));
					}
				}
				Candidates.Add(FString::Printf(TEXT("/Script/Engine.%s"), *ComponentType));
				if (!ComponentType.EndsWith(TEXT("Component")))
				{
					Candidates.Add(FString::Printf(TEXT("/Script/Engine.%sComponent"), *ComponentType));
				}

				UClass* ComponentClass = nullptr;
				for (const FString& Candidate : Candidates)
				{
					ComponentClass = UEMCP::ResolveClass(Candidate, UActorComponent::StaticClass());
					if (ComponentClass) break;
				}
```

(The subsequent `if (!ComponentClass || !ComponentClass->IsChildOf(UActorComponent::StaticClass()))` error check stays — the `RequiredBase` filter makes the `IsChildOf` redundant but harmless, so leave it for an unchanged error path.)

- [ ] **Step 5: Reparent/target (≈1809-1818)**

Replace:

```cpp
					TargetClass = FindObject<UClass>(nullptr, *Target);
					if (!TargetClass && !Target.StartsWith(TEXT("U")))
					{
						TargetClass = FindObject<UClass>(nullptr, *(TEXT("U") + Target));
					}
					if (!TargetClass)
					{
						TargetClass = LoadClass<UObject>(nullptr,
							*FString::Printf(TEXT("/Script/Engine.%s"), *Target));
					}
```

with:

```cpp
					const TArray<FString> Candidates = {
						Target,
						Target.StartsWith(TEXT("U")) ? Target : (TEXT("U") + Target),
						FString::Printf(TEXT("/Script/Engine.%s"), *Target),
					};
					for (const FString& Candidate : Candidates)
					{
						TargetClass = UEMCP::ResolveClass(Candidate);
						if (TargetClass) break;
					}
```

- [ ] **Step 6: Build to confirm it compiles**

Run the per-task build loop.
Expected: `[N/N] WriteMetadata`, DLL linked, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp
git commit -m "BlueprintHandlers: route all 4 class-resolution sites through shared UEMCP::ResolveClass"
```

---

### Task 5: Regression guard `test-class-resolution-audit.mjs`

**Files:**
- Create: `server/test-class-resolution-audit.mjs`
- (No rotation-runner wiring needed — `run-rotation.mjs` auto-enumerates `server/test-*.mjs`.)

- [ ] **Step 1: Write the guard with synthetic self-tests + live scan**

Create `server/test-class-resolution-audit.mjs`:

```js
// test-class-resolution-audit.mjs — class-resolution consolidation guard (D-log: this workstream).
//
// Enforces that all UClass resolution in live-editor handlers routes through the
// single shared UEMCP::ResolveClass (HandlerCommon.cpp). Flags raw UClass-resolution
// primitives in plugin/UEMCP/Source/UEMCP/Private/*.cpp — both find-only AND load
// variants — so the asset-blind "needs the asset loaded this session" quirk can't
// reappear and the load-but-narrow sites can't drift back.
//
// Excludes HandlerCommon.cpp (home of the resolver) and Commandlets/ (offline tooling).
// An `// uemcp-allow-class-resolution: <reason>` line directly above a flagged line
// whitelists that line. Reuses stripCommentsAndStrings so primitives inside comments
// or string literals are not flagged.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { stripCommentsAndStrings } from './test-anon-namespace-audit.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = resolve(SERVER_DIR, '..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private');
const EXCLUDED_BASENAMES = new Set(['HandlerCommon.cpp']);
const ALLOW_MARKER = 'uemcp-allow-class-resolution:';

// Raw UClass-resolution primitives. LoadObject<UBlueprint> / LoadObject<UAnimSequence>
// etc. are asset loads (not UClass) and are intentionally NOT matched.
const VIOLATION_PATTERNS = [
  /\bFindObject\s*<\s*UClass\b/,
  /\bFindFirstObject(?:Safe)?\s*<\s*UClass\b/,
  /\bStaticFind(?:First)?Object\w*\s*\(\s*UClass::StaticClass\(\)/,
  /\bLoadClass\s*</,
  /\bLoadObject\s*<\s*UClass\b/,
  /\bStaticLoadObject\s*\(\s*UClass::StaticClass\(\)/,
];

/** Scan one file's source → array of { line, text } violations (1-based line nums). */
export function scanSource(src) {
  const stripped = stripCommentsAndStrings(src);
  const strippedLines = stripped.split('\n');
  const rawLines = src.split('\n');
  const out = [];
  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i];
    if (!VIOLATION_PATTERNS.some(re => re.test(line))) continue;
    const prev = i > 0 ? rawLines[i - 1] : '';
    if (prev.includes(ALLOW_MARKER)) continue; // whitelisted
    out.push({ line: i + 1, text: rawLines[i].trim() });
  }
  return out;
}

/** Audit the Private dir → Map<basename, [{line,text}]> of violations. */
export function auditClassResolution(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.cpp')).sort();
  const violations = new Map();
  for (const f of files) {
    if (EXCLUDED_BASENAMES.has(f)) continue;
    const hits = scanSource(readFileSync(join(dir, f), 'utf8'));
    if (hits.length > 0) violations.set(f, hits);
  }
  return violations;
}

const isMain = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch { return false; }
})();

if (isMain) {
  let passed = 0, failed = 0;
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}: expected ${e}, got ${a}`); }
  };
  const ok = (cond, label) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}`); }
  };

  // ── self-tests: prove the detector flags violations and ignores safe code ──
  eq(scanSource('UClass* C = FindObject<UClass>(nullptr, *N);').length, 1, 'flags FindObject<UClass>');
  eq(scanSource('UClass* C = LoadClass<AActor>(nullptr, *P);').length, 1, 'flags LoadClass<>');
  eq(scanSource('UClass* C = FindFirstObjectSafe<UClass>(*N, O);').length, 1, 'flags FindFirstObjectSafe<UClass>');
  eq(scanSource('auto* BP = LoadObject<UBlueprint>(nullptr, *P);').length, 0, 'asset load LoadObject<UBlueprint> NOT flagged');
  eq(scanSource('// FindObject<UClass>(nullptr, *N);').length, 0, 'commented-out primitive NOT flagged');
  eq(scanSource('// uemcp-allow-class-resolution: native enum\nUClass* C = FindObject<UClass>(nullptr, *N);').length, 0, 'allow-marker whitelists next line');
  eq(scanSource('C = UEMCP::ResolveClass(N);').length, 0, 'shared resolver call NOT flagged');

  // ── live scan: post-consolidation invariant (0 violations outside the resolver) ──
  if (existsSync(PRIVATE_DIR)) {
    const violations = auditClassResolution(PRIVATE_DIR);
    if (violations.size > 0) {
      console.error('  Raw UClass-resolution primitives found outside UEMCP::ResolveClass:');
      for (const [f, hits] of violations.entries()) {
        for (const h of hits) console.error(`    ${f}:${h.line}  ${h.text}`);
      }
      console.error('  Fix: route through UEMCP::ResolveClass (HandlerCommon.h), or add');
      console.error('  `// uemcp-allow-class-resolution: <reason>` above a vetted exception.');
    }
    eq(violations.size, 0, 'no raw UClass-resolution primitives outside the shared resolver');
  } else {
    console.log(`  ⊘ skipped (Private/ dir absent): ${PRIVATE_DIR}`);
  }

  console.log('');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Run the guard standalone — confirm it passes (all sites migrated in Tasks 2-4)**

Run: `node server/test-class-resolution-audit.mjs`
Expected: all `✓`, `Failed: 0`, exit 0. If it lists violations, a site was missed in Tasks 2-4 — migrate it (or add an allow-marker with justification) and re-run.

- [ ] **Step 3: Run the full rotation — confirm still green (the new file is auto-discovered)**

Run: `node server/run-rotation.mjs`
Expected: aggregate `Failed: 0`; the new `test-class-resolution-audit` appears as PASS.

- [ ] **Step 4: Commit**

```bash
git add server/test-class-resolution-audit.mjs
git commit -m "Add class-resolution audit guard (rotation): no raw UClass primitives outside UEMCP::ResolveClass"
```

---

### Task 6: Cross-version build + live anchor-case validation + D-log

**Files:**
- Modify: `docs/tracking/risks-and-decisions.md` (append a D-log entry)

- [ ] **Step 1: Clean-build both engines (exercises both compat branches)**

For each project, sync, nuke the plugin's `Binaries`+`Intermediate`, build serially:
```
& "D:\DevTools\UEMCP\sync-plugin.bat" "<PROJ53_UPROJECT>" -y
Remove-Item -Recurse -Force "<PROJ53_DIR>\Plugins\UEMCP\Binaries","<PROJ53_DIR>\Plugins\UEMCP\Intermediate"
"/c/Program Files/Epic Games/UE_5.3/Engine/Build/BatchFiles/Build.bat" <Proj53>Editor Win64 Development -project="<PROJ53_UPROJECT>" -waitmutex
# then the 5.7 project against UE_5.7 (serially)
```
Expected: both reach `[N/N] WriteMetadata`, `UnrealEditor-UEMCP.dll` linked, 0 errors.

- [ ] **Step 2: Live anchor-case smoke on the 5.3 editor**

Launch the 5.3 editor on the 5.3 project (built in Step 1). Via the MCP client, call `add_montage_notify` with a notify class that is a `/Game` Blueprint **not opened this session** (cold). Expected: the notify resolves and is added (pre-fix this returned an unresolved-class error). Confirm the editor log shows no `Unknown notify class` failure. Close the editor.

- [ ] **Step 3: Final rotation**

Run: `node server/run-rotation.mjs`
Expected: aggregate `Failed: 0`, including `test-class-resolution-audit`.

- [ ] **Step 4: Append the D-log entry**

Append one row to `docs/tracking/risks-and-decisions.md` (next D-number; placeholder vocabulary only): summarize the consolidation — shared `UEMCP::ResolveClass` load-first resolver, the 6 migrated sites (3 asset-blind + 2 load-narrow + ReflectionWalker), the `FindObject`→`FindFirstObjectSafe` swap, the rotation guard, and that it was validated by clean builds on 5.3+5.7 plus the live cold-`/Game`-notify anchor case.

- [ ] **Step 5: Commit**

```bash
git add docs/tracking/risks-and-decisions.md
git commit -m "Class-resolution consolidation: cross-version build + live anchor-case verified (D-log)"
```

---

## Notes for the implementer
- **Line numbers are approximate** (the `≈` ones) — match on the quoted code, not the line number; the file shifts as you edit.
- **`HandlerCommon.h` include**: several handler files may already include it transitively; add the explicit `#include "HandlerCommon.h"` only if the build errors on `UEMCP::ResolveClass` being undeclared. The guard does not care about includes.
- **If a build surfaces a `FindFirstObjectSafe`/`EFindFirstObjectOptions` signature delta on some engine** (none expected — verified present in 5.3), gate it in `Public/UEMCPCompat.h` (D170), never a raw `#if` in `HandlerCommon.cpp`.
- **Do not** widen scope to UFunction/struct resolution (spec §Out of scope).
