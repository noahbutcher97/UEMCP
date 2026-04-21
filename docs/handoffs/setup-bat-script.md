# Setup Script Worker — `setup-uemcp.bat` for new-PC onboarding

> **Dispatch**: Fresh Claude Code session. Independent of all current in-flight work (M1, Oracle-A, manual testing). No file collision.
> **Type**: Implementation — one batch script + minor README/template updates.
> **Duration**: ~1 session (30-60 min).
> **Context**: Friend is onboarding to ProjectA on their own Windows machine and needs UEMCP running without manual `.mcp.json` path-munging. Current friction: 5-step manual process (clone → npm install → edit template → copy to project root → restart Claude).
> **Deliverable**: A single `.bat` that takes the friction to a one-liner: `setup-uemcp.bat "<path-to-ProjectA.uproject>"`.

---

## Mission

Ship `setup-uemcp.bat` at the UEMCP repo root that automates the new-PC onboarding flow. One invocation leaves the user with a working `.mcp.json` in their UE project root + dependencies installed + sanity checks passed.

This is specifically a **Windows + single-project-per-invocation** script. Cross-platform (`.sh` / cross-OS Node script) is a future enhancement, not this scope. Multi-project workspace support (the friend may later also have ProjectB) can be handled by running the script once per project.

---

## Scope — in

### §1 `setup-uemcp.bat`

Write at `D:\DevTools\UEMCP\setup-uemcp.bat` (repo root, discoverable at clone time).

**Invocation pattern**:

```cmd
setup-uemcp.bat "C:\Path\To\ProjectA\ProjectA.uproject"
```

Or with no args → prompt interactively.

**Behaviors**:

1. **Detect UEMCP repo location** via `%~dp0` (script directory). Don't hardcode `D:\DevTools\UEMCP`.
2. **Validate Node.js** — check `node --version` exits 0; if not, print error pointing to https://nodejs.org and exit non-zero.
3. **Accept target project path**:
   - If `%~1` (arg 1) non-empty → use it.
   - Else → `set /p "PROJECT_PATH=Enter path to .uproject file: "` interactive prompt.
4. **Validate project path**:
   - Exists on disk.
   - Extension is `.uproject`.
   - Derive project root = directory containing the .uproject.
   - Derive project name = basename without extension.
5. **Run `npm install` in `server/`** — only if `node_modules` doesn't exist OR `package-lock.json` changed (idempotent). Surface exit code.
6. **Generate `.mcp.json`** at `<project_root>\.mcp.json`:
   - Substitute UEMCP server path (use forward slashes — Node accepts them on Windows and JSON-safe).
   - Substitute `UNREAL_PROJECT_ROOT` = project root (forward slashes).
   - Substitute `UNREAL_PROJECT_NAME` = project name.
   - Preserve the other env keys from `.mcp.json.example` (ports, timeout, auto_detect).
   - **If `.mcp.json` already exists at target → prompt before overwrite** (Y/N, default N). Don't silently clobber a manual setup.
7. **Verify**:
   - New `.mcp.json` is valid JSON (trivial — `node -e "JSON.parse(require('fs').readFileSync(...))"`).
   - Print the next-step message (how to start Claude Code + what to expect).
8. **Exit codes**: 0 success, 1 bad args / missing deps, 2 npm install failure, 3 .mcp.json write failure.

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

Run your script against a test path to prove it works. Suggested test:

```cmd
setup-uemcp.bat "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject"
```

Expected: regenerates `D:\UnrealProjects\5.6\ProjectA\.mcp.json` with substituted paths. Since this `.mcp.json` already exists, the script should prompt "overwrite? Y/N" — answer N to preserve it, verify script exits cleanly. Then try again with a sacrificial path (e.g., a temp dir with a fake `.uproject`) to exercise the write path.

Record test commands + outputs in your final report.

---

## Scope — out

- **Cross-platform** (`.sh`, Node-based setup) — future enhancement, separate handoff if ever needed.
- **Multi-project batch onboarding** — run the script once per project.
- **Claude Desktop `claude_desktop_config.json` generation** — that's Cowork-mode-specific; stay out of scope here.
- **Plugin install** — the UEMCP plugin (once it exists post-M1) goes in the UE project's `Plugins/` folder; different flow, different handoff.
- **npm package publishing** — UEMCP is not an npm package and shouldn't try to become one here.
- **Auto-update / version check** — not this scope.
- **Perforce integration** — the friend uses P4 for ProjectA content, but UEMCP itself is git. No P4 logic in the script.
- **Engine version detection** — `UNREAL_AUTO_DETECT: "true"` already signals the server to handle this; don't reimplement it in .bat.

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
