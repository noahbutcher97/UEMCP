using UnrealBuildTool;
using System.Collections.Generic;

public class UEMCPFixtureTarget : TargetRules
{
	public UEMCPFixtureTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		ExtraModuleNames.Add("UEMCPFixture");
	}
}
