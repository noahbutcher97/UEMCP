// Copyright Optimum Athena. All Rights Reserved.

using UnrealBuildTool;

public class UEMCP : ModuleRules
{
	public UEMCP(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		// Unity builds re-enabled per W-E (2026-05-03): the duplicated input-parsing
		// helpers (TryReadVector3 / TryReadRotator across ActorHandlers + BlueprintHandlers
		// + GeometryHandlers) and the property-setter switch (SetActorPropertyValue /
		// SetUProperty across ActorHandlers + BlueprintHandlers) all consolidated onto
		// existing shared infrastructure: TransformParser (Public/TransformParser.h) for
		// vector/rotator input, PropertyHandlerRegistry (Public/PropertyHandlerRegistry.h)
		// for FProperty dispatch. Future workers must add new shared helpers to the
		// matching Public/ header rather than reintroducing per-file anonymous-namespace
		// copies — Unity will surface collisions immediately.
		bUseUnity = true;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore", // FKey + FKey::IsValid for Enhanced Input mapping handlers (D106)
			"Projects",  // IPluginManager::Get for GeometryHandlers' IsGeometryScriptPluginEnabled gate (D106)
			"Sockets",
			"Networking",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"UnrealEd",
			"Slate",
			"SlateCore",
			"EditorScriptingUtilities",
			"BlueprintGraph",
			"Kismet",
			"GameplayTags",
			"Json",
			"JsonUtilities",
			// D66 HYBRID — matches UEMCP.uplugin Plugins[] entry (UBT D60 rule).
			// Consumed directly for RC-adjacent type references (URemoteControlPreset etc).
			// HTTP traffic to the engine's WebRemoteControl server is server-side so no
			// direct WebRemoteControl dep here.
			"RemoteControl",
			// M-enhance CP3 handler deps:
			"UMG",           // UWidget / UPanelWidget base types
			"UMGEditor",     // UWidgetBlueprint + WidgetTree (editor-only)
			"AssetRegistry", // IAssetRegistry::GetReferencers / GetDependencies
			"LevelEditor",   // GCurrentLevelEditingViewportClient for editor-state viewport info
			// S4 additions:
			"ContentBrowser", // S4-4 Sidecar menu extension (FContentBrowserMenuExtender_SelectedAssets)
			// M5-input+geometry additions:
			"EnhancedInput",          // UInputAction / UInputMappingContext / FEnhancedActionKeyMapping
			"GeometryScriptingCore",  // UGeometryScriptLibrary_Mesh* function libs
			"GeometryFramework",      // ADynamicMeshActor + UDynamicMeshComponent
			"GeometryCore",            // FDynamicMesh3 (referenced indirectly via UDynamicMesh)
			// M5-editor-utility additions (D101 (iv) security model):
			"Blutility",          // UEditorUtilityBlueprint / UEditorUtilityWidgetBlueprint headers for get_editor_utility_blueprint + run_editor_utility
			"PythonScriptPlugin", // IPythonScriptPlugin / FPythonCommandEx for run_python_command. Headers compile-time; runtime nullptr-checked via IPythonScriptPlugin::Get()->IsPythonAvailable() so a project that disables the plugin in .uproject Plugins[] still builds and surfaces a typed PYTHON_PLUGIN_NOT_AVAILABLE error rather than crashing.
		});
		// Note: GameplayAbilities removed per D60 — M1 scaffold doesn't reference GAS.
		// M3+ GAS tool workers (create_gameplay_effect etc.) re-add it here AND to
		// UEMCP.uplugin Plugins[] when they land (UBT warns on module-dep-without-plugin-dep).
		// M5 GeometryScriptingCore + GeometryFramework + GeometryCore all live under the
		// "GeometryScripting" plugin — plugin-dep added in UEMCP.uplugin alongside this.
	}
}
