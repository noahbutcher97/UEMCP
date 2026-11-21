# Testing UEMCP from an agent CLI

A usable tool lets someone describe an editor change in their own words, discover what is available, recover from a mistake, and tell whether the right asset changed. Include this check when a release changes tool discovery, project attachment, editor authoring, permissions, or user-visible results.

1. Pick a concrete outcome and write down the independent check before starting. Use a UEMCP-owned project, uniquely named fixture assets, and the public stdio server. Record the client and server versions, editor version, initial graph or package state, and available permissions.
2. Start from the same folder, login state and client configuration a user would use. Supply the task and ordinary context, such as a Content Browser path. Let the client find tool names, node IDs and required arguments. Keep evaluator scripts and test-only tools out of the agent's tool surface.
3. Exercise a successful task and a realistic recovery. Examples include choosing between similarly named assets, running with a closed editor, or replacing an occupied pose input. State which edits or saves the person requested. If the client needs clarification, record the actual question and the smallest information needed to continue.
4. Compare the final answer with an independent Unreal observation. For graph changes, inspect the actual pins and reciprocal links. For saved changes, reopen the asset in a fresh editor. For claims about motion, sample the evaluated pose. Check unrelated package hashes when the task requests a targeted edit.
5. Record the plain-language prompt, elapsed time, discovery calls, rejected actions, retries, user interventions and final result. Report the client's wording when it helps explain friction. Keep credentials, private project names and raw account configuration out of shared reports. Give each verified issue a reproduction and a disposition, then repeat the original task after a fix.

One engine and one client can establish a reproduction. For a provider-neutral editor workflow, qualify the behavior on each claimed engine and run the same plain-language task through each available agent CLI on those engines. List unavailable Unreal installations and clients that cannot reach UEMCP. If a client fails at login or model selection before it contacts the editor, record that prerequisite once across the affected engine rows. Record the CLI, model route, starting directory and configuration scope. Mark retries with a different route or additional guidance separately.

Score the engine and agent results independently. For example, an editor can reproduce a bad pin default while one agent finds both values, another stops at offline inspection, and a third never reaches the project. To count a diagnosis as passed, retain the agent's delivered answer and the tool responses that support it, then compare it with an independent observation. An exit code or a plausible answer alone cannot establish that the agent inspected the intended asset. Identify terminal interaction, non-interactive CLI runs, scripted MCP tests and observed human sessions separately.

### When the first call fails

- If the client blocks even `connection_info`, check its MCP tool approval settings. An unattended Codex session with approvals set to `never` can reject the call before UEMCP receives it. For an owned test, authorize the specific read or edit tools for that session. Keep a record of which approval was required.
- If UEMCP reports an unresolved project, start the client in the folder containing the intended `.uproject`, or supply its full path for `attach_project`. An outside-root attachment requires explicit authorization for that exact project. Confirm the project identity before editing.
- Treat project attachment and editor availability as separate results. An attached project can still have an unreachable editor. If the editor is closed, report which offline information was available and which live action is waiting for a running editor with the matching plugin.

For interactive animation, a practical task is to open a Blueprint in an owned editor, ask which animation currently supplies its output pose, then ask to switch to the other existing sequence and save just that Blueprint. A successful read identifies the current source without mutating the asset. A successful edit leaves one reciprocal source, persists after reopening, and produces the expected evaluated pose. The [interactive fixture](../server/fixtures/interactive-animbp/README.md) supplies compatible sequences and an independent graph and bone sampler.

### Checks that transfer to other workflows

- When a tool reads several states, give the agent a case where they diverge. An unsaved graph edit, for example, lets the evaluator check whether the answer distinguishes the saved file, open editor and observed runtime. Require evidence for each state the answer claims to know.
- For inspection tasks, check the calls the client could make and the calls it actually made. A compile can change editor state while leaving every monitored file byte identical.
- For an operation with optional defaults, exercise a plausible misspelled or misplaced value through the normal client. Inspect the saved value and the resulting behavior. An OpenCode run wired the right input event but a stripped setter argument left the pawn false on press. [Graph placement qualification](plans/graph-action-placement-qualification.md)
- For an edit a user may retry, define the requested outcome first. Repeating “ensure this binding exists” should leave one binding. Asking for another player instance should create a second instance. Read back the exact targets and their counts after recovery.
- Record separately what the tool did, what the agent concluded and whether the user's intended outcome occurred. Choose an independent observation appropriate to that outcome, such as actual cue delivery for a playback claim. The [three-engine qualification](plans/animation-inspection-and-montage-decisions.md#agent-workflow-results) shows how these judgments can differ on the same task.

### OpenCode permissions for an inspection-only session

With a local MCP server named `uemcp`, add the following `permission` field to the task's OpenCode configuration. This grants project attachment, discovery and reads through the public dispatcher. Searching may register additional direct tool names during the session. The initial deny rule applies to those names, including `uemcp_bp_compile_and_report`, and to `uemcp_call_mutating_tool`. Keep this scope specific to an inspection task.

```json
{
  "permission": {
    "*": "deny",
    "uemcp_attach_project": "allow",
    "uemcp_connection_info": "allow",
    "uemcp_describe_tool": "allow",
    "uemcp_find_tools": "allow",
    "uemcp_call_tool": "allow",
    "uemcp_list_toolsets": "allow",
    "uemcp_wait_for_editor": "allow",
    "uemcp_refresh_project_context": "allow",
    "uemcp_inspect_blueprint_inputs": "allow"
  }
}
```

An unrestricted `uemcp_*` permission let one OpenCode inspection run recompile a Blueprint through its directly registered diagnostic tool. The package and sidecar hashes remained equal. Check the tool transcript as well as file hashes when assessing side effects.
