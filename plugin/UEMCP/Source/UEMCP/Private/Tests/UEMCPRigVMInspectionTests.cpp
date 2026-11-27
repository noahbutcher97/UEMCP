// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS && WITH_EDITORONLY_DATA && __has_include("RigVMRuntimeAsset.h")
#include "Dom/JsonObject.h"
#include "MCPCommandRegistry.h"
#include "Misc/AutomationTest.h"
#include "RigVMEditorAsset.h"
#include "RigVMRuntimeAsset.h"
#include "UObject/Package.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPRigVMRuntimeInspection, "UEMCP.RigVM.RuntimeAssetInspection",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPRigVMRuntimeInspection::RunTest(const FString&)
{
	const FString Name = TEXT("Rig_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	const FString Path = TEXT("/Game/__UEMCPTests/") + Name;
	UPackage* Package = CreatePackage(*Path);
	Package->SetFlags(RF_Transient);
	URigVMRuntimeAsset* Asset = NewObject<URigVMRuntimeAsset>(Package, *Name, RF_Public | RF_Transient);
	const auto Args = MakeShared<FJsonObject>();
	Args->SetStringField(TEXT("asset_path"), Path);
	TSharedPtr<FJsonObject> Response;
	UEMCP::FMCPCommandRegistry::Get().Dispatch(TEXT("get_rigvm_graph"), Args, Response);
	FString Code;
	TestTrue(TEXT("Runtime asset without authoring data reports its model is unavailable"),
		Response && Response->TryGetStringField(TEXT("code"), Code) && Code == TEXT("RIGVM_EDITOR_MODEL_UNAVAILABLE"));

	Asset->Initialize(URigVMEditorAsset::StaticClass());
	const bool bWasDirty = Package->IsDirty();
	UEMCP::FMCPCommandRegistry::Get().Dispatch(TEXT("get_rigvm_graph"), Args, Response);
	const TSharedPtr<FJsonObject>* Result = nullptr;
	if (!TestTrue(TEXT("Initialized runtime asset returns live authoring data"), Response && Response->TryGetObjectField(TEXT("result"), Result))) return false;
	TestEqual(TEXT("Response identifies the public runtime asset"), (*Result)->GetStringField(TEXT("asset_path")), Path);
	TestEqual(TEXT("Reports the live origin"), (*Result)->GetStringField(TEXT("origin")), FString(TEXT("live_editor")));
	TestTrue(TEXT("Includes the authoring graphs"), !(*Result)->GetArrayField(TEXT("graphs")).IsEmpty());
	TestEqual(TEXT("Reports the public package dirty state"), (*Result)->GetBoolField(TEXT("dirty")), bWasDirty);
	TestEqual(TEXT("Read preserves package dirty state"), Package->IsDirty(), bWasDirty);
	return true;
}
#endif
