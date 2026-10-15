// Copyright Noah Butcher. All Rights Reserved.
#include "UEMCPMaterialParameterLibrary.h"
#include "Materials/MaterialInterface.h"

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
