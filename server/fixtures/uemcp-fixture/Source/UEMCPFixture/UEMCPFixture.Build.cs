using UnrealBuildTool;

public class UEMCPFixture : ModuleRules
{
	public UEMCPFixture(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		if (Target.Version.MajorVersion == 5 && Target.Version.MinorVersion < 5)
		{
			PublicDependencyModuleNames.Add("StructUtils");
		}
		if (Target.bBuildEditor && Target.Version.MajorVersion == 5 && Target.Version.MinorVersion >= 8)
		{
			PrivateDependencyModuleNames.AddRange(new string[] { "Chooser", "AssetRegistry" });
		}
		if (Target.bBuildEditor)
		{
			PrivateDependencyModuleNames.AddRange(new string[] { "UnrealEd", "BlueprintGraph", "KismetCompiler", "UEMCP", "RemoteControl", "RemoteControlCommon", "MaterialEditor", "PhysicsCore", "Json", "JsonUtilities" });
		}
	}
}
