// Copyright Noah Butcher. All Rights Reserved.
#include "MaterialGraphAuthoring.h"
#include "HandlerCommon.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"
#include "MaterialEditingLibrary.h"
#include "MaterialShared.h"
#include "ShaderCompiler.h"
#include "Materials/Material.h"
#include "Materials/MaterialFunction.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionFunctionInput.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Misc/PackageName.h"
#include "Misc/SecureHash.h"
#include "ScopedTransaction.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

namespace UEMCP::MaterialAuthoring
{
using FJson = TSharedPtr<FJsonObject>;

// Source identity is intentionally distinct from the legacy editor-wrapper GUIDs.
FString Id(const UMaterialExpression* E)
{
	return E ? E->MaterialExpressionGuid.ToString(EGuidFormats::DigitsWithHyphens) : FString();
}

struct FGraph
{
	UObject* Asset = nullptr;
	UMaterial* Material = nullptr;
	UMaterialFunction* Function = nullptr;
	TArray<UMaterialExpression*> Expressions() const
	{
		TArray<UMaterialExpression*> Result;
		if (Material) for (UMaterialExpression* E : Material->GetExpressions()) if (E) Result.Add(E);
		if (Function) for (UMaterialExpression* E : Function->GetExpressions()) if (E) Result.Add(E);
		return Result;
	}
	void Modify() const
	{
		Asset->SetFlags(RF_Transactional);
		Asset->Modify();
		UObject* Data = Material ? static_cast<UObject*>(Material->GetEditorOnlyData()) : static_cast<UObject*>(Function->GetEditorOnlyData());
		Data->SetFlags(RF_Transactional);
		Data->Modify();
	}
};

bool Fail(FJson& Response, const TCHAR* Code, const FString& Message)
{
	BuildErrorResponse(Response, Message, Code);
	return false;
}

bool Resolve(const FJson& P, FGraph& G, FJson& R)
{
	FString Path;
	if (!P || !P->TryGetStringField(TEXT("asset_path"), Path) || Path.IsEmpty()) return Fail(R, TEXT("INVALID_PARAMS"), TEXT("asset_path is required"));
	G.Asset = FSoftObjectPath(ToObjectPath(Path)).TryLoad();
	G.Material = Cast<UMaterial>(G.Asset);
	G.Function = Cast<UMaterialFunction>(G.Asset);
	if (!G.Material && !G.Function) return Fail(R, TEXT("INVALID_ASSET"), TEXT("Expected a material or regular material function"));
	if (G.Function && G.Function->GetMaterialFunctionUsage() != EMaterialFunctionUsage::Default) return Fail(R, TEXT("UNSUPPORTED_FUNCTION"), TEXT("Layer/blend functions are not supported"));
	TSet<FGuid> Seen;
	for (UMaterialExpression* E : G.Expressions())
	{
		if (!E->MaterialExpressionGuid.IsValid() || Seen.Contains(E->MaterialExpressionGuid)) return Fail(R, TEXT("INVALID_GRAPH_IDENTITY"), TEXT("Missing or duplicate expression GUID; no automatic repair"));
		Seen.Add(E->MaterialExpressionGuid);
	}
	return true;
}

FName InputName(UMaterialExpression* E, int32 Index)
{
	if (auto* Call = Cast<UMaterialExpressionMaterialFunctionCall>(E)) return Call->GetInputNameWithType(Index, false);
	return E->GetInputName(Index);
}

FJson Edge(const FExpressionInput* Input)
{
	FJson R = MakeShared<FJsonObject>();
	R->SetStringField(TEXT("expression_id"), Input ? Id(Input->Expression) : FString());
	R->SetNumberField(TEXT("output_index"), Input ? Input->OutputIndex : 0);
	R->SetNumberField(TEXT("mask"), Input ? Input->Mask : 0);
	R->SetNumberField(TEXT("mask_r"), Input ? Input->MaskR : 0);
	R->SetNumberField(TEXT("mask_g"), Input ? Input->MaskG : 0);
	R->SetNumberField(TEXT("mask_b"), Input ? Input->MaskB : 0);
	R->SetNumberField(TEXT("mask_a"), Input ? Input->MaskA : 0);
	return R;
}

bool Supported(UMaterialExpression* E)
{
	return E->GetClass() == UMaterialExpressionConstant::StaticClass() || E->GetClass() == UMaterialExpressionMultiply::StaticClass()
		|| E->GetClass() == UMaterialExpressionFunctionInput::StaticClass() || E->GetClass() == UMaterialExpressionFunctionOutput::StaticClass()
		|| E->GetClass() == UMaterialExpressionMaterialFunctionCall::StaticClass();
}

const TMap<FString, EMaterialProperty>& Properties()
{
	static const TMap<FString, EMaterialProperty> Map = {{TEXT("EmissiveColor"), MP_EmissiveColor}, {TEXT("BaseColor"), MP_BaseColor}, {TEXT("Roughness"), MP_Roughness}};
	return Map;
}

FJson Snapshot(const FGraph& G)
{
	FJson R = MakeShared<FJsonObject>();
	R->SetStringField(TEXT("asset_path"), G.Asset->GetPathName());
	R->SetStringField(TEXT("shape_version"), TEXT("material-source-v1"));
	TArray<TSharedPtr<FJsonValue>> Nodes;
	bool Complete = true;
	for (UMaterialExpression* E : G.Expressions())
	{
		FJson N = MakeShared<FJsonObject>();
		N->SetStringField(TEXT("expression_id"), Id(E));
		N->SetStringField(TEXT("class_name"), E->GetClass()->GetName());
		N->SetBoolField(TEXT("settings_complete"), Supported(E));
		Complete &= Supported(E);
		if (auto* C = Cast<UMaterialExpressionConstant>(E)) N->SetNumberField(TEXT("value"), C->R);
		if (auto* M = Cast<UMaterialExpressionMultiply>(E)) { N->SetNumberField(TEXT("const_a"), M->ConstA); N->SetNumberField(TEXT("const_b"), M->ConstB); }
		if (auto* I = Cast<UMaterialExpressionFunctionInput>(E))
		{
			N->SetStringField(TEXT("name"), I->InputName.ToString());
			N->SetStringField(TEXT("interface_id"), I->Id.ToString());
			N->SetNumberField(TEXT("input_type"), I->InputType);
			N->SetBoolField(TEXT("use_preview_as_default"), I->bUsePreviewValueAsDefault);
			N->SetNumberField(TEXT("preview_value"), I->PreviewValue.X);
			Complete &= I->InputType == FunctionInput_Scalar;
		}
		if (auto* O = Cast<UMaterialExpressionFunctionOutput>(E)) { N->SetStringField(TEXT("name"), O->OutputName.ToString()); N->SetStringField(TEXT("interface_id"), O->Id.ToString()); }
		if (auto* C = Cast<UMaterialExpressionMaterialFunctionCall>(E)) N->SetStringField(TEXT("function_path"), C->MaterialFunction ? C->MaterialFunction->GetPathName() : TEXT(""));
		TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
		for (int32 I = 0; FExpressionInput* Input = E->GetInput(I); ++I)
		{
			FJson Pin = Edge(Input);
			Pin->SetStringField(TEXT("name"), InputName(E, I).ToString());
			Pin->SetNumberField(TEXT("index"), I);
			Inputs.Add(MakeShared<FJsonValueObject>(Pin));
		}
		for (int32 I = 0; I < E->GetOutputs().Num(); ++I)
		{
			FJson Pin = MakeShared<FJsonObject>();
			Pin->SetNumberField(TEXT("index"), I);
			Pin->SetStringField(TEXT("name"), E->GetOutputs()[I].OutputName.ToString());
			Outputs.Add(MakeShared<FJsonValueObject>(Pin));
		}
		N->SetArrayField(TEXT("inputs"), Inputs); N->SetArrayField(TEXT("outputs"), Outputs);
		Nodes.Add(MakeShared<FJsonValueObject>(N));
	}
	R->SetArrayField(TEXT("nodes"), Nodes);
	R->SetBoolField(TEXT("settings_complete"), Complete);
	FJson Roots = MakeShared<FJsonObject>();
	if (G.Material)
	{
		for (int32 P = 0; P < MP_MAX; ++P)
		{
			if (FExpressionInput* Input = G.Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(P))) Roots->SetObjectField(FString::FromInt(P), Edge(Input));
		}
	}
	R->SetObjectField(TEXT("material_inputs"), Roots);
	const FString Serialized = SerializeResponse(R);
	FTCHARToUTF8 Bytes(*Serialized);
	FSHAHash Hash;
	FSHA1::HashBuffer(Bytes.Get(), Bytes.Length(), Hash.Hash);
	R->SetStringField(TEXT("revision"), Hash.ToString());
	R->SetBoolField(TEXT("dirty"), G.Asset->GetOutermost()->IsDirty());
	return R;
}

bool Guard(const FJson& P, const FGraph& G, FJson& R)
{
	if (!GEditor || !GEditor->CanTransact() || GEditor->PlayWorld || GIsTransacting) return Fail(R, TEXT("EDITOR_BUSY"), TEXT("Requires an idle editor outside PIE and Undo/Redo"));
	if (!G.Asset->GetOutermost()->GetName().StartsWith(TEXT("/Game/"))) return Fail(R, TEXT("READ_ONLY_ROOT"), TEXT("Authoring is restricted to /Game"));
	if (GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->FindEditorForAsset(G.Asset, false)) return Fail(R, TEXT("ASSET_EDITOR_OPEN"), TEXT("Close the asset editor after preserving its edits before external graph mutation"));
	FString Expected;
	if (!P->TryGetStringField(TEXT("expected_revision"), Expected) || Expected != Snapshot(G)->GetStringField(TEXT("revision"))) return Fail(R, TEXT("STALE_GRAPH"), TEXT("Read the uncached source graph and supply its expected_revision"));
	return true;
}

UMaterialExpression* Find(const FGraph& G, const FJson& P, const TCHAR* Field)
{
	FString Key;
	if (!P->TryGetStringField(Field, Key)) return nullptr;
	FGuid Guid;
	if (!FGuid::Parse(Key, Guid)) return nullptr;
	for (UMaterialExpression* E : G.Expressions()) if (E->MaterialExpressionGuid == Guid) return E;
	return nullptr;
}

bool Number(const FJson& P, const TCHAR* Key, double Default, float& Out)
{
	double Value = Default;
	if (P->HasField(Key) && !P->TryGetNumberField(Key, Value)) return false;
	if (!FMath::IsFinite(Value) || FMath::Abs(Value) > MAX_flt) return false;
	Out = static_cast<float>(Value); return true;
}

void CreateFunction(const FJson& P, FJson& R)
{
	FString Path;
	if (!P || !P->TryGetStringField(TEXT("asset_path"), Path) || !Path.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(Path) || Path.Contains(TEXT(".")) || Path.Len() > 512 || FName(*FPackageName::GetLongPackageAssetName(Path)).IsNone()) { Fail(R, TEXT("INVALID_PATH"), TEXT("Use a /Game/.../Name package path")); return; }
	if (!GEditor || GEditor->PlayWorld || GIsTransacting) { Fail(R, TEXT("EDITOR_BUSY"), TEXT("Requires idle editor")); return; }
	if (FindPackage(nullptr, *Path) || FPackageName::DoesPackageExist(Path)) { Fail(R, TEXT("ASSET_EXISTS"), TEXT("Destination already exists in memory or on disk")); return; }
	// Asset allocation follows create_material: explicit save, no claim of asset-creation Undo.
	UMaterialFunction* F = NewObject<UMaterialFunction>(CreatePackage(*Path), *FPackageName::GetLongPackageAssetName(Path), RF_Public | RF_Standalone | RF_Transactional);
	FAssetRegistryModule::AssetCreated(F); F->MarkPackageDirty();
	FGraph G; G.Asset = F; G.Function = F;
	FJson Result = Snapshot(G); Result->SetBoolField(TEXT("saved"), false); Result->SetBoolField(TEXT("creation_undo_supported"), false);
	BuildSuccessResponse(R, Result);
}

void CreateExpression(const FJson& P, FJson& R)
{
	FGraph G;
	if (!Resolve(P, G, R) || !Guard(P, G, R)) return;
	FString Kind, Name, FunctionPath;
	if (!P->TryGetStringField(TEXT("kind"), Kind)) { Fail(R, TEXT("INVALID_PARAMS"), TEXT("kind required")); return; }
	UClass* Class = nullptr;
	if (Kind == TEXT("Constant")) Class = UMaterialExpressionConstant::StaticClass();
	if (Kind == TEXT("Multiply")) Class = UMaterialExpressionMultiply::StaticClass();
	if (Kind == TEXT("FunctionInput")) Class = UMaterialExpressionFunctionInput::StaticClass();
	if (Kind == TEXT("FunctionOutput")) Class = UMaterialExpressionFunctionOutput::StaticClass();
	if (Kind == TEXT("FunctionCall")) Class = UMaterialExpressionMaterialFunctionCall::StaticClass();
	if (!Class) { Fail(R, TEXT("UNSUPPORTED_EXPRESSION"), TEXT("Supported: Constant, Multiply, FunctionInput (Scalar), FunctionOutput, FunctionCall")); return; }
	float Value, A, B;
	if (!Number(P, TEXT("value"), 0, Value) || !Number(P, TEXT("const_a"), 0, A) || !Number(P, TEXT("const_b"), 1, B)) { Fail(R, TEXT("INVALID_PARAMS"), TEXT("Constants must be finite floats")); return; }
	const bool Interface = Kind == TEXT("FunctionInput") || Kind == TEXT("FunctionOutput");
	if (Interface)
	{
		if (!G.Function || !P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty() || Name.Len() > 128 || FName(*Name).IsNone()) { Fail(R, TEXT("INVALID_INTERFACE"), TEXT("Named inputs/outputs require a function")); return; }
		for (UMaterialExpression* E : G.Expressions())
		{
			const auto* I = Cast<UMaterialExpressionFunctionInput>(E); const auto* O = Cast<UMaterialExpressionFunctionOutput>(E);
			if ((I && Kind == TEXT("FunctionInput") && I->InputName == FName(*Name)) || (O && Kind == TEXT("FunctionOutput") && O->OutputName == FName(*Name))) { Fail(R, TEXT("DUPLICATE_NAME"), TEXT("Interface name already exists (FName comparison)")); return; }
		}
	}
	UMaterialFunction* Target = nullptr;
	if (Kind == TEXT("FunctionCall"))
	{
		if (!P->TryGetStringField(TEXT("function_path"), FunctionPath)) { Fail(R, TEXT("INVALID_PARAMS"), TEXT("function_path required")); return; }
		Target = Cast<UMaterialFunction>(FSoftObjectPath(ToObjectPath(FunctionPath)).TryLoad());
		if (!Target || Target->GetMaterialFunctionUsage() != EMaterialFunctionUsage::Default) { Fail(R, TEXT("INVALID_FUNCTION"), TEXT("Regular function required")); return; }
		if (G.Function && (Target == G.Function || Target->IsDependent(G.Function))) { Fail(R, TEXT("GRAPH_CYCLE"), TEXT("Function dependency cycle rejected before calling engine setter")); return; }
		if (GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->FindEditorForAsset(Target, false)) { Fail(R, TEXT("ASSET_EDITOR_OPEN"), TEXT("Close referenced function editor first")); return; }
	}
	if (G.Expressions().Num() >= 1024) { Fail(R, TEXT("GRAPH_LIMIT"), TEXT("Authoring limit is 1024 expressions")); return; }
	const bool WasDirty = G.Asset->GetOutermost()->IsDirty();
	FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "AddMaterialExpression", "Add material expression"));
	G.Modify();
	UMaterialExpression* E = G.Function ? UMaterialEditingLibrary::CreateMaterialExpressionInFunction(G.Function, Class) : UMaterialEditingLibrary::CreateMaterialExpression(G.Material, Class);
	if (!E) { G.Asset->GetOutermost()->SetDirtyFlag(WasDirty); Transaction.Cancel(); Fail(R, TEXT("CREATE_FAILED"), TEXT("Engine did not create expression")); return; }
	E->Function = G.Function;
	if (auto* C = Cast<UMaterialExpressionConstant>(E)) C->R = Value;
	if (auto* M = Cast<UMaterialExpressionMultiply>(E)) { M->ConstA = A; M->ConstB = B; }
	if (auto* I = Cast<UMaterialExpressionFunctionInput>(E)) { I->InputName = FName(*Name); I->InputType = FunctionInput_Scalar; }
	if (auto* O = Cast<UMaterialExpressionFunctionOutput>(E)) O->OutputName = FName(*Name);
	if (auto* C = Cast<UMaterialExpressionMaterialFunctionCall>(E))
	{
		if (!C->SetMaterialFunction(Target))
		{
			if (G.Function) G.Function->GetExpressionCollection().RemoveExpression(E); else G.Material->GetExpressionCollection().RemoveExpression(E);
			E->MarkAsGarbage(); G.Asset->GetOutermost()->SetDirtyFlag(WasDirty); Transaction.Cancel();
			Fail(R, TEXT("FUNCTION_CALL_FAILED"), TEXT("Function call rejected; new expression removed")); return;
		}
	}
	G.Asset->MarkPackageDirty();
	FJson Result = Snapshot(G); Result->SetStringField(TEXT("created_expression_id"), Id(E));
	BuildSuccessResponse(R, Result);
}

bool Reaches(UMaterialExpression* From, UMaterialExpression* Target, TSet<UMaterialExpression*>& Seen)
{
	if (From == Target) return true;
	if (!From || Seen.Contains(From)) return false;
	Seen.Add(From);
	for (int32 I = 0; FExpressionInput* Input = From->GetInput(I); ++I) if (Reaches(Input->Expression, Target, Seen)) return true;
	return false;
}

void Connect(const FJson& P, FJson& R, bool Property)
{
	FGraph G;
	if (!Resolve(P, G, R) || !Guard(P, G, R)) return;
	UMaterialExpression* From = Find(G, P, TEXT("from_expression_id"));
	double Index;
	if (!From || !P->TryGetNumberField(TEXT("output_index"), Index) || !FMath::IsFinite(Index) || Index < 0 || Index >= From->GetOutputs().Num() || Index != FMath::FloorToDouble(Index)) { Fail(R, TEXT("INVALID_PIN"), TEXT("Source expression and explicit valid output_index required")); return; }
	FExpressionInput* Input = nullptr;
	UMaterialExpression* To = nullptr;
	if (Property)
	{
		FString Name;
		if (!G.Material || G.Material->MaterialDomain != MD_Surface || !P->TryGetStringField(TEXT("property"), Name) || !Properties().Contains(Name)) { Fail(R, TEXT("INVALID_PROPERTY"), TEXT("Surface material and EmissiveColor/BaseColor/Roughness required")); return; }
		const EMaterialProperty Prop = Properties()[Name];
		if (!G.Material->IsPropertyActive(Prop)) { Fail(R, TEXT("INACTIVE_PROPERTY"), TEXT("Material property is inactive")); return; }
		Input = G.Material->GetExpressionInputForProperty(Prop);
	}
	else
	{
		To = Find(G, P, TEXT("to_expression_id")); FString Name;
		if (!To || !P->TryGetStringField(TEXT("input_name"), Name) || Name.IsEmpty()) { Fail(R, TEXT("INVALID_PIN"), TEXT("Destination and explicit input_name required")); return; }
		for (int32 I = 0; FExpressionInput* Candidate = To->GetInput(I); ++I) if (InputName(To, I) == FName(*Name)) { if (Input) { Fail(R, TEXT("AMBIGUOUS_PIN"), TEXT("Input name is ambiguous")); return; } Input = Candidate; }
		TSet<UMaterialExpression*> Seen;
		if (Reaches(From, To, Seen)) { Fail(R, TEXT("GRAPH_CYCLE"), TEXT("Expression cycle rejected")); return; }
	}
	if (!Input) { Fail(R, TEXT("INVALID_PIN"), TEXT("Input does not exist")); return; }
	bool Replace = false; P->TryGetBoolField(TEXT("replace"), Replace);
	if (Input->Expression && !Replace) { Fail(R, TEXT("INPUT_CONNECTED"), TEXT("Explicit replace:true required")); return; }
	const FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "ConnectMaterialExpression", "Connect material expression"));
	G.Modify(); if (To) { To->SetFlags(RF_Transactional); To->Modify(); }
	Input->Connect(static_cast<int32>(Index), From);
	G.Asset->MarkPackageDirty();
	BuildSuccessResponse(R, Snapshot(G));
}

TMap<TWeakObjectPtr<UMaterial>, FString> RequestedCompiles;

FString CompileRevision(const FGraph& G, TSet<UObject*>& Seen)
{
	if (Seen.Contains(G.Asset)) return TEXT("");
	Seen.Add(G.Asset);
	FString Result = Snapshot(G)->GetStringField(TEXT("revision"));
	for (UMaterialExpression* E : G.Expressions())
	{
		if (auto* C = Cast<UMaterialExpressionMaterialFunctionCall>(E))
		{
			if (auto* F = Cast<UMaterialFunction>(C->MaterialFunction))
			{
				FGraph Child; Child.Asset = F; Child.Function = F;
				Result += CompileRevision(Child, Seen);
			}
		}
	}
	return Result;
}

FJson CompileStatus(UMaterial* Material)
{
	FJson R = MakeShared<FJsonObject>();
	R->SetStringField(TEXT("asset_path"), Material->GetPathName());
	FGraph G; G.Asset = Material; G.Material = Material;
	TSet<UObject*> Seen;
	const FString Current = CompileRevision(G, Seen);
	const FString* Requested = RequestedCompiles.Find(Material);
#if ENGINE_MINOR_VERSION >= 8
	const FMaterialResource* Resource = Material->GetMaterialResource(GMaxRHIShaderPlatform);
#else
	const FMaterialResource* Resource = Material->GetMaterialResource(GMaxRHIFeatureLevel);
#endif
	TArray<TSharedPtr<FJsonValue>> Errors;
	if (Resource) for (const FString& E : Resource->GetCompileErrors()) Errors.Add(MakeShared<FJsonValueString>(E));
	const bool Finished = Resource && Resource->IsCompilationFinished();
	R->SetBoolField(TEXT("resource_available"), Resource != nullptr);
	R->SetBoolField(TEXT("compilation_finished"), Finished);
	R->SetBoolField(TEXT("shader_map_finalized"), Resource && Resource->HasValidGameThreadShaderMap());
	R->SetBoolField(TEXT("shader_map_present"), Resource && Resource->GetGameThreadShaderMap());
	R->SetBoolField(TEXT("shader_map_complete"), Resource && Resource->IsGameThreadShaderMapComplete());
	R->SetNumberField(TEXT("shader_count"), Resource && Resource->GetGameThreadShaderMap() ? Resource->GetGameThreadShaderMap()->GetShaderNum() : 0);
	R->SetBoolField(TEXT("shader_compilation_skipped"), GShaderCompilingManager && GShaderCompilingManager->IsShaderCompilationSkipped());
	R->SetNumberField(TEXT("global_remaining_shader_jobs"), GShaderCompilingManager ? GShaderCompilingManager->GetNumRemainingJobs() : 0);
	// UE 5.8's job-cache path can publish complete ordinary-material clones
	// without setting compilation-finalized. Test required-shader completeness.
	R->SetStringField(TEXT("compile_state"), !Requested ? TEXT("not_requested") : *Requested != Current ? TEXT("stale") : !Resource ? TEXT("unavailable") : !Finished ? TEXT("pending") : Errors.Num() ? TEXT("error") : !Resource->GetGameThreadShaderMap() || !Resource->IsGameThreadShaderMapComplete() ? TEXT("unavailable") : TEXT("complete"));
	R->SetStringField(TEXT("current_revision"), Current);
	R->SetStringField(TEXT("requested_revision"), Requested ? *Requested : TEXT(""));
	R->SetNumberField(TEXT("feature_level"), static_cast<int32>(GMaxRHIFeatureLevel));
	R->SetNumberField(TEXT("shader_platform"), static_cast<int32>(GMaxRHIShaderPlatform));
	R->SetArrayField(TEXT("errors"), Errors); R->SetBoolField(TEXT("saved"), false);
	return R;
}

void Update(const FJson& P, FJson& R)
{
	FGraph G;
	if (!Resolve(P, G, R) || !Guard(P, G, R)) return;
	// Propagation may touch dependents. Refuse open material/function editors rather than discard their working copies.
	for (UObject* Edited : GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->GetAllEditedAssets())
		if (Edited->IsA<UMaterialInterface>() || Edited->IsA<UMaterialFunctionInterface>()) { Fail(R, TEXT("ASSET_EDITOR_OPEN"), TEXT("Close material/function editors before propagation")); return; }
	if (G.Function)
	{
		// Propagation recompiles consumers outside their explicit request. Undo of
		// the function graph cannot certify that those shaders match an old request.
		RequestedCompiles.Reset();
		UMaterialEditingLibrary::UpdateMaterialFunction(G.Function);
		FJson Result = Snapshot(G); Result->SetStringField(TEXT("compile_state"), TEXT("consumer_required")); Result->SetBoolField(TEXT("saved"), false);
		BuildSuccessResponse(R, Result);
	}
	else
	{
		TSet<UObject*> Seen;
		RequestedCompiles.Add(G.Material, CompileRevision(G, Seen));
		// This engine helper may wait for texture-streaming shader work. The
		// server gives this explicit operation a longer, still bounded deadline.
		UMaterialEditingLibrary::RecompileMaterial(G.Material);
		// UE 5.8 PostEditChange invalidates with PrecompileMode::None. An
		// unattached consumer has no render proxy requesting its shader jobs.
		G.Material->CacheShaders(EMaterialShaderPrecompileMode::Background);
		BuildSuccessResponse(R, CompileStatus(G.Material));
	}
}
}

namespace UEMCP
{
void ReadMaterialSourceGraph(const TSharedPtr<FJsonObject>& P, TSharedPtr<FJsonObject>& R)
{
	MaterialAuthoring::FGraph G;
	if (MaterialAuthoring::Resolve(P, G, R)) BuildSuccessResponse(R, MaterialAuthoring::Snapshot(G));
}
void RegisterMaterialGraphAuthoring(FMCPCommandRegistry& Registry)
{
	Registry.Register(TEXT("create_material_function"), &MaterialAuthoring::CreateFunction);
	Registry.Register(TEXT("create_material_expression"), &MaterialAuthoring::CreateExpression);
	Registry.Register(TEXT("connect_material_expressions"), [](const auto& P, auto& R) { MaterialAuthoring::Connect(P, R, false); });
	Registry.Register(TEXT("connect_material_property"), [](const auto& P, auto& R) { MaterialAuthoring::Connect(P, R, true); });
	Registry.Register(TEXT("update_material_graph"), &MaterialAuthoring::Update);
	Registry.Register(TEXT("get_material_compile_status"), [](const auto& P, auto& R)
	{
		MaterialAuthoring::FGraph G;
		if (!MaterialAuthoring::Resolve(P, G, R)) return;
		if (!G.Material) { MaterialAuthoring::Fail(R, TEXT("CONSUMER_REQUIRED"), TEXT("Query a consumer material")); return; }
		BuildSuccessResponse(R, MaterialAuthoring::CompileStatus(G.Material));
	});
}
}
