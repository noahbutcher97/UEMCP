// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "Materials/MaterialInterface.h"
#include "UEMCPMaterialParameterLibrary.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPGlobalMaterialDefinitionTest,
	"UEMCP.MaterialParameters.GlobalDefinitions", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPGlobalMaterialDefinitionTest::RunTest(const FString& Parameters)
{
	const TArray<FMaterialParameterInfo> Definitions = {
		FMaterialParameterInfo(TEXT("LayerOnly"), EMaterialParameterAssociation::LayerParameter, 0),
		FMaterialParameterInfo(TEXT("BlendOnly"), EMaterialParameterAssociation::BlendParameter, 0),
		FMaterialParameterInfo(TEXT("Roughness")),
		FMaterialParameterInfo(TEXT("roughness")),
		FMaterialParameterInfo(TEXT("InvalidGlobalIndex"), EMaterialParameterAssociation::GlobalParameter, 0)
	};
	const TArray<FName> Names = UEMCP::Materials::FilterGlobalParameterNames(Definitions);
	TestEqual(TEXT("Only a genuine global definition remains; FName duplicates collapse"), Names.Num(), 1);
	TestTrue(TEXT("Global names retain native case-insensitive matching"), Names.Contains(FName(TEXT("ROUGHNESS"))));
	TestTrue(TEXT("Null material cannot admit a parameter"), UUEMCPMaterialParameterLibrary::GetGlobalParameterNames(nullptr, EUEMCPMaterialParameterType::Scalar).IsEmpty());
	return true;
}
#endif
