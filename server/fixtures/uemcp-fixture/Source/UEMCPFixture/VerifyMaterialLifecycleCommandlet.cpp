#include "VerifyMaterialLifecycleCommandlet.h"
#if WITH_EDITOR
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


#include "Editor.h"
#include "IRemoteControlModule.h"
#include "UObject/StructOnScope.h"
#include "UObject/SavePackage.h"
#include "UObject/Package.h"
#include "Misc/PackageName.h"
#include "Misc/FileHelper.h"
#include "JsonObjectConverter.h"
#include "Serialization/JsonSerializer.h"
#include "HAL/FileManager.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "TimerManager.h"

namespace UEMCPFixture::MaterialLifecycle
{
UMaterialInstanceConstant* CreateFixture()
{
	UMaterial* Material = NewObject<UMaterial>(CreatePackage(TEXT("/Game/MaterialVerification/M_Parameters")), TEXT("M_Parameters"), RF_Public | RF_Standalone | RF_Transactional);
	Material->bUseMaterialAttributes = true;
	UMaterialExpressionMaterialAttributeLayers* Stack = NewObject<UMaterialExpressionMaterialAttributeLayers>(Material);
	Material->GetExpressionCollection().AddExpression(Stack);
	Stack->DefaultLayers.Empty();
	Stack->DefaultLayers.AddDefaultBackgroundLayer();
	Stack->DefaultLayers.AppendBlendedLayer();
	UTexture* Texture = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineMaterials/T_DefaultTexture2_D.T_DefaultTexture2_D"));
	if (!Texture) return nullptr;
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
	UMaterialExpressionScalarParameter* GlobalScalar = NewObject<UMaterialExpressionScalarParameter>(Material);
	GlobalScalar->ParameterName = TEXT("GlobalScalar"); GlobalScalar->DefaultValue = 0.22f; GlobalScalar->ExpressionGUID = FGuid::NewGuid();
	UMaterialExpressionVectorParameter* GlobalVector = NewObject<UMaterialExpressionVectorParameter>(Material);
	GlobalVector->ParameterName = TEXT("GlobalVector"); GlobalVector->DefaultValue = FLinearColor(0.1f, 0.2f, 0.3f, 1); GlobalVector->ExpressionGUID = FGuid::NewGuid();
	UMaterialExpressionTextureSampleParameter2D* GlobalTexture = NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
	GlobalTexture->ParameterName = TEXT("GlobalTexture"); GlobalTexture->Texture = Texture; GlobalTexture->ExpressionGUID = FGuid::NewGuid();
	UMaterialExpressionMakeMaterialAttributes* GlobalAttributes = NewObject<UMaterialExpressionMakeMaterialAttributes>(Material);
	GlobalAttributes->Roughness.Connect(0, GlobalScalar); GlobalAttributes->BaseColor.Connect(0, GlobalVector); GlobalAttributes->Metallic.Connect(1, GlobalTexture);
	UMaterialExpressionBlendMaterialAttributes* RootMix = NewObject<UMaterialExpressionBlendMaterialAttributes>(Material);
	RootMix->A.Connect(0, Stack); RootMix->B.Connect(0, GlobalAttributes); RootMix->Alpha.Connect(0, GlobalScalar);
	for (UMaterialExpression* Expression : TArray<UMaterialExpression*>{GlobalScalar, GlobalVector, GlobalTexture, GlobalAttributes, RootMix}) Material->GetExpressionCollection().AddExpression(Expression);
	Material->GetEditorOnlyData()->MaterialAttributes.Connect(0, RootMix);
	Material->UpdateCachedExpressionData();
	UMaterialInstanceConstant* Instance = NewObject<UMaterialInstanceConstant>(CreatePackage(TEXT("/Game/MaterialVerification/MI_Parameters")), TEXT("MI_Parameters"), RF_Public | RF_Standalone | RF_Transactional);
	Instance->SetParentEditorOnly(Material);
	Instance->PostEditChange();

	return Instance;
}
}
#endif

UVerifyMaterialLifecycleCommandlet::UVerifyMaterialLifecycleCommandlet()
{
	IsEditor = true; IsClient = false; IsServer = false; LogToConsole = true;
}

int32 UVerifyMaterialLifecycleCommandlet::Main(const FString& Params)
{
#if WITH_EDITOR
	using namespace UEMCPFixture::MaterialLifecycle;
	if (FString(FApp::GetProjectName()) != TEXT("UEMCPFixture") || !GEditor) return 2;
	FString Phase;
	FParse::Value(*Params, TEXT("Phase="), Phase);
	if (Phase != TEXT("author") && Phase != TEXT("verify")) return 3;
	const FString Asset = TEXT("/Game/MaterialVerification/MI_Parameters.MI_Parameters");
	const FString MaterialFile = FPackageName::LongPackageNameToFilename(TEXT("/Game/MaterialVerification/M_Parameters"), FPackageName::GetAssetPackageExtension());
	if (Phase == TEXT("author") && IFileManager::Get().FileExists(*MaterialFile)) return 4;
	UMaterialInstanceConstant* Instance = Phase == TEXT("author") ? CreateFixture() : LoadObject<UMaterialInstanceConstant>(nullptr, *Asset);
	if (!Instance) return 5;
	if (!GEditor->Trans) GEditor->Trans = GEditor->CreateTrans();
	if (!GEditor->CanTransact()) return 6;
	UTexture* RequestedTexture = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineResources/WhiteSquareTexture.WhiteSquareTexture"));
	if (!RequestedTexture) return 7;
	TArray<TSharedPtr<FJsonValue>> Cases;
	int32 Failures = 0;
	for (int32 Scope = 0; Scope < 3; ++Scope)
	{
		const FString Association = Scope == 0 ? TEXT("GlobalParameter") : Scope == 1 ? TEXT("LayerParameter") : TEXT("BlendParameter");
		const int32 Index = Scope == 0 ? -1 : Scope == 1 ? 1 : 0;
		for (int32 Kind = 0; Kind < 3; ++Kind)
		{
			const EUEMCPMaterialParameterType Type = static_cast<EUEMCPMaterialParameterType>(Kind);
			const FString TypeName = Kind == 0 ? TEXT("Scalar") : Kind == 1 ? TEXT("Vector") : TEXT("Texture");
			const FString Name = (Scope == 0 ? TEXT("Global") : Scope == 1 ? TEXT("Shared") : TEXT("Blend")) + TypeName;
			auto Read = [&]() -> FUEMCPMaterialParameterDetails
			{
				const auto Rows = UUEMCPMaterialParameterLibrary::GetParameterDetails(Instance, Type);
				for (const auto& Row : Rows) if (Row.Name == FName(*Name) && Row.Association == Association && Row.Index == Index) return Row;
				return {};
			};
			auto MatchesRequested = [&](const FUEMCPMaterialParameterDetails& Row)
			{
				return Row.bValueFound && (Kind == 0 ? FMath::IsNearlyEqual(Row.ScalarValue, 0.38f, 0.000001f)
					: Kind == 1 ? Row.VectorValue.Equals(FLinearColor(0.31f, 0.42f, 0.53f, 1), 0.000001f) : Row.TextureValue == RequestedTexture->GetPathName());
			};
			auto Write = [&]()
			{
				FRCCall Call;
				Call.CallRef.Object = GetMutableDefault<UUEMCPMaterialParameterLibrary>();
				Call.CallRef.Function = Call.CallRef.Object->FindFunction(FName(TEXT("SetParameterValue")));
				if (!Call.CallRef.Function.IsValid()) return false;
				Call.ParamStruct.Initialize(Call.CallRef.Function.Get());
				Call.TransactionMode = ERCTransactionMode::NONE;
				auto Set = [&](const TCHAR* Key, const FString& Value)
				{
					FProperty* Property = Call.CallRef.Function->FindPropertyByName(Key);
					return Property && Property->ImportText_Direct(*Value, Property->ContainerPtrToValuePtr<void>(Call.ParamStruct.GetStructMemory()), Call.CallRef.Object.Get(), PPF_None);
				};
				if (!Set(TEXT("Instance"), Instance->GetPathName()) || !Set(TEXT("ParameterName"), Name) || !Set(TEXT("Association"), Association)) return false;
				if (!Set(TEXT("ParameterType"), TypeName) || !Set(TEXT("Index"), FString::FromInt(Index)) || !Set(TEXT("ScalarValue"), TEXT("0.38")) || !Set(TEXT("VectorValue"), TEXT("(R=0.31,G=0.42,B=0.53,A=1)")) || !Set(TEXT("TextureValue"), RequestedTexture->GetPathName())) return false;
				const bool Invoked = IRemoteControlModule::Get().InvokeCall(Call);
				// RC's default coalescing timer ends automatic transactions after idle
				// editor ticks. A commandlet has no main editor loop, so drive those
				// real timer callbacks before attempting Undo.
				for (int32 Frame = 0; Frame < 3; ++Frame)
				{
					++GFrameCounter;
					GEditor->GetTimerManager()->Tick(1.0f);
				}
				return Invoked;
			};
			const auto Before = Read();
			bool Passed = MatchesRequested(Before);
			auto Case = MakeShared<FJsonObject>();
			Case->SetStringField(TEXT("name"), Name); Case->SetStringField(TEXT("association"), Association); Case->SetNumberField(TEXT("index"), Index);
			if (Phase == TEXT("author"))
			{
				GEditor->ResetTransaction(FText::FromString(TEXT("Owned material lifecycle case")));
				const bool Written = Write() && MatchesRequested(Read());
				const bool UndoAvailable = GEditor->UndoTransaction();
				const auto AfterUndo = Read();
				Passed = Written && UndoAvailable && AfterUndo.bValueFound && (Kind == 0 ? AfterUndo.ScalarValue == Before.ScalarValue : Kind == 1 ? AfterUndo.VectorValue == Before.VectorValue : AfterUndo.TextureValue == Before.TextureValue);
				Case->SetBoolField(TEXT("writeVerified"), Written); Case->SetBoolField(TEXT("undoAvailable"), UndoAvailable);
				FString BeforeJson, AfterJson;
				FJsonObjectConverter::UStructToJsonObjectString(Before, BeforeJson); FJsonObjectConverter::UStructToJsonObjectString(AfterUndo, AfterJson);
				Case->SetStringField(TEXT("before"), BeforeJson); Case->SetStringField(TEXT("afterUndo"), AfterJson);
				if (!Write() || !MatchesRequested(Read())) return 8;
			}
			Case->SetBoolField(TEXT("passed"), Passed); if (!Passed) ++Failures;
			Cases.Add(MakeShared<FJsonValueObject>(Case));
		}
	}
	bool Saved = true;
	if (Phase == TEXT("author"))
	{
		for (UObject* Object : TArray<UObject*>{Instance->Parent, Instance})
		{
			FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone; Args.SaveFlags = SAVE_NoError;
			const FString Filename = FPackageName::LongPackageNameToFilename(Object->GetOutermost()->GetName(), FPackageName::GetAssetPackageExtension());
			IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
			Saved &= UPackage::SavePackage(Object->GetOutermost(), Object, *Filename, Args);
		}
	}
	const FString ReportDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("MaterialLifecycle"));
	IFileManager::Get().MakeDirectory(*ReportDirectory, true);
	auto Report = MakeShared<FJsonObject>(); Report->SetStringField(TEXT("phase"), Phase); Report->SetArrayField(TEXT("cases"), Cases);
	Report->SetNumberField(TEXT("failures"), Failures); Report->SetBoolField(TEXT("saved"), Saved);
	Report->SetStringField(TEXT("project"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
	FString Json; auto Writer = TJsonWriterFactory<>::Create(&Json); FJsonSerializer::Serialize(Report, Writer);
	if (!FFileHelper::SaveStringToFile(Json, *FPaths::Combine(ReportDirectory, Phase + TEXT(".json")))) return 9;
	return Saved && Failures == 0 ? 0 : 1;
#else
	return 10;
#endif
}
