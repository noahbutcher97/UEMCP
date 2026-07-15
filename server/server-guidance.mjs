export const utf8Bytes = value => Buffer.byteLength(value, 'utf8');
export const SERVER_PREFIX_LIMIT_BYTES = 512;
export const SERVER_INSTRUCTION_LIMIT_BYTES = 2048;
export const TOOL_DESCRIPTION_LIMIT_BYTES = 1800;

export const SERVER_INSTRUCTIONS = [
  'UEMCP provides Unreal Engine project, asset, Blueprint, level, animation, editor, and runtime tools. Use it for UE-specific inspection or mutation that ordinary filesystem and search tools cannot perform. Start with connection_info to verify project, deployment, and editor context. Call find_tools(query) to discover and enable the smallest relevant toolset. Offline tools read project files without an editor; live tools require the matching editor.',
  'Disable unused toolsets to reduce context. list_config_values is progressive: call with no arguments for files, with a file for sections, and with a file and section for keys and values. search_gameplay_tags accepts * for one path level and ** across levels.',
].join(' ');

export const TOOLSET_TIPS = Object.freeze({
  'actors': {
    core: [
      'spawn_actor supports only 5 types: StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor.',
      'Actor names are exact-match lookups (case-sensitive). Use find_actors(pattern) for substring search, get_actors() for full list.',
      'set_actor_property supports bool/int/float/string/enum only - no Vector, Rotator, or struct types. Use set_actor_transform for position/rotation/scale.',
      'focus_viewport needs either target (actor name) OR location - not both. Camera offsets on X axis at the given distance.',
      'spawn_blueprint_actor accepts a fully-qualified `/Game/...` path (preferred, unambiguous) or a bare asset name (resolved via /Game/Blueprints/ first, then AssetRegistry project-wide; ambiguous bare names error explicitly with all candidates listed).',
      'take_screenshot saves to the editor machine filesystem. For inline base64, use get_viewport_screenshot (visual-capture toolset).',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprints-write'],
        tip: 'Typical actor workflow: create_blueprint -> add_component -> set_component_property -> compile_blueprint -> spawn_blueprint_actor. Always compile before spawning.',
      },
      {
        requires: ['offline'],
        tip: 'Use the client\'s native source-search capability to find C++ class names under Source/, then use get_actor_properties to inspect level instances.',
      },
    ],
  },

  'blueprints-write': {
    core: [
      'blueprint_name accepts a fully-qualified `/Game/...` path or a bare asset name. Bare names check `/Game/Blueprints/<Name>` first (back-compat), then fall back to project-wide AssetRegistry lookup. Pass a full path to disambiguate when multiple BPs share a name.',
      'add_component auto-compiles the blueprint. Other mutations (set_component_property, set_blueprint_property) do NOT - call compile_blueprint explicitly.',
      'compile_blueprint returns diagnostic-quality lifecycle output: succeeded/compiled/compiled_ok, error and warning counts, messages, generated-class status, dirty status, and package path.',
      'add_variable_assignment authors target_variable = literal or target_variable = source_variable in a target graph, returning node/pin/link metadata and requires_compile.',
      'set_pawn_props returns per-property results - partial success is possible. Check the results object.',
      'Node graph commands return node GUIDs. Use connect_nodes with source/target GUIDs + pin names to wire them together.',
      'find_nodes currently supports only node_type="Event". Other types are not yet searchable.',
      'add_function_node has complex resolution: specify target class (e.g., "GameplayStatics") to find library functions, or omit for BP-local functions.',
      'add_variable supports only 5 types: Boolean, Integer/Int, Float, String, Vector.',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'After modifying a blueprint (add_component, set_component_property, etc.), compile_blueprint then re-spawn_blueprint_actor to see changes in the level.',
      },
      {
        requires: ['offline'],
        tip: 'Use the client\'s native source-search capability to inspect C++ base-class signatures before adding function or event nodes. Confirm event names exactly.',
      },
    ],
  },

  'widgets': {
    core: [
      'Widget blueprints live under /Game/Widgets/ - pass name only to create_widget / add_text_block / add_button / bind_widget_event / set_text_block_binding / add_widget_to_viewport. add_input_action_node operates on a regular UBlueprint and accepts a fully-qualified `/Game/...` path or a bare name (same resolution chain as the blueprints-write toolset).',
      'create_widget auto-adds a root CanvasPanel. add_text_block and add_button require this root - they fail if the root is not a CanvasPanel.',
      'add_button creates a child TextBlock named <widget_name>_Text automatically.',
      'add_widget_to_viewport requires PIE running (engine restriction - AddToViewport needs a live game world). Returns NOT_IN_PIE error if PIE is not active; start_pie first then re-call.',
      'set_text_block_binding creates a pure FText getter function and registers FDelegateEditorBinding on the TextBlock\'s Text property - fully wired, ready to evaluate at runtime.',
      'bind_widget_event checks for existing events first - safe to call multiple times without creating duplicates.',
    ].join(' '),
    workflows: [{
      requires: ['blueprints-write'],
      tip: 'add_input_action_node (in this toolset) uses legacy Input Actions, NOT Enhanced Input. For Enhanced Input, use the input-and-pie toolset instead.',
    }],
  },

  'remote-control': {
    core: [
      'Uses HTTP:30010 (Remote Control API) - editor must be running AND have RemoteControl engine plugin enabled (UEMCP\'s uplugin transitively requests it; verify your .uproject Plugins[] if RC calls fail).',
      'rc_get_property / rc_set_property / rc_call_function operate on ANY UObject by object path. CDO form: /Game/Path/<AssetName>.Default__<AssetName>_C for class-default-object reads (single-dot separator; the doubled "BP_C:Default__BP_C" form does NOT resolve).',
      'rc_set_property wraps value in a propertyName-keyed object automatically (do not pre-wrap). generateTransaction:true records in editor Undo stack - leave on unless you have a reason.',
      'SanitizeMetadata allowlist (D66) caps RC metadata to {UIMin, UIMax, ClampMin, ClampMax, ToolTip}. For Category/Replicated/EditAnywhere flag surface, use blueprint-read tools (plugin-backed) instead - they bypass the allowlist.',
      'rc_passthrough accepts any /remote/* endpoint - escape hatch for RC calls the structured helpers do not cover. Paths not starting with /remote/ are rejected.',
    ].join(' '),
    workflows: [
      { requires: ['blueprint-read'], tip: 'For Blueprint variable inspection: prefer blueprint-read.get_blueprint_variables over rc_describe_object - it returns the full flag set (Category, Replicated, EditAnywhere) that RC\'s allowlist cannot expose.' },
      { requires: ['actors'], tip: 'To write a property on a live actor (not CDO), get the actor path via get_actor_properties first, then rc_set_property with that object_path. For CDO edits, use set_blueprint_property (blueprints-write toolset) - it is the transactional editor path.' },
      { requires: ['blueprints-write'], tip: 'D100 contract - after PIE start/stop cycles, newly-created BP CDOs may be GC\'d. If rc_get_property returns "object not found" on a path the AssetRegistry confirms exists on disk, call compile_blueprint on that BP first to force-reload the GeneratedClass + CDO, then retry the read.' },
    ],
  },

  'blueprint-read': {
    core: [
      'Plugin-backed (tcp-55558) - full flag surface including Category/Replicated/EditAnywhere that RC\'s SanitizeMetadata allowlist strips out. Prefer these over rc_describe_object when you need reflection fidelity.',
      'get_blueprint_info returns summary {super_class, interfaces, property_count, function_count}. Follow up with get_blueprint_variables or get_blueprint_functions for the full lists.',
      'get_blueprint_components filters get_blueprint_variables down to component-class properties (heuristic: property_class contains "Component" OR name ends _GEN_VARIABLE SCS suffix). Conservative - may miss exotic cases.',
      'bp_compile_and_report triggers a fresh compile and captures FCompilerResultsLog with node_guid attribution. blueprints-write.compile_blueprint now also returns diagnostic counts/messages, but bp_compile_and_report remains the richer read-focused graph diagnostic surface.',
      'get_widget_blueprint walks UWidgetTree root recursively. Empty widget trees return root_widget:null (valid, not an error).',
    ].join(' '),
    workflows: [
      { requires: ['offline'], tip: 'For asset-file-level reads without editor running, use inspect_blueprint + read_asset_properties (offline). blueprint-read tools require the editor loaded - they give LIVE reflection, offline tools give on-disk state.' },
      { requires: ['sidecar'], tip: 'If sidecar files exist at <Project>/Saved/UEMCP/..., their narrow-sidecar-v1 shape carries the same reflection surface these tools return - useful as a cache when editor is closed. regenerate_sidecar backfills missing ones.' },
    ],
  },

  'sidecar': {
    core: [
      'Narrow-sidecar = plugin-only fields (compile status + full reflection surface) written to <Project>/Saved/UEMCP/<package-path>.sidecar.json.',
      'Save-hook auto-writes on every Blueprint save (FCoreUObjectDelegates::OnObjectPreSave). regenerate_sidecar is for backfill - assets that exist but have not been re-saved since save-hook shipped.',
      'Sidecar does NOT contain edge topology (use S-B-base offline tools like bp_list_graphs / bp_trace_exec), positions (M-spatial), or via_knots (offline post-pass). Those layers are offline-primary by design (phase3-resequence section L).',
      'schema_version "narrow-sidecar-v1" - future bumps change the marker. Consumers should check before trusting fields.',
    ].join(' '),
    workflows: [{ requires: ['offline'], tip: 'For fully offline BP introspection, combine: S-B-base edge tools (offline) + sidecar files on disk (plugin-only reflection). Save-hook keeps sidecars fresh; regenerate_sidecar backfills untouched assets.' }],
  },

  'animation': {
    core: [
      'get_montage_full, get_anim_sequence_info, and get_anim_graph are full tcp-55558 asset-instance reads - they load UAnimMontage/UAnimSequence/UAnimBlueprint and return montage sections, notifies, slot tracks, sequence skeleton/rate data, and static AnimGraph topology. Use get_anim_graph include_pin_topology=true when you need visual UEdGraph node/pin/LinkedTo wiring. get_blend_space and get_anim_curve_data remain reflection-backed reads; pair with read_asset_properties (offline) for batch file-level inspection.',
      'Mutation tools (create_montage, add_montage_section, add_montage_notify) live on tcp-55558 (UEMCP plugin, M5-anim+mat per D105). create_montage emits a single DefaultSlot (D119 NEW-1 fix); section_name in add_montage_section must not collide with existing sections - API silently overwrites.',
    ].join(' '),
    workflows: [{ requires: ['offline'], tip: 'For montage sections / notifies / curve keyframes without editor, use read_asset_properties - D50 tagged-fallback covers their struct-typed fields via FPropertyTag iteration.' }],
  },

  'data-assets': {
    core: [
      'get_struct_definition / get_datatable_contents / get_string_table / list_data_asset_types all PARTIAL-RC - plugin reflection walk for schema + engine APIs for row data (UDataTable::GetTableAsCSV, UStringTable::EnumerateSourceStrings).',
      'get_datatable_contents returns {csv, row_names, row_struct_properties}. For per-row structured values, parse the CSV OR use offline read_asset_properties - both give the same data, the latter is editor-optional.',
      'list_data_asset_types walks TObjectIterator<UClass> in-memory - only modules currently loaded appear. If you expect a class to show but it is missing, the owning module has not been loaded yet.',
      'set_data_asset_property accepts a fully-qualified `/Game/...` path or a bare asset name (resolved via AssetRegistry). Type coercion on struct-typed fields can be quirky - verify with read_asset_properties (offline) after a write.',
    ].join(' '),
    workflows: [{ requires: ['offline'], tip: 'read_asset_properties (offline) + tagged-fallback D50 covers 601 unique struct names without loading the owning module - preferred for batch analysis that does not need the editor.' }],
  },

  'input-and-pie': {
    core: [
      'Enhanced Input tools (create_input_action, create_mapping_context, add_mapping) are asset-creation only - they do NOT bind runtime input. Binding happens in BP graph or C++.',
      'start_pie accepts mode: "viewport" (default), "standalone" (new process), "new_window" (in-process). Async request - IsPlaySessionInProgress may not flip immediately.',
      'stop_pie returns {was_running, requested_stop} - success means the request was issued, not that teardown completed. PIE teardown is async and may leave references briefly.',
      'execute_console_command runs against PlayWorld if PIE is active, else editor world. Commands like "stat fps" need PIE; "listassets *" works editor-side.',
      'is_pie_running is a snapshot query - volatile across calls (skip cache).',
    ].join(' '),
    workflows: [{ requires: ['actors'], tip: 'Test loop: spawn_blueprint_actor -> start_pie -> observe -> stop_pie. For hot-reload without full PIE cycle, compile_blueprint reliably hot-reloads CDO changes into the open editor.' }],
  },

  'editor-utility': {
    core: [
      'get_editor_state returns {selected_actors, viewport: {location, rotation, fov}, pie_running, world_path}. Useful as a cheap snapshot before a complex multi-tool operation.',
      'run_python_command - SECURITY-SENSITIVE. Two layers must both pass: (1) MCP server must be launched with --enable-python-exec flag (or UEMCP_ENABLE_PYTHON_EXEC=1 env var); without it every call returns PYTHON_EXEC_DISABLED. (2) The script is scanned against a deny-list (os, subprocess, eval, exec, open, __import__) and refused with PYTHON_EXEC_DENY_LIST + matched_pattern. Every executed call is audit-logged to <ProjectName>.log under [UEMCP-PYTHON-EXEC]. Prefer structured tools when possible.',
      'delete_asset_safe defaults to soft-delete: asset is renamed into /Game/_Deleted/<name>_<hash> with reference fixup (recoverable by renaming back). Hard delete requires permanent:true AND force:true; passing permanent:true alone yields BAD_PARAMS. Referencers block the delete unless force:true; the response detail.referencers field lists them. Every successful delete is audit-logged under [UEMCP-DELETE-ASSET].',
      'duplicate_asset refuses pre-existing destinations unless overwrite:true - pass it explicitly when you intend to replace.',
      'rename_asset accepts a bare new_name (target package directory inferred from source) OR a full /Game/... destination path.',
      'get_editor_utility_blueprint surfaces EUB-specific run_method.{present, name, num_params, has_return} + editor_menu.{registered, custom_tab_name} fields beyond the standard parent_class/generated_class. For reflection-deep BP fields use get_blueprint_info instead.',
      'Many tools here have been displaced by offline equivalents (inspect_blueprint, read_asset_properties) - prefer those when editor-closed is viable.',
    ].join(' '),
    workflows: [
      { requires: ['actors'], tip: 'Before spawning or modifying actors, get_editor_state confirms which level is current + which actors are selected - lets you scope operations without ambiguity.' },
      { requires: ['asset-registry'], tip: 'Before delete_asset_safe with force:true, run get_asset_references to see exactly which assets will have broken references. Soft-delete with force:true preserves references via rename-fixup; hard-delete with force:true breaks them.' },
    ],
  },

  'asset-registry': {
    core: [
      'get_asset_references returns {referencers, dependencies, num_*}. The referencers list answers "who uses this asset"; dependencies answers "what does this asset use". Use it for reverse-dependency checks, impact analysis, and delete planning.',
      'Package-name normalization is automatic: accepts both object path (/Game/X.X_C) and package path (/Game/X); strips the object suffix internally.',
      'For broad queries (all assets of class X, path pattern globs), use offline query_asset_registry - it reads AssetRegistry.bin directly without editor.',
    ].join(' '),
    workflows: [{ requires: ['offline'], tip: 'Combine: query_asset_registry (offline bulk scan) -> get_asset_references (editor-side reverse-deps) for a full impact-analysis workflow without round-tripping asset-by-asset.' }],
  },
});
