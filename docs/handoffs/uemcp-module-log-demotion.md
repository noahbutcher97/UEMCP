# UEMCPModule Log-Demotion — nano-handoff

> **Dispatch**: Fresh Claude Code session OR fold inline into any plugin-touching commit. **Micro-scope** — single file, ~2 lines.
> **Type**: Implementation — cleanup of diagnostic Warning-level log added during D61 debug arc.
> **Duration**: 5-10 min.
> **D-log anchors**: D61 deferred follow-on ("Diagnostic log cleanup deferred: UEMCPModule.cpp:113 is Warning-level — demote to Log or remove once M-new Oracle-A has exercised the gate independently").
> **Deliverable**: demote `UE_LOG(LogUEMCP, Warning, TEXT("UEMCP StartupModule entered (pre-gate diagnostic)"))` from Warning to Log level in `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp`.

---

## Mission

During the D61 debug arc, we added a Warning-level log at the top of `FUEMCPModule::StartupModule` to confirm the module was loading at all (we were chasing a UBT-stale-DLL issue; the log told us "module loads → gate logic is the remaining variable"). The log served its debug purpose and is now verified unnecessary at Warning level.

**Why demote rather than delete**: the log is useful at `Log` severity for any future plugin-load diagnostics (new dev machine setup, onboarding friction, commandlet mode triage). At `Warning` it pollutes editor console every launch.

---

## Scope — in

### §1 The change

Edit `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp`:

Current (line ~113):
```cpp
// Diagnostic line (D61, to remove once module-load reliability confirmed):
// Warning-level forces emit even without -LogCmds="LogUEMCP Verbose". If this
// line does NOT appear in commandlet logs, the module itself isn't loading.
// If it DOES appear, the gate logic below is the remaining variable.
UE_LOG(LogUEMCP, Warning, TEXT("UEMCP StartupModule entered (pre-gate diagnostic)"));
```

Target:
```cpp
UE_LOG(LogUEMCP, Log, TEXT("UEMCP: StartupModule entered"));
```

- Demote `Warning` → `Log`.
- Remove the 3-line debug-rationale comment (preserved in git history + D61).
- Normalize the message format to match the `Log` elsewhere in the file (e.g., `"UEMCP: TCP server listening on port %d"` convention — colon after module prefix).

### §2 Verification

After the edit:
1. Rebuild the plugin using the D61 nuke recipe (or a fresh Build.bat invocation — your call based on UBT cache state).
2. Re-run `test-uemcp-gate.bat` to confirm gate still [PASS].
3. Launch the editor once; confirm the new Log-level line appears when `-LogCmds="LogUEMCP Verbose"` is set and DOES NOT appear at default verbosity.

### §3 Commit

Path-limited commit to just `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp`. Short commit message referencing D61 follow-on.

---

## Scope — out

- Any other plugin source edits.
- Any server, yaml, docs, or test edits.
- UBT configuration changes.
- Module-load diagnostics refactor (if needed later, separate worker).

---

## Reference files

1. `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp` — the edit target.
2. `docs/tracking/risks-and-decisions.md` D61 (context for why the Warning was added + why it's now safe to demote).
3. `test-uemcp-gate.bat` — verification harness; confirm [PASS] post-edit.

---

## Success criteria

1. `UEMCPModule.cpp:113` line is `UE_LOG(LogUEMCP, Log, ...)` not `Warning`.
2. Debug-rationale comment block removed (3 lines).
3. Post-rebuild gate test [PASS] unchanged from D61 baseline.
4. Commit SHA reported, path-limited to the one .cpp file.

---

## Constraints

- **Desktop Commander for git**.
- **No AI attribution**.
- **Path-limited**: only UEMCPModule.cpp.
- **Rebuild required** — a comment-only change wouldn't need one, but `UE_LOG` verbosity is compile-time so the DLL must regenerate.

---

## Final report to orchestrator

Report (under 100 words):
1. Commit SHA.
2. Rebuild result (clean / stale-DLL nuke needed / any surprises).
3. Gate-test result post-rebuild (should be [PASS] unchanged).
4. Next action: D61 follow-on closed.
