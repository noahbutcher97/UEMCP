#include "Modules/ModuleManager.h"
#if WITH_EDITOR
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "RemoteControlSettings.h"
#include "RCAllowedRemoteFunctionCall.h"
#endif

class FUEMCPFixtureModule : public FDefaultGameModuleImpl
{
public:
	virtual void StartupModule() override
	{
#if WITH_EDITOR
		if (!FParse::Param(FCommandLine::Get(), TEXT("UEMCPMaterialLive"))) return;
		// In-memory permissions for this test process only; never save config.
		URemoteControlSettings* Settings = GetMutableDefault<URemoteControlSettings>();
		Settings->bAllowAnyRemoteFunctionCall = false;
		Settings->bEnableRemotePythonExecution = false;
		Settings->bAllowConsoleCommandRemoteExecution = false;
		Settings->CustomAllowedRemoteFunctionCalls.Reset();
		auto Allow = [&](const TCHAR* Class, const TCHAR* Function)
		{
			FRCAllowedRemoteFunctionCall Rule;
			Rule.ClassPath = FSoftClassPath(Class);
			Rule.FunctionName = FString(Function);
			Settings->CustomAllowedRemoteFunctionCalls.Add(Rule);
		};
		Allow(TEXT("/Script/UEMCPFixture.VerifyMaterialLifecycleCommandlet"), TEXT("LiveControl"));
		for (const TCHAR* Function : { TEXT("GetGlobalParameterNames"), TEXT("GetParameterDetails"), TEXT("SetParameterValue") }) Allow(TEXT("/Script/UEMCP.UEMCPMaterialParameterLibrary"), Function);
		for (const TCHAR* Function : { TEXT("GetMaterialInstanceScalarParameterValue"), TEXT("GetMaterialInstanceVectorParameterValue"), TEXT("GetMaterialInstanceTextureParameterValue") }) Allow(TEXT("/Script/MaterialEditor.MaterialEditingLibrary"), Function);
		Allow(TEXT("/Script/Engine.KismetMathLibrary"), TEXT("ClassIsChildOf"));
#endif
	}
};

IMPLEMENT_PRIMARY_GAME_MODULE(FUEMCPFixtureModule, UEMCPFixture, "UEMCPFixture");
