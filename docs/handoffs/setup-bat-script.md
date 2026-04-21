# Setup Script Worker — `setup-uemcp.bat` for new-PC onboarding

> **Dispatch**: Fresh Claude Code session. Independent of all current in-flight work (M1, Oracle-A, manual testing). No file collision.
> **Type**: Implementation — one batch script + minor README/template updates.
> **Duration**: ~1 session (45-90 min — amended 2026-04-21 with browse-dialogs + plugin-copy scope).
> **Context**: Friend is onboarding to ProjectA on their own Windows machine and needs UEMCP running without manual `.mcp.json` path-munging. Current friction: manual steps (clone → npm install → edit template → copy to project root → copy plugin to project's Plugins folder → restart Claude).
> **Deliverable**: A `.bat` that runs two GUI folder/file-browse dialogs (workspace + .uproject), installs deps, plants `.mcp.json` in the workspace folder, copies the UEMCP plugin into the .uproject's `Plugins/` folder, prints next steps.

> **Amendment 2026-04-21 (scope expansion)**: Junction/symlink approach proved unreliable for UE commandlet discovery (multiple failed gate tests before concluding). New approach is **physical copy of `plugin/UEMCP` into the target project's `Plugins/` folder** — UE discovers it naturally the same way UnrealMCP gets discovered. Script automates the copy. User also browses to their preferred "Claude workspace" folder (where `.mcp.json` lands) so that Claude Code invocations from that folder pick up the UEMCP MCP server. Workspace folder may or may not be the same as the project root — user's choice.

---

## Mission

Ship `setup-uemcp.bat` at the UEMCP repo root that automates the new-PC onboarding flow. One invocation leaves the user with a working `.mcp.json` in their UE project root + dependencies installed + sanity checks passed.

This is specifically a **Windows + single-project-per-invocation** script. Cross-platform (`.sh` / cross-OS Node script) is a future enhancement, not this scope. Multi-project workspace support (the friend may later also have ProjectB) can be handled by running the script once per project.

---

## Scope — in

### §1 `setup-uemcp.bat`

Write at `D:\DevTools\UEMCP\setup-uemcp.bat` (repo root, discoverable at clone time).

**Invocation pattern** (no args — interactive-first):

```cmd
setup-uemcp.bat
```

Optional args supported for scripted/repeat invocation:

```cmd
setup-uemcp.bat [-workspace "<folder>"] [-uproject "<path.uproject>"]
```

If either arg is missing or `-interactive` is passed explicitly, the script opens GUI browse dialogs for the missing piece(s).

**Behaviors**:

1. **Detect UEMCP repo location** via `%~dp0` (script directory). Don't hardcode `D:\DevTools\UEMCP`.
2. **Validate Node.js** — check `node --version` exits 0; if not, print error pointing to https://nodejs.org and exit non-zero.
3. **Prompt for Claude workspace folder (GUI)** — the folder where the user plans to invoke Claude Code from. `.mcp.json` lands here so Claude Code auto-discovers the UEMCP MCP server on startup. May or may not be the UE project root — user's call. Use a `FolderBrowserDialog` invoked via a PowerShell one-liner:
   ```cmd
   for /f "delims=" %%I in ('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Claude workspace folder (.mcp.json will be placed here)'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }"') do set "WORKSPACE=%%I"
   ```
   If cancelled (empty result) → exit with a clear message.
   **Note on PowerShell**: CLAUDE.md normally avoids PowerShell for orchestrator/git work. GUI dialogs from a user-facing installer are a different context; PowerShell's WinForms integration is the standard Windows approach. No git or node state is touched via PowerShell.
4. **Prompt for .uproject file (GUI)** — use `OpenFileDialog` filter `Unreal Project Files|*.uproject`:
   ```cmd
   for /f "delims=" %%I in ('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Unreal Project Files|*.uproject'; $f.Title = 'Select the .uproject to enable UEMCP for'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName }"') do set "UPROJECT=%%I"
   ```
   Cancelled → exit.
5. **Derive project metadata**:
   - Project root = parent directory of the .uproject
   - Project name = .uproject basename (no extension)
   - Plugins directory = `<project_root>\Plugins`
6. **Run `npm install` in `server/`** — only if `node_modules` doesn't exist OR `package-lock.json` changed (idempotent). Surface exit code.
7. **Copy UEMCP plugin into project's Plugins folder**:
   - Source: `%~dp0plugin\UEMCP` (the plugin tree in the UEMCP repo).
   - Destination: `<project_root>\Plugins\UEMCP` (real directory — NOT a junction/symlink; that approach failed per the 2026-04-21 commandlet-discovery investigation).
   - **If destination already exists → prompt before overwrite** (Y/N, default N). An existing UEMCP install is likely from a prior run of this script, but could be manual — don't clobber silently.
   - On overwrite: `rmdir /s /q "<project_root>\Plugins\UEMCP"` then `xcopy /E /I /Y "%~dp0plugin\UEMCP" "<project_root>\Plugins\UEMCP"`.
   - **Warn if user hasn't closed the editor**: the DLL is locked while the editor runs. Script should detect (`tasklist /FI "IMAGENAME eq UnrealEditor.exe" /NH` — non-empty means running) and prompt the user to close before proceeding with the overwrite.
8. **Generate `.mcp.json`** at `<WORKSPACE>\.mcp.json`:
   - Substitute UEMCP server path (use forward slashes — Node accepts them on Windows and JSON-safe).
   - Substitute `UNREAL_PROJECT_ROOT` = project root (forward slashes).
   - Substitute `UNREAL_PROJECT_NAME` = project name.
   - Preserve the other env keys from `.mcp.json.example` (ports, timeout, auto_detect).
   - **If `.mcp.json` already exists at target → prompt before overwrite** (Y/N, default N). Don't silently clobber a manual setup.
9. **Verify**:
   - New `.mcp.json` is valid JSON (trivial — `node -e "JSON.parse(require('fs').readFileSync(...))"`).
   - Plugin DLL path exists at `<project_root>\Plugins\UEMCP\Binaries\Win64\UnrealEditor-UEMCP.dll` (if not, print "plugin not yet compiled — run editor once to trigger build, OR run your Build.bat").
   - Print the next-step message: (a) open the UE project once to compile/load the plugin, (b) cd to WORKSPACE + run Claude Code, (c) confirm via `find_tools({ query: "ping" })` after TCP:55558 comes up.
10. **Exit codes**: 0 success, 1 bad args / missing deps / cancelled dialog, 2 npm install failure, 3 plugin copy failure, 4 .mcp.json write failure.

### §2 `.mcp.json.example` — convert to true template

The current `.mcp.json.example` has hardcoded paths. Refactor to use obvious placeholders so humans can still edit manually if they skip the script:

```json
{
  "mcpServers": {
    "uemcp": {
      "command": "node",
      "args": ["<UEMCP_REPO_PATH>/server/server.mjs"],
      "env": {
        "UNREAL_PROJECT_ROOT": "<UNREAL_PROJECT_ROOT>",
        "UNREAL_PROJECT_NAME": "<UNREAL_PROJECT_NAME>",
        "UNREAL_TCP_PORT_EXISTING": "55557",
        "UNREAL_TCP_PORT_CUSTOM": "55558",
        "UNREAL_TCP_TIMEOUT_MS": "5000",
        "UNREAL_RC_PORT": "30010",
        "UNREAL_AUTO_DETECT": "true"
      }
    }
  }
}
```

The script reads this file, substitutes the placeholders, writes to target. Humans who want manual setup edit the example and copy themselves.

### §3 README / CLAUDE.md onboarding note

Add a small section to `CLAUDE.md` under `## Common Tasks` (or near the `.mcp.json` discussion in `## MCP Configuration Files`):

```markdown
### Onboarding a new machine

Run `setup-uemcp.bat "<path-to-your-project.uproject>"` from the UEMCP
repo root. The script installs dependencies, generates `.mcp.json` in
your project root, and prints next-step guidance.

Manual setup (skip the script): copy `.mcp.json.example`, substitute
`<UEMCP_REPO_PATH>` + `<UNREAL_PROJECT_ROOT>` + `<UNREAL_PROJECT_NAME>`,
and place at your UE project root.
```

Don't rewrite the existing MCP Configuration Files section — just add the new subsection.

### §4 Testing (self-validation)

Run your script against a test path to prove it works. Suggested tests:

**Test 1 — Interactive (browse dialogs)**: double-click `setup-uemcp.bat` in Explorer. Verify both GUI dialogs appear and accept user selection.

**Test 2 — Scripted with explicit args**:
```cmd
setup-uemcp.bat -workspace "D:\UnrealProjects\5.6\ProjectA" -uproject "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject"
```

Expected:
- Prompts "overwrite plugin?" since `Plugins\UEMCP` already exists on ProjectA post-2026-04-21-copy → answer N to preserve, verify clean exit.
- Prompts "overwrite .mcp.json?" if one exists → answer N, verify clean exit.
- Answer Y to both → regenerates plugin + .mcp.json, verify destinations updated.

**Test 3 — Cancel path**: run interactive, cancel the first dialog, verify clean exit with "cancelled" message, no files changed.

**Test 4 — Editor running**: open UnrealEditor, then run script with Y-to-overwrite-plugin. Verify script detects the running editor and warns before attempting the DLL overwrite.

Record test commands + outputs in your final report.

---

## Scope — out

- **Cross-platform** (`.sh`, Node-based setup) — future enhancement, separate handoff if ever needed.
- **Multi-project batch onboarding** — run the script once per project.
- **Claude Desktop `claude_desktop_config.json` generation** — that's Cowork-mode-specific; stay out of scope here.
- **npm package publishing** — UEMCP is not an npm package and shouldn't try to become one here.
- **Auto-update / version check** — not this scope.
- **Perforce integration** — the friend uses P4 for ProjectA content, but UEMCP itself is git. No P4 logic in the script. If overwriting an existing `Plugins/UEMCP` triggers P4 locked-file errors, the prompt should let the user know to `p4 edit` or handle manually.
- **Engine version detection** — `UNREAL_AUTO_DETECT: "true"` already signals the server to handle this; don't reimplement it in .bat.
- **Plugin compilation** — the script copies source + prior-built binaries but does NOT invoke UBT. User needs to rebuild via editor or Build.bat. Note this explicitly in the next-step message.
- **Junction/symlink fallback** — deliberately NOT offered. The 2026-04-21 investigation established that junction-based plugin discovery is unreliable in commandlet mode. Physical copy is the supported approach.

---

## Reference files

1. `D:\DevTools\UEMCP\.mcp.json.example` — current template (refactor to proper placeholders per §2).
2. `D:\DevTools\UEMCP\CLAUDE.md` — `## MCP Configuration Files` section (~line 210-ish); `## Common Tasks` section above it.
3. `D:\DevTools\UEMCP\server\package.json` — npm install target.
4. `D:\DevTools\UEMCP\.gitignore` — verify `.mcp.json` isn't globally ignored (it's not currently — `.mcp.json` at repo root is tracked per `git check-ignore` test).

---

## Success criteria

1. `setup-uemcp.bat` exists at repo root, is runnable from cmd.exe with no special setup.
2. Running it with `"<projecta-path>.uproject"` on the friend's machine (hypothetically) produces a working `.mcp.json` at their ProjectA project root.
3. Running it twice does not clobber without a prompt.
4. Missing Node.js prints a clear error with a pointer.
5. `.mcp.json.example` refactored to use `<PLACEHOLDER>` syntax so manual setup still works.
6. CLAUDE.md has a short onboarding subsection referencing the script.
7. Test rotation unaffected — this worker does not touch `server/` code or `tools.yaml`, so baseline stays at 899.

---

## Constraints

- **Windows-only**. Bat file. Use `%VAR%` for env vars, `%~dp0` for script dir, `%~f1` for resolved arg path.
- **No PowerShell invocations** from the bat — CMD.exe-native commands only (per CLAUDE.md shell guidance). `for /f` loops OK; `jq` not available, keep JSON generation simple (substring replacement or `node -e` helper).
- **Desktop Commander for git** if committing. Native Git Bash or CMD both fine.
- **Path-limited commits per D49** — `git commit setup-uemcp.bat .mcp.json.example CLAUDE.md -m "..."`.
- **No AI attribution**.
- **Parallel workers**: M1 in `plugin/UEMCP/`, Oracle-A queued (held for M1 scaffold), M-spatial manual testing in `docs/testing/`. Your scope — repo root + `.mcp.json.example` + CLAUDE.md — has zero collision with any of them.

---

## JSON-generation technique (practical note)

CMD's string handling makes JSON generation painful. Practical options:

**Option A — Substitution with `powershell -Command`** (banned by CLAUDE.md — CMD-only).

**Option B — `node -e` helper** (preferred):
```cmd
node -e "const fs=require('fs'); const tpl=fs.readFileSync('.mcp.json.example','utf8'); const out=tpl.replace(/<UEMCP_REPO_PATH>/g, '%UEMCP_PATH%').replace(/<UNREAL_PROJECT_ROOT>/g, '%PROJECT_ROOT%').replace(/<UNREAL_PROJECT_NAME>/g, '%PROJECT_NAME%'); fs.writeFileSync('%TARGET_MCP_JSON%', out);"
```

Works because Node is already a prerequisite (we checked in step §1.2). No shell quoting hell.

**Option C — pure-cmd `for /f` line loop with echo substitutions** — works but fragile. Don't bother if Option B is available.

Recommend **Option B**. Reuses the node-is-installed check from step §1.2 as a hard precondition.

---

## Final report to orchestrator

Report (keep under 300 words):
1. Commit SHA.
2. Script path + size (LOC).
3. Test invocations run + their outputs (paste a minimal transcript).
4. `.mcp.json.example` before/after — what placeholders chosen.
5. CLAUDE.md section added — quote the paragraph.
6. Edge cases flagged (paths with spaces, UNC paths, missing Node, existing .mcp.json, etc.) — which handled, which left as known issue.
7. Next action for orchestrator: merge the PR; friend can onboard ProjectA immediately once it lands on main.
