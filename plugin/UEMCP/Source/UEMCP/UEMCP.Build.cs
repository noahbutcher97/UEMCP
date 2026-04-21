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
		});
		// Note: GameplayAbilities removed per D60 — M1 scaffold doesn't reference GAS.
		// M3+ GAS tool workers (create_gameplay_effect etc.) re-add it here AND to
		// UEMCP.uplugin Plugins[] when they land (UBT warns on module-dep-without-plugin-dep).
	}
}
