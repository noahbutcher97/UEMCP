// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "Materials/MaterialInterface.h"
#include "UEMCPMaterialParameterLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/MaterialFunctionMaterialLayer.h"
#include "Materials/MaterialFunctionMaterialLayerBlend.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialExpressionMakeMaterialAttributes.h"
#include "Materials/MaterialExpressionFunctionInput.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionMaterialAttributeLayers.h"
#include "Engine/Texture.h"
#include "Materials/MaterialExpressionBlendMaterialAttributes.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPAssociatedMaterialParameterTest,
	"UEMCP.MaterialParameters.AssociatedValues", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssociatedMaterialParameterTest::RunTest(const FString& Parameters)
{
	UMaterial* Material = NewObject<UMaterial>(GetTransientPackage());
	Material->bUseMaterialAttributes = true;
	UMaterialExpressionMaterialAttributeLayers* Stack = NewObject<UMaterialExpressionMaterialAttributeLayers>(Material);
	Material->GetExpressionCollection().AddExpression(Stack);
	Stack->DefaultLayers.Empty();
	Stack->DefaultLayers.AddDefaultBackgroundLayer();
	Stack->DefaultLayers.AppendBlendedLayer();
	UTexture* Texture = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineMaterials/T_DefaultTexture2_D.T_DefaultTexture2_D"));
	if (!TestNotNull(TEXT("Engine fixture texture loads"), Texture)) return false;
	for (int32 I = 0; I < 2; ++I)
	{
		UMaterialFunctionMaterialLayer* Layer = NewObject<UMaterialFunctionMaterialLayer>(Material);
		Layer->SetMaterialFunctionUsage(EMaterialFunctionUsage::MaterialLayer);
		auto& Expressions = Layer->GetExpressionCollection();
		UMaterialExpressionScalarParameter* Scalar = NewObject<UMaterialExpressionScalarParameter>(Layer);
		Scalar->ParameterName = TEXT("SharedScalar");
		Scalar->DefaultValue = 0.2f;
		Scalar->ExpressionGUID = FGuid::NewGuid();
		Expressions.AddExpression(Scalar);
		UMaterialExpressionVectorParameter* Vector = NewObject<UMaterialExpressionVectorParameter>(Layer);
		Vector->ParameterName = TEXT("SharedVector");
		Vector->DefaultValue = FLinearColor(0.1f, 0.2f, 0.3f);
		Vector->ExpressionGUID = FGuid::NewGuid();
		Expressions.AddExpression(Vector);
		UMaterialExpressionTextureSampleParameter2D* Sample = NewObject<UMaterialExpressionTextureSampleParameter2D>(Layer);
		Sample->ParameterName = TEXT("SharedTexture");
		Sample->Texture = Texture;
		Sample->ExpressionGUID = FGuid::NewGuid();
		Expressions.AddExpression(Sample);
		UMaterialExpressionMakeMaterialAttributes* Attributes = NewObject<UMaterialExpressionMakeMaterialAttributes>(Layer);
		Attributes->Roughness.Connect(0, Scalar);
		Attributes->BaseColor.Connect(0, Vector);
		Attributes->Metallic.Connect(1, Sample);
		Expressions.AddExpression(Attributes);
		UMaterialExpressionFunctionOutput* Output = NewObject<UMaterialExpressionFunctionOutput>(Layer);
		Output->A.Connect(0, Attributes);
		Output->Id = FGuid::NewGuid();
		Expressions.AddExpression(Output);
		Layer->PostEditChange();
		Stack->DefaultLayers.Layers[I] = Layer;
	}
	UMaterialFunctionMaterialLayerBlend* Blend = NewObject<UMaterialFunctionMaterialLayerBlend>(Material);
	Blend->SetMaterialFunctionUsage(EMaterialFunctionUsage::MaterialLayerBlend);
	TArray<UMaterialExpressionFunctionInput*> Inputs;
	for (int32 I = 0; I < 2; ++I)
	{
		UMaterialExpressionFunctionInput* Input = NewObject<UMaterialExpressionFunctionInput>(Blend);
		Input->InputType = FunctionInput_MaterialAttributes;
		Input->InputName = FName(*FString::Printf(TEXT("Input%d"), I));
		Input->Id = FGuid::NewGuid();
		Blend->GetExpressionCollection().AddExpression(Input);
		Inputs.Add(Input);
	}
	UMaterialExpressionScalarParameter* BlendScalar = NewObject<UMaterialExpressionScalarParameter>(Blend);
	BlendScalar->ParameterName = TEXT("BlendScalar");
	BlendScalar->DefaultValue = 0.5f;
	BlendScalar->ExpressionGUID = FGuid::NewGuid();
	Blend->GetExpressionCollection().AddExpression(BlendScalar);
	UMaterialExpressionVectorParameter* BlendVector = NewObject<UMaterialExpressionVectorParameter>(Blend);
	BlendVector->ParameterName = TEXT("BlendVector");
	BlendVector->DefaultValue = FLinearColor::White;
	BlendVector->ExpressionGUID = FGuid::NewGuid();
	Blend->GetExpressionCollection().AddExpression(BlendVector);
	UMaterialExpressionTextureSampleParameter2D* BlendTexture = NewObject<UMaterialExpressionTextureSampleParameter2D>(Blend);
	BlendTexture->ParameterName = TEXT("BlendTexture");
	BlendTexture->Texture = Texture;
	BlendTexture->ExpressionGUID = FGuid::NewGuid();
	Blend->GetExpressionCollection().AddExpression(BlendTexture);
	UMaterialExpressionMultiply* Weight = NewObject<UMaterialExpressionMultiply>(Blend);
	Weight->A.Connect(0, BlendScalar);
	Weight->B.Connect(1, BlendVector);
	Blend->GetExpressionCollection().AddExpression(Weight);
	UMaterialExpressionMultiply* Mask = NewObject<UMaterialExpressionMultiply>(Blend);
	Mask->A.Connect(0, Weight);
	Mask->B.Connect(1, BlendTexture);
	Blend->GetExpressionCollection().AddExpression(Mask);
	UMaterialExpressionBlendMaterialAttributes* Mix = NewObject<UMaterialExpressionBlendMaterialAttributes>(Blend);
	Mix->A.Connect(0, Inputs[0]);
	Mix->B.Connect(0, Inputs[1]);
	Mix->Alpha.Connect(0, Mask);
	Blend->GetExpressionCollection().AddExpression(Mix);
	UMaterialExpressionFunctionOutput* BlendOutput = NewObject<UMaterialExpressionFunctionOutput>(Blend);
	BlendOutput->A.Connect(0, Mix);
	BlendOutput->Id = FGuid::NewGuid();
	Blend->GetExpressionCollection().AddExpression(BlendOutput);
	Blend->PostEditChange();
	Stack->DefaultLayers.Blends[0] = Blend;
	Stack->RebuildLayerGraph(true);
	Material->GetEditorOnlyData()->MaterialAttributes.Connect(0, Stack);
	Material->UpdateCachedExpressionData();
	UMaterialInstanceConstant* Instance = NewObject<UMaterialInstanceConstant>(GetTransientPackage(), TEXT("UEMCPParameterTestInstance"));
	Instance->SetParentEditorOnly(Material);
	Instance->PostEditChange();
	const auto Before = UUEMCPMaterialParameterLibrary::GetParameterDetails(Instance, EUEMCPMaterialParameterType::Scalar);
	TestEqual(TEXT("Two layer identities and one blend definition remain"), Before.Num(), 3);
	if (Before.Num() != 3) return false;
	TestTrue(TEXT("Layer expression GUID is retained"), !Before[0].Id.IsEmpty());
	TestFalse(TEXT("Layer-only names cannot create a global override"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Scalar, TEXT("SharedScalar"), TEXT("GlobalParameter"), -1, 0.7f, FLinearColor::Black, nullptr));
	TestTrue(TEXT("Native setter accepts case-insensitive name and exact layer 1"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Scalar, TEXT("sharedscalar"), TEXT("LayerParameter"), 1, 0.7f, FLinearColor::Black, nullptr));
	float Layer0 = 0, Layer1 = 0;
	Instance->GetScalarParameterValue(FMaterialParameterInfo(TEXT("SharedScalar"), EMaterialParameterAssociation::LayerParameter, 0), Layer0);
	Instance->GetScalarParameterValue(FMaterialParameterInfo(TEXT("SharedScalar"), EMaterialParameterAssociation::LayerParameter, 1), Layer1);
	TestEqual(TEXT("Other layer remains unchanged"), Layer0, 0.2f);
	TestEqual(TEXT("Selected layer receives the value"), Layer1, 0.7f);
	TestTrue(TEXT("Vector write uses exact layer identity"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Vector, TEXT("SharedVector"), TEXT("LayerParameter"), 1, 0, FLinearColor::Red, nullptr));
	TestTrue(TEXT("Texture write uses exact layer identity"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Texture, TEXT("SharedTexture"), TEXT("LayerParameter"), 1, 0, FLinearColor::Black, Texture));
	TestFalse(TEXT("Nonexistent index is rejected before mutation"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Scalar, TEXT("SharedScalar"), TEXT("LayerParameter"), 99, 1, FLinearColor::Black, nullptr));
	TestTrue(TEXT("Blend parameter at index zero is writable"), UUEMCPMaterialParameterLibrary::SetParameterValue(
		Instance, EUEMCPMaterialParameterType::Scalar, TEXT("BlendScalar"), TEXT("BlendParameter"), 0, 0.6f, FLinearColor::Black, nullptr));
	if (FParse::Param(FCommandLine::Get(), TEXT("UEMCPKeepParameterFixture")))
	{
		Instance->AddToRoot();
		AddInfo(FString::Printf(TEXT("Retained owned live-test fixture: %s"), *Instance->GetPathName()));
	}
	return true;
}
#endif
