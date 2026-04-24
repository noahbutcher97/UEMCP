# UE5 Plugin Design

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)

## UE5 Plugin Recommendations

### Must Enable (Both Projects)

| Plugin | Status | Why |
|--------|--------|-----|
| **Remote Control API** | Enable | HTTP reflection access to all UPROPERTYs and UFUNCTIONs. Core of HTTP layer. Endpoints on port 30010. |
| **Remote Control Components** | Enable | `URemoteControlComponent` — attach to actors to selectively expose properties/functions without global presets. Enables granular per-actor remote access. |
| **Remote Control Web Interface** | Enable | Bundles the HTTP/WebSocket server for the RC API. May be required for HTTP endpoints to work. Also provides a debug UI at `localhost:6000` for inspecting exposed properties. |
| **Editor Scripting Utilities** | Already enabled | Required by existing UnrealMCP plugin. Provides `UEditorAssetLibrary`, `UEditorLevelLibrary`. |

### Recommended Enable (Both Projects)

| Plugin | Status | Why |
|--------|--------|-----|
| **Python Editor Script Plugin** | Enable | Full `unreal` Python module access for editor automation. Enables `run_python_command` tool. This is the correct plugin — NOT the deprecated "Python Script Plugin". |
| **Geometry Script** | Enable | Procedural mesh generation, CSG booleans (union/difference/intersection), UV manipulation, mesh editing. Exposed to both Blueprint and C++. Adds powerful geometry tools to MCP surface. |
| **Sequencer Scripting** | Enable | Programmatic control of cinematic sequences. Low cost to enable, useful for cutscene automation. |
| **Remote Control Actor Modifier Bridge** | Enable | Bridges RC with UE5's non-destructive actor editing (Actor Modifiers). Enables "try a change without committing it" workflows. Low cost to enable, adds modifier properties to RC API. |

### Optional / Future

| Plugin | Why Defer |
|--------|-----------|
| **Interchange** | Modern asset import/export. Useful if importing external 3D assets. Not critical for gameplay dev. |
| **DatasmithContent** | CAD/external scene import. Very specialized. |
| **LiveLink** | Real-time data streaming. Useful for mocap, not for typical AI-assisted dev. |

### Not Recommended (Skip)

| Plugin | Why Skip |
|--------|----------|
| **Remote Control Protocol — OSC** | Open Sound Control. UDP protocol for live performance/mocap hardware. Not applicable to programmatic MCP control. |
| **Remote Control Protocol — MIDI** | Musical instrument controllers. Hardware faders and knobs for virtual production. Not relevant. |
| **Remote Control Protocol — DMX** | DMX512 stage lighting protocol. For virtual production sets with physical lighting rigs. Not applicable. |
| **Remote Control Logic** | Experimental. Adds visual scripting for RC presets. Overkill for MCP integration. |
| **Slate Scripting** | Read-only inspection of existing editor UI. Cannot construct UI programmatically. UMG tools (already in existing plugin) handle UI creation. |

---

## New Custom C++ Plugin Design

### Overview

| Property | Value |
|----------|-------|
| **Plugin Name** | `UEMCP` — project-agnostic, works across any UE project |
| **TCP Port** | 55558 (configurable via console variable) |
| **Module Type** | Editor |
| **Loading Phase** | Default |
| **Pattern** | `UEditorSubsystem` + `FRunnable` TCP thread (same as existing plugin) |
| **Protocol** | JSON: `{"type": "command_name", "params": {...}}` (same as existing) |
| **Platforms** | Win64 (Mac/Linux optional) |

### Plugin Lifecycle

1. **Startup**: `UEMCPSubsystem::Initialize()` — create `FRunnable` TCP listener thread on port 55558. Register command handlers. Log "UEMCP ready on :55558".
2. **Command flow**: TCP thread receives JSON → enqueues to thread-safe `TArray` (FCriticalSection) → game thread `Tick()` dequeues one command per frame → dispatches to handler → sends JSON response on TCP thread.
3. **Hot reload**: `UEMCPSubsystem::Deinitialize()` — set FRunnable stop flag → close listening socket → wait for thread exit (`FRunnableThread::Kill(true)`) → destroy socket. Re-initialization happens automatically on next module load.
4. **Shutdown**: Same as hot reload. Editor close triggers `Deinitialize()` which cleans up TCP resources.
5. **Thread safety**: Only the TCP thread touches the socket. Only the game thread touches UE APIs. The command queue is the single synchronization point (FCriticalSection-guarded). No other shared state.
6. **Error handling**: If a command handler crashes (unhandled exception), catch at the dispatch level, return `{"error": "Internal error in <command>"}`, log to `UE_LOG(LogUEMCP)`. Never let a handler crash take down the TCP thread.

### Why a Separate Plugin

1. **Perforce safety**: Existing UnrealMCP is team-shared. Zero risk of merge conflicts.
2. **Independent iteration**: We can add/modify commands without coordinating with the Project B team.
3. **Separate port**: Both plugins run simultaneously without conflict.
4. **Additive**: If we ever distribute to the team, it's a clean addition, not a modification.

### Command Handlers (New Plugin)

**GAS Asset Commands** (highest priority for the primary target):
| Command | Description |
|---------|-------------|
| `create_gameplay_effect` | Create GE_ data asset with configurable duration policy, modifiers, tags |
| `create_gameplay_ability` | Create GA_ Blueprint with activation tags, cost, cooldown setup |
| `modify_gameplay_effect` | Edit existing GE modifiers, tags, period, stacking |
| `list_gameplay_tags_runtime` | Query tag hierarchy from running editor (supplements offline parse) |
| `create_attribute_set` | Generate AttributeSet C++ class stub with specified attributes |

**Material Commands**:
| Command | Description |
|---------|-------------|
| `create_material` | Create UMaterial with specified domain (Surface, PostProcess, UI, etc.) |
| `create_material_instance` | Create UMaterialInstanceConstant from parent material |
| `set_material_parameter` | Set scalar/vector/texture parameter on material instance |
| `list_material_parameters` | Get all parameters of a material |

**Animation Commands**:
| Command | Description |
|---------|-------------|
| `create_montage` | Create UAnimMontage from existing AnimSequence |
| `add_montage_section` | Add named section to montage |
| `add_montage_notify` | Add AnimNotify at specified time in montage |
| `list_montage_sections` | Get sections and notifies from existing montage |

**Data Asset Commands**:
| Command | Description |
|---------|-------------|
| `create_data_asset` | Create UDataAsset of specified class |
| `set_data_asset_property` | Set property on data asset by name |
| `list_data_asset_types` | List available UDataAsset subclasses in project |

**PIE Control Commands**:
| Command | Description |
|---------|-------------|
| `start_pie` | Launch Play In Editor session |
| `stop_pie` | End current PIE session |
| `execute_console_command` | Run console command in PIE context |
| `is_pie_running` | Check if PIE is currently active |

**Enhanced Input Commands**:
| Command | Description |
|---------|-------------|
| `create_input_action` | Create UInputAction asset |
| `create_mapping_context` | Create UInputMappingContext with bindings |
| `add_mapping_to_context` | Add key→action mapping to existing context |

**Geometry Script Commands** (requires Geometry Script plugin):
| Command | Description |
|---------|-------------|
| `create_procedural_mesh` | Create Dynamic Mesh actor with specified primitive (box, sphere, cylinder, cone) |
| `mesh_boolean` | CSG operation (union, difference, intersection) between two meshes |
| `generate_uvs` | Auto-unwrap UVs on a dynamic mesh |
| `get_mesh_info` | Get vertex count, triangle count, bounds, material slots |

**Asset Factory Commands** (general):
| Command | Description |
|---------|-------------|
| `create_asset` | Generic asset creation via UFactory (specify class, path, name) |
| `duplicate_asset` | Duplicate existing asset to new path |
| `rename_asset` | Rename/move asset with reference fixup |
| `delete_asset` | Delete asset with dependency check |

**Project Info Commands**:
| Command | Description |
|---------|-------------|
| `get_project_info` | Return .uproject name, engine version, enabled plugins |
| `get_editor_state` | Return current level, selected actors, viewport state |
| `run_python_command` | Execute Python script in editor (requires Python Editor Script Plugin) |

**Material Graph Read Commands**:
| Command | Description |
|---------|-------------|
| `get_material_graph` | Full expression node graph: nodes, connections, parameters, texture samples |

**Animation Asset Read Commands**:
| Command | Description |
|---------|-------------|
| `get_anim_sequence_info` | Sequence metadata: duration, notifies (with timestamps + classes), curves, sync markers |
| `get_montage_full` | Deep montage read: all sections, notifies, slots, blend settings, composite segments |
| `get_blend_space` | Blend axes, sample points, interpolation mode |
| `get_anim_curve_data` | Extract float/vector/transform curve keyframes from any anim asset |

**Curve & Data Read Commands**:
| Command | Description |
|---------|-------------|
| `get_curve_asset` | Read UCurveFloat/Vector/Color: keyframes with tangents and interp mode. Also UCurveTable. |
| `get_data_asset_properties` | Read all UPROPERTY values from any UDataAsset subclass |
| `get_string_table` | Read UStringTable key→value entries |
| `get_struct_definition` | Read UUserDefinedStruct members and UUserDefinedEnum values |

**Editor Utility Commands**:
| Command | Description |
|---------|-------------|
| `get_editor_utility_blueprint` | Read EUB/EUW: standard BP introspection + run method + editor menu registration |
| `run_editor_utility` | Execute an Editor Utility Blueprint's Run action |

**VFX & Audio Read Commands** (metadata only):
| Command | Description |
|---------|-------------|
| `get_niagara_system_info` | Emitter names, user parameters, fixed bounds. Not full module graph. |
| `get_audio_asset_info` | SoundCue summary, SoundWave metadata, AkAudioEvent Wwise IDs |

**Visual Capture Commands**:
| Command | Description |
|---------|-------------|
| `get_asset_thumbnail` | UThumbnailManager → FObjectThumbnail → PNG base64. Batch mode supported. |
| `get_viewport_screenshot` | FViewport::ReadPixels → inline PNG. Configurable resolution. |
| `get_asset_preview_render` | FPreviewScene offscreen render → PNG. For meshes, materials, particles. |
| `capture_active_editor_tab` | FWidgetRenderer::DrawWidget on active editor panel → PNG. |
| `get_asset_visual_summary` | Combines text JSON + inline image in one MCP response. |

### Improvements Over Existing UnrealMCP (Actor Tools)

These improvements apply to all actor-targeting commands reimplemented on TCP:55558:

**Actor Name-or-Label Resolution (D29)**:
- All actor JSON responses include a `label` field (`AActor::GetActorLabel()`) alongside the existing `name` field (FName)
- All actor lookup commands accept either FName or Outliner display label — resolution tries exact FName match first, then exact label match
- `find_actors_by_name` pattern matching checks both `GetName()` and `GetActorLabel()` via `FString::Contains()`
- Helper: `FindActorByNameOrLabel(UWorld*, const FString&)` in shared utils — two-pass lookup (FName, then label)
- If label matches multiple actors, return error with list of matches (labels aren't guaranteed unique)

**Detailed Actor Serialization (D28)**:
- `bDetailed=true` adds: component list, gameplay tag container, display label, folder path, net role

### Plugin Dependencies

```cpp
// UEMCP.Build.cs
PublicDependencyModuleNames.AddRange(new string[] {
    "Core", "CoreUObject", "Engine",
    "Networking", "Sockets",          // TCP server
    "Json", "JsonUtilities",          // JSON protocol
    "UnrealEd",                       // Editor APIs
    "AssetTools",                     // Asset creation
    "AssetRegistry",                  // Asset queries + dependency graphs
    "BlueprintGraph",                 // UEdGraph traversal for BP introspection
    "KismetCompiler",                 // Blueprint compilation utilities
    "Kismet",                         // K2Node access for graph reading
    "GameplayAbilities",              // GAS asset creation
    "GameplayTags",                   // Tag queries
    "MaterialEditor",                 // Material creation + expression graph access
    "AnimationBlueprintLibrary",      // Montage/notify APIs
    "AnimGraph",                      // UAnimGraphNode_Base, state machine traversal
    "EnhancedInput",                  // Input action/context creation
    "GeometryScriptingCore",          // Procedural mesh & CSG operations
    "GeometryFramework",              // Dynamic mesh support
    "EditorScriptingUtilities",       // Scripting helpers
    "UMGEditor",                      // UWidgetBlueprint, UWidgetTree access
    "Niagara",                        // UNiagaraSystem metadata read
    "Blutility",                      // Editor Utility Blueprint/Widget support
    "ContentBrowser",                 // Thumbnail access (UThumbnailManager)
    "Slate", "SlateCore",            // FWidgetRenderer for editor panel capture
    "RenderCore", "RHI",             // Render target + ReadPixels for preview renders
    "Sequencer",                      // Sequence control (optional)
    "PythonScriptPlugin",             // Python execution (optional, "Python Editor Script Plugin")
});
```

### Perforce Distribution Strategy

For **Project A** (primary target): Plugin lives in `<PROJECT_ROOT>/Plugins/UEMCP/`. Tracked normally in Perforce.

For **Project B** (secondary target): Two options (decide at implementation time):
- **Option A**: Plugin lives in `<PROJECT_ROOT>/Plugins/UEMCP/`. Added to Perforce for the team.
- **Option B**: Plugin lives outside Perforce (local-only install). Team doesn't see it.

Recommendation: **Option A** after initial development is stable. The team benefits from the expanded tool surface. Communicate via Confluence.

---

