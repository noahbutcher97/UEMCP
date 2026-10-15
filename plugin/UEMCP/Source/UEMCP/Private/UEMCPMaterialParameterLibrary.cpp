// Copyright Noah Butcher. All Rights Reserved.
#include "UEMCPMaterialParameterLibrary.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Engine/Texture.h"
#include "ScopedTransaction.h"

TArray<FName> UEMCP::Materials::FilterGlobalParameterNames(TConstArrayView<FMaterialParameterInfo> Definitions)
{
	TArray<FName> Names;
	for (const FMaterialParameterInfo& Info : Definitions)
	{
		if (Info.Association == EMaterialParameterAssociation::GlobalParameter && Info.Index == INDEX_NONE)
		{
			Names.AddUnique(Info.Name);
		}
	}
	return Names;
}

TArray<FName> UUEMCPMaterialParameterLibrary::GetGlobalParameterNames(UMaterialInterface* Material, EUEMCPMaterialParameterType ParameterType)
{
	if (!Material) return {};
	TArray<FMaterialParameterInfo> Definitions;
	TArray<FGuid> Ids;
	switch (ParameterType)
	{
	case EUEMCPMaterialParameterType::Scalar: Material->GetAllScalarParameterInfo(Definitions, Ids); break;
	case EUEMCPMaterialParameterType::Vector: Material->GetAllVectorParameterInfo(Definitions, Ids); break;
	case EUEMCPMaterialParameterType::Texture: Material->GetAllTextureParameterInfo(Definitions, Ids); break;
	default: return {};
	}
	return UEMCP::Materials::FilterGlobalParameterNames(Definitions);
}

TArray<FUEMCPMaterialParameterDetails> UUEMCPMaterialParameterLibrary::GetParameterDetails(UMaterialInterface* Material, EUEMCPMaterialParameterType ParameterType)
{
	if (!Material) return {};
	TArray<FMaterialParameterInfo> Definitions;
	TArray<FGuid> Ids;
	switch (ParameterType)
	{
	case EUEMCPMaterialParameterType::Scalar: Material->GetAllScalarParameterInfo(Definitions, Ids); break;
	case EUEMCPMaterialParameterType::Vector: Material->GetAllVectorParameterInfo(Definitions, Ids); break;
	case EUEMCPMaterialParameterType::Texture: Material->GetAllTextureParameterInfo(Definitions, Ids); break;
	default: return {};
	}
	TArray<FUEMCPMaterialParameterDetails> Result;
	for (int32 I = 0; I < Definitions.Num(); ++I)
	{
		const FMaterialParameterInfo& Info = Definitions[I];
		FUEMCPMaterialParameterDetails Row;
		Row.Name = Info.Name;
		Row.Id = Ids.IsValidIndex(I) ? Ids[I].ToString(EGuidFormats::DigitsWithHyphens) : FString();
		Row.Index = Info.Index;
		switch (Info.Association)
		{
		case EMaterialParameterAssociation::GlobalParameter: Row.Association = TEXT("GlobalParameter"); break;
		case EMaterialParameterAssociation::LayerParameter: Row.Association = TEXT("LayerParameter"); break;
		case EMaterialParameterAssociation::BlendParameter: Row.Association = TEXT("BlendParameter"); break;
		default: continue;
		}
		switch (ParameterType)
		{
		case EUEMCPMaterialParameterType::Scalar: Row.bValueFound = Material->GetScalarParameterValue(Info, Row.ScalarValue); break;
		case EUEMCPMaterialParameterType::Vector: Row.bValueFound = Material->GetVectorParameterValue(Info, Row.VectorValue); break;
		case EUEMCPMaterialParameterType::Texture:
		{
			UTexture* Texture = nullptr;
			Row.bValueFound = Material->GetTextureParameterValue(Info, Texture);
			Row.TextureValue = Texture ? Texture->GetPathName() : FString();
			break;
		}
		default: break;
		}
		Result.Add(MoveTemp(Row));
	}
	return Result;
}

bool UUEMCPMaterialParameterLibrary::SetParameterValue(UMaterialInstanceConstant* Instance, EUEMCPMaterialParameterType ParameterType, FName ParameterName, FString Association, int32 Index, float ScalarValue, FLinearColor VectorValue, UTexture* TextureValue)
{
	if (!Instance) return false;
	const TArray<FUEMCPMaterialParameterDetails> Definitions = GetParameterDetails(Instance, ParameterType);
	const FUEMCPMaterialParameterDetails* Definition = Definitions.FindByPredicate([&](const FUEMCPMaterialParameterDetails& Row)
	{
		return Row.Name == ParameterName && Row.Association == Association && Row.Index == Index;
	});
	if (!Definition || (Association == TEXT("GlobalParameter") ? Index != INDEX_NONE : Index < 0)) return false;
	if (ParameterType == EUEMCPMaterialParameterType::Texture && !TextureValue) return false;
	const EMaterialParameterAssociation Kind = Association == TEXT("GlobalParameter") ? EMaterialParameterAssociation::GlobalParameter
		: Association == TEXT("LayerParameter") ? EMaterialParameterAssociation::LayerParameter : EMaterialParameterAssociation::BlendParameter;
	const FMaterialParameterInfo Info(Definition->Name, Kind, Index);
	const FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "SetMaterialParameter", "Set material parameter"));
	Instance->Modify();
	Instance->PreEditChange(nullptr);
	switch (ParameterType)
	{
	case EUEMCPMaterialParameterType::Scalar: Instance->SetScalarParameterValueEditorOnly(Info, ScalarValue); break;
	case EUEMCPMaterialParameterType::Vector: Instance->SetVectorParameterValueEditorOnly(Info, VectorValue); break;
	case EUEMCPMaterialParameterType::Texture: Instance->SetTextureParameterValueEditorOnly(Info, TextureValue); break;
	default: return false;
	}
	Instance->PostEditChange();
	Instance->UpdateStaticPermutation();
	return true;
}
