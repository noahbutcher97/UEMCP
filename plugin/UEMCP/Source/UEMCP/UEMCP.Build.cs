// Copyright Optimum Athena. All Rights Reserved.

using UnrealBuildTool;

public class UEMCP : ModuleRules
{
	public UEMCP(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
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
		});
		// Note: GameplayAbilities removed per D60 — M1 scaffold doesn't reference GAS.
		// M3+ GAS tool workers (create_gameplay_effect etc.) re-add it here AND to
		// UEMCP.uplugin Plugins[] when they land (UBT warns on module-dep-without-plugin-dep).
	}
}
