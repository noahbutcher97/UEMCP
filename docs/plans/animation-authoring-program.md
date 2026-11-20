# U5: animation authoring program

Priority confirmed by the user on 2026-11-19: animation authoring is a leading
product feature, including Animation Blueprints, Animation Sequences, Montages
and the supporting functionality needed to complete this work. Scope includes
creating content and editing existing content. The product goal is to support
any animation work a user needs to do with Unreal. The named features and
seven areas below are examples for planning. They set no ceiling on supported
work. Individual capabilities earn support claims through tests.

## From a user task to a supported workflow

Start from the user's desired result and a way to observe it. Trace the work
across asset creation or import, editing, evaluation, correction and delivery.
Identify all assets involved, the editor or plugin that owns each operation,
the installed engine versions and the user's required execution mode. A single
task can cross several editors. For example, retargeting a captured take,
correcting a hand with a rig, baking the result and placing it in a Sequencer
shot requires verification across the retarget, rig, sequence and shot assets.

Use three routes when adding support:

1. Compose existing verified operations where they meet the complete workflow.
2. For an unfamiliar node or asset from an installed plugin, discover its
   contextual editor actions, editable settings, typed pins and references.
   Use standard editor operations where they provide the required behavior.
   Validate initialization, reconstruction, transactions and evaluation with
   a fixture for that family before advertising write support.
3. Add a focused adapter for workflows with distinct semantics, such as a
   rig hierarchy, a retarget chain, a motion-matching database rebuild, a
   Sequencer section, a simulation cache or an importer/exporter. Expose the
   result and diagnostics so it can be combined with graph and timeline edits.

Discovery should tell the caller what can be inspected, edited, compiled or
evaluated in this installation, what requires another plugin or editor, and
which behavior still needs qualification. A capability record should identify
the operation, target/context, engine and plugin versions, execution mode,
supported variations, side effects, and evidence. When a requested task falls
outside existing records, capture the concrete blocker, build the smallest
owned example, and add the missing behavior and its outcome check.

Evaluation depends on the job: bone transforms and contacts for motion, event
and marker timing for gameplay, hierarchy and key fidelity for retarget/bake,
shot playback for cinematics, fresh reload and reimport for delivered assets,
or visual review when the user is judging appearance. Track import/export,
runtime and offline limits explicitly as coverage grows.

## Capability areas

The [interactive AnimBP design](animbp-interactive-authoring.md) maps the requested
node families, graph operations and multi-asset workflows to observable acceptance tests.

| Area | Target workflows to inventory and deliver in bounded slices |
|---|---|
| U5-ABP: Animation Blueprints | Create compatible AnimBPs; create/configure/delete nodes; wire poses and data; author states, transitions and rules; variables/update logic; cached poses and linked layers; compile and diagnose failures. |
| U5-SEQ: Animation Sequences | Create/import/duplicate/reimport sequences; author or edit bone/transform keys and curves; trim, retime and resample; configure additive/reference-pose and root-motion behavior; apply modifiers and compression settings where needed. |
| U5-MON: Animation Montages | Create montages from sequences; edit slot tracks, segments, timing and play rates; sections and section links; blend settings; notifies, notify states and branching points; maintain sequence and Skeleton references. |
| U5-TIME: Shared timeline editing | List/add/update/delete curve keys, notify events and states; preserve timing across trim/retime operations; edit supported attributes and metadata; support bounded batch edits with explicit partial-failure behavior. |
| U5-SUP: Supporting animation assets | Skeleton compatibility and slot/group management; Blend Spaces, blend samples, sync markers/groups, animation composites and pose assets; connect supporting assets to the consuming sequence, montage or AnimBP workflow. |
| U5-RIG: Motion creation and conversion | Control Rig and IK/retarget workflows, pose/key editing, baking to sequences and transferring animation between compatible targets. Establish supported rig/asset types and required native APIs before implementation. |
| U5-VERIFY: Authoring feedback | Preview/scrub/play selected content; inspect resulting graphs and timeline data; report compile/validation errors; verify evaluated motion where the workflow requires it, including root-motion and event timing. |

The map is extensible: related functionality discovered through actual workflows
belongs here even if it is not listed yet. Avoid a tool-count definition of done.
For each area, inventory current tools and engine APIs before calling something
missing. Mark each operation shipped, partially supported, needs qualification,
missing or unsupported, with source evidence and an associated user workflow.

## How to deliver it

### Interactive graph experimentation is a first-class workflow

User clarification on 2026-11-19: agents must be able to drop, configure and
connect nodes ad hoc in both an AnimBP's AnimGraph and its Event Graph. Recipes
are an additional interface, not a prerequisite for editing. This includes
discovering available node actions, inspecting typed pins, setting defaults,
connecting/disconnecting/replacing links, moving/commenting/deleting nodes and
iterating on compile diagnostics. State and transition subgraphs need the same
explicit graph targeting where supported.

Allow structurally valid intermediate edits with deferred compilation and
explicit unsaved state. Distinguish mutation success from compile success and
runtime correctness. Support grouped Undo/Redo for live experiments; report
schema-driven link replacement, conversion nodes and pin reconstruction instead
of treating a connection as a single invisible edge change. Never promise every
node class works merely because arbitrary class names can be supplied.

See [research and execution model](animation-authoring-execution.md) for the
source comparison, live/headless/offline boundaries and proposed first workflow.

Select end-to-end workflows that cross areas when necessary. For example,
creating a montage from an existing sequence, adding sections and a notify,
connecting its existing slot through an AnimBP, then previewing and saving is a
coherent delivery candidate. It does not require building every sequence or rig
operation first. Editing sequence timing with consistent curve/notify behavior
is another independent candidate.

The [Slot-insertion contract](u5-animation-authoring.md) remains a scoped
component candidate. Its exclusions apply to that slice only, not the entire
program. Recent blocked user tasks should inform the first selection; while
those examples are gathered, source/API inventory and upstream comparison can
proceed. Do not stall the program solely because examples are not yet supplied.

Each selected workflow needs explicit asset/Skeleton identity, supported data
types, validation, accurate failure results, dirty/save semantics, and Undo/Redo
or a clearly declared alternative where Undo cannot apply. Prove persistence in
a fresh editor process using UEMCP-owned assets. Graph/metadata readback does not
prove evaluated motion, event timing or visual quality; test those separately
when part of the workflow. Do not promise arbitrary animation synthesis from
text merely because sequence or rig authoring is supported.

U4 provides inspection/oracles where useful. U10's release foundation supports
delivery without blocking feature implementation on a full updater. U12 supplies
focused engine/peer research and organization checks. Unrelated recovery and
architecture work do not precede this feature program by default. Compile and
live-test phases still share the machine serially.

## Starting implementation

The [interactive design and owned-editor findings](animbp-interactive-authoring.md)
specify the first complete delivery and a reproduced pose-wiring defect.
Keep expanding the capability inventory as workflows are investigated. The
first experiment covers selected AnimBP reads and writers on UE 5.8.4.
