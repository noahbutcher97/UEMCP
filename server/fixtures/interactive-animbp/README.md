# Interactive blend fixture

This editor-only overlay authors two constant sequences on an owned copy of the TutorialTPP Skeleton and mesh. It seeds the two sequence players, with PoseA initially connected to the root. The stdio MCP client authors the update logic, places the blend and wires the pins. The fixture module independently traverses the live graphs and samples a skeletal mesh component running the generated AnimInstance.

1. Stage and validate a fresh [owned host](../../../docs/fixture-host.md). For an older engine, use the matching owned host module from the local inventory and verify its original files against its manifest.
2. Copy `AnimBlendProbe.h` and `AnimBlendProbe.cpp` from this directory into the stage's `host/Source/UEMCPFixture/`. Add `AnimGraph`, `AnimGraphRuntime` and `Json` to that module's private editor dependencies. Build `UEMCPFixtureEditor Win64 Development` with the engine recorded in the stage manifest. Keep the original manifest and record the overlay and built DLL hashes separately.
3. With the editor closed, run these commands from the repository root. Supply a new asset label for each authoring run and retain the same label for its reload. Receipt paths must be outside the project Content directory.

```text
node server/fixtures/interactive-animbp/run.mjs <stage> <engine-root> <receipt-directory> <asset-label>
node server/fixtures/interactive-animbp/run.mjs <stage> <engine-root> <receipt-directory> <asset-label> reload
```

The isolated stdio server enables its existing Python execution tool for the host module's Undo, Redo and component sampling calls. Independent graph snapshots come from a separate native traversal requested by the fixture tick.

Each live run verifies its own editor PID and project before MCP edits. Read the phase results, MCP transcript, independent graph snapshots and motion samples together. The input variable is `Drive`. The Event Graph copies it to `LeanAlpha`, which feeds the AnimGraph getter. After three updates of 1/30 second, parent-local pelvis translations must be (10, 3, 7), (30, 3, 7) and (50, 3, 7) cm for inputs 0, 0.5 and 1. Translation tolerance is 0.01 cm per axis. A disconnected alpha must break the response. The driver uses seeded sequence players and measures a bone numerically in an editor-world component.

The runner checks hashes of project content and editor dirty packages around interactive authoring. The deliberately broken function call and the optional-pin reconstruction are fixture operations. Saving goes through MCP for the named AnimBP after successful repair and compilation. Fresh-load qualification compares pin identities, member bindings, values, layout, edges, and bone samples in a second editor process.

## Montage Slot run

Use `slot` and `slot-reload` as the final arguments to the two commands above. Set `UEMCP_SLOT_FIXTURE_PYTHON=1` for the isolated test process to opt into its existing Python probe. Ordinary callers use the typed `insert_anim_slot` operation.

The runner inserts an existing FixtureMontage between the driven blend and the AnimGraph root. An independent reader compares every existing pin and checks the Skeleton groups and slots. On the generated AnimInstance it starts a transient looping montage from PoseB with zero blend times, then stops it. After three 1/30-second ticks per observation, the parent-local pelvis must move from (10, 3, 7) to (50, 3, 7) and return to (10, 3, 7) cm, within 0.01 cm. Playing the same montage on the original route must leave the pelvis at (10, 3, 7). The fresh process repeats the routed measurements.

## State machines, cached poses and dynamic disconnects

Run the author and reload commands above with a fresh asset label for each row. Reuse that label for its reload. Each pair starts from its own AnimBP in the owned project.

| Author mode | Reload mode | Acceptance check |
| --- | --- | --- |
| `states` | `states-reload` | Add a machine, two sequence-backed states and a directed threshold rule. Track the active state and transition on the same generated AnimInstance as the pelvis moves between both reference poses. |
| `cache` | `cache-reload` | Create a Save and two independently placed Uses, change the saved input, rename the Save, and inspect both serialized references. Compare each user's evaluated pose and the final route. |
| `disconnect` | `disconnect-reload` | Disconnect one typed Format Text argument, check the restored wildcard type, Undo/Redo the edit, and compare the saved graph with native readback. |

`get_anim_graph` with pin topology enabled returns the graph GUID and topology revision used for edits. `add_anim_state_machine` returns the child graph GUID for `add_anim_state` and `add_anim_transition`. The transition rule compares a numeric member with a threshold. `edit_anim_cached_pose` accepts a Save node GUID when adding a Use or renaming the Save. Compile the completed graph and save the named AnimBP explicitly.
