using UnrealBuildTool;

public class UEMCPFixtureEditorTarget : TargetRules
{
	public UEMCPFixtureEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V4;
		ExtraModuleNames.Add("UEMCPFixture");
	}
}
