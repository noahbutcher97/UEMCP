# Oracle-A-v2 Worker — pin_name emit + fixture regen

> **Dispatch**: Fresh Claude Code session. **No file-level collision** with in-flight S-B-base worker (plugin-side scope; S-B-base is server-side). Dispatch NOW.
> **Type**: Implementation — minimal C++ amendment to `EdgeOnlyBPSerializer.cpp` + fixture regeneration + schema version bump.
> **Duration**: 30-60 min.
> **D-log anchors**: D67 (Path C pivot after Path A empirically failed + Path B rejected on D52 near-parity grounds), D62 (Oracle-A v1 landed).
> **Deliverable**: Oracle JSONs emit `"pin_name"` alongside `pin_id` key per pin, enabling S-B-base differential harness to match by (node_guid, pin_name) tuples instead of (node_guid, pin_id). Schema version bumps `oracle-a-v1` → `oracle-a-v2`.

---

## Mission

S-B-base worker discovered that UE regenerates pin IDs on every load for K2Node_EditablePinBase subclasses (FunctionEntry, FunctionResult, CustomEvent) and K2Node_PromotableOperator via `PostLoad → ReconstructNode → AllocateDefaultPins` which calls `FGuid::NewGuid()`. The on-disk PinId reflects some prior load session's random GUIDs; the in-memory PinId is this load's random GUIDs. They can NEVER agree across separate loads. Path A (re-save fixtures) verified negative.

Pin names, in contrast, are stable. `PinName` is declared by the node type (e.g., "then", "Target", "ReturnValue") and persists through regeneration. Differential harness matching by (node_guid, pin_name) is robust.

Your job: emit `pin_name` alongside `pin_id` in Oracle-A's output, then regenerate all 6 fixtures so S-B-base can resume.

---

## Scope — in

### §1 Plugin amendment

Edit `plugin/UEMCP/Source/UEMCP/Private/Commandlets/EdgeOnlyBPSerializer.cpp`:

Current shape:
```json
"<pin_id_guid>": {
  "direction": "EGPD_Input",
  "linked_to": [...]
}
```

Target shape:
```json
"<pin_id_guid>": {
  "name": "<FName PinName.ToString()>",
  "direction": "EGPD_Input",
  "linked_to": [...]
}
```

Implementation: wherever the serializer emits per-pin JSON (should be a single location — the pin-body builder), add:
```cpp
PinJson->SetStringField(TEXT("name"), Pin->PinName.ToString());
```

Also update `schema_version` emit from `"oracle-a-v1"` to `"oracle-a-v2"` (single-line change at the top-level object builder).

### §2 Plugin rebuild

- Clean rebuild per D61 nuke recipe if needed:
  ```cmd
  rmdir /s /q "D:\UnrealProjects\5.6\ProjectA\ProjectA\Plugins\UEMCP\Binaries"
  rmdir /s /q "D:\UnrealProjects\5.6\ProjectA\ProjectA\Plugins\UEMCP\Intermediate"
  "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" ProjectAEditor Win64 Development -project="D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -WaitMutex
  ```
- Alternative: if D61 recipe not needed (rare for single-file edits), just `Build.bat` directly.
- **Source-of-truth vs deployed copy**: edit `D:\DevTools\UEMCP\plugin\UEMCP\Source\UEMCP\Private\Commandlets\EdgeOnlyBPSerializer.cpp`, then use `sync-plugin.bat "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -y` to propagate to deployment dir before rebuild. OR edit the deployed copy directly and git-copy back to source-of-truth post-verification.
- Editor must be closed during rebuild.

### §3 Fixture regen

After plugin compiles cleanly:

```cmd
set UE_CMD="C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
set UPROJ=D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject
set FIX=D:\DevTools\UEMCP\plugin\UEMCP\Source\UEMCP\Private\Commandlets\fixtures

%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR -Out=%FIX%\BP_OSPlayerR.oracle.json -Pretty -unattended -nop4 -nosplash
%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR_Child -Out=%FIX%\BP_OSPlayerR_Child.oracle.json -Pretty -unattended -nop4 -nosplash
%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR_Child1 -Out=%FIX%\BP_OSPlayerR_Child1.oracle.json -Pretty -unattended -nop4 -nosplash
%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR_Child2 -Out=%FIX%\BP_OSPlayerR_Child2.oracle.json -Pretty -unattended -nop4 -nosplash
%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Character/TestCharacter -Out=%FIX%\TestCharacter.oracle.json -Pretty -unattended -nop4 -nosplash
%UE_CMD% %UPROJ% -run=DumpBPGraph -BP=/Game/Blueprints/Level/BP_OSControlPoint -Out=%FIX%\BP_OSControlPoint.oracle.json -Pretty -unattended -nop4 -nosplash
```

**Git Bash caveat**: if running from Git Bash rather than cmd.exe, `/Game/...` paths get mangled to `C:/Program Files/Git/Game/...`. Either use `cmd.exe` directly or prefix shell session with `MSYS_NO_PATHCONV=1` (documented in `fixtures/fixtures.txt §Regenerating oracles`).

Editor must be closed for commandlet to load project.

### §4 Verification

Grep for the new shape in at least BP_OSPlayerR.oracle.json:
```cmd
findstr "schema_version" "%FIX%\BP_OSPlayerR.oracle.json"
```
Should show `"schema_version": "oracle-a-v2"`.

```cmd
findstr /c:"\"name\":" "%FIX%\BP_OSPlayerR.oracle.json" | findstr /v "class_name"
```
Should return many hits — one per pin. If zero hits, the serializer amendment didn't land.

Spot-check BP_OSPlayerR:
- Open the JSON, find `ApplyVFX_Niagara` graph → `K2Node_FunctionEntry` node → its pins should now each have a `"name"` field (values like `"then"`, `"ReturnValue"`, parameter names like `"Target"`, `"NiagaraSystem"`, etc.)

### §5 Commit

Path-limited per D49:
- `plugin/UEMCP/Source/UEMCP/Private/Commandlets/EdgeOnlyBPSerializer.{h,cpp}`
- `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/*.oracle.json` (all 6 regenerated)
- `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/README.md` (add a brief note about `name` field + schema v2 + why)

Commit message template:
```
Oracle-A-v2: emit pin_name alongside pin_id for S-B-base differential

Per D67, UE regenerates pin IDs on every load for K2Node_EditablePinBase
subclasses + K2Node_PromotableOperator (PostLoad → ReconstructNode →
AllocateDefaultPins via FGuid::NewGuid). Disk pin IDs are load-session-
ephemeral and can never match post-load oracle across separate loads.

Pin names are stable (declared by node type, persist through regen).
Amending Oracle-A to emit `name` alongside pin_id key in each pin dict
lets S-B-base's differential harness match by (node_guid, pin_name)
tuples instead of (node_guid, pin_id).

Schema bumps oracle-a-v1 → oracle-a-v2. All 6 fixtures regenerated.
```

---

## Scope — out

- Server-side differential harness switch — S-B-base worker's scope in server/*.
- Fixture corpus changes — don't add/remove BPs, just regen existing 6.
- Other Oracle-A enhancements (e.g., pin_type emission) — out of scope unless trivially in the same builder call.
- Rebuilding under D61 nuke recipe if straight `Build.bat` works — only nuke if you hit UBT cache staleness.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D67 (root-cause + Path C rationale), D62 (Oracle-A v1 landing), D61 (UBT-stale-DLL nuke recipe).
2. S-B-base worker's Session 1 final report (conversation context).

### Tier 2 — Code
3. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/EdgeOnlyBPSerializer.cpp` — the file you edit.
4. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPGraphCommandlet.cpp` — entry point (should not need edits).
5. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/README.md` — update `schema_version` reference + pin-shape example.

### Tier 3 — Dev infrastructure
6. `sync-plugin.bat` at repo root — for source-of-truth → deployed copy propagation.
7. `test-uemcp-gate.bat` at repo root — smoke test post-rebuild (should still [PASS]).

---

## Success criteria

1. `EdgeOnlyBPSerializer.cpp` emits `"name"` field in each per-pin JSON.
2. `schema_version` top-level field reads `"oracle-a-v2"`.
3. Plugin compiles cleanly (no C++ errors, no UBT warnings).
4. `test-uemcp-gate.bat` [PASS] — D57 gate not regressed.
5. All 6 fixtures regenerated via commandlet, exit 0.
6. Each fixture's pins have `"name"` field populated.
7. `fixtures/README.md` updated to document schema v2 + pin-name field.
8. Path-limited commit lands cleanly.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope to `plugin/UEMCP/Source/UEMCP/Private/Commandlets/*`.
- **No server-side edits** — that's S-B-base's territory; file-level collision if you touch it.
- **No AI attribution**.
- **Use `sync-plugin.bat`** to propagate source-of-truth → deployed copy before rebuild (or edit deployed copy directly and copy back).
- **Editor must be closed** during plugin rebuild AND during fixture regen.
- **D61 nuke recipe** available if UBT cache serves stale DLL — symptoms: `.cpp` mtime newer than DLL mtime, compile claims "no work to do" in <1s.

---

## Final report to orchestrator

Report (under 150 words):
1. Commit SHA.
2. Plugin compile status (clean / required nuke / other surprises).
3. Fixture regen: 6/6 exit 0? Wall-clock per BP.
4. Sample pin_name values from BP_OSPlayerR ApplyVFX_Niagara K2Node_FunctionEntry (should be recognizable parameter names like `"Target"`, `"NiagaraSystem"`, etc.).
5. Schema version confirmed `oracle-a-v2`.
6. Gate-test regression check: [PASS] preserved?
7. Next action: S-B-base worker resumable — differential harness switch to name-based matching, continue CP3-6 per §8 checkpoints.

If you hit a blocker (`PinName.ToString()` doesn't compile, Plugin rebuild fails with new error, fixture regen fails for a specific BP), surface within the first session.
