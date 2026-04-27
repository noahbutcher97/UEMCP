// Copyright Optimum Athena. All Rights Reserved.
#include "MaterialsHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/MaterialInstanceConstantFactoryNew.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/MaterialInterface.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace UEMCP
{
	namespace
	{
		// "/Game/Materials/Foo" → "/Game/Materials/Foo.Foo" (doubled object-path).
		// Pass-through if already doubled. Mirrors the AnimationHandlers helper +
		// WidgetHandlers PIE-safe lookup pattern (D102).
		FString ToObjectPath(const FString& AssetPath)
		{
			if (AssetPath.Contains(TEXT("."))) return AssetPath;
			const int32 SlashIdx = AssetPath.Find(TEXT("/"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
			if (SlashIdx < 0) return AssetPath;
			const FString AssetName = AssetPath.Mid(SlashIdx + 1);
			return FString::Printf(TEXT("%s.%s"), *AssetPath, *AssetName);
		}

		FString GetStringOr(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, const FString& Default)
		{
			FString Out;
			return Params->TryGetStringField(Field, Out) ? Out : Default;
		}

		// String → EBlendMode coercion; defaults to BLEND_Opaque on unknown input.
		// Covers the BlendMode enum values exposed in the editor UI in UE 5.6.
		// Unknown values fall through to Opaque rather than erroring — callers
		// can verify by reading back the response's `blend_mode` field.
		EBlendMode ParseBlendMode(const FString& Mode, bool& bOutRecognized)
		{
			bOutRecognized = true;
			if (Mode.Equals(TEXT("Opaque"),         ESearchCase::IgnoreCase)) return BLEND_Opaque;
			if (Mode.Equals(TEXT("Masked"),         ESearchCase::IgnoreCase)) return BLEND_Masked;
			if (Mode.Equals(TEXT("Translucent"),    ESearchCase::IgnoreCase)) return BLEND_Translucent;
			if (Mode.Equals(TEXT("Additive"),       ESearchCase::IgnoreCase)) return BLEND_Additive;
			if (Mode.Equals(TEXT("Modulate"),       ESearchCase::IgnoreCase)) return BLEND_Modulate;
			if (Mode.Equals(TEXT("AlphaComposite"), ESearchCase::IgnoreCase)) return BLEND_AlphaComposite;
			if (Mode.Equals(TEXT("AlphaHoldout"),   ESearchCase::IgnoreCase)) return BLEND_AlphaHoldout;
			bOutRecognized = false;
			return BLEND_Opaque;
		}

		EMaterialDomain ParseMaterialDomain(const FString& Domain, bool& bOutRecognized)
		{
			bOutRecognized = true;
			if (Domain.Equals(TEXT("Surface"),                ESearchCase::IgnoreCase)) return MD_Surface;
			if (Domain.Equals(TEXT("DeferredDecal"),          ESearchCase::IgnoreCase)) return MD_DeferredDecal;
			if (Domain.Equals(TEXT("LightFunction"),          ESearchCase::IgnoreCase)) return MD_LightFunction;
			if (Domain.Equals(TEXT("Volume"),                 ESearchCase::IgnoreCase)) return MD_Volume;
			if (Domain.Equals(TEXT("PostProcess"),            ESearchCase::IgnoreCase)) return MD_PostProcess;
			if (Domain.Equals(TEXT("UI"),                     ESearchCase::IgnoreCase)) return MD_UI;
			if (Domain.Equals(TEXT("RuntimeVirtualTexture"),  ESearchCase::IgnoreCase)) return MD_RuntimeVirtualTexture;
			bOutRecognized = false;
			return MD_Surface;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 1. create_material — UMaterial via UMaterialFactoryNew
		// ═══════════════════════════════════════════════════════════════════════

		void HandleCreateMaterial(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_material requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FString PackagePath  = GetStringOr(Params, TEXT("path"),       TEXT("/Game/Materials"));
			const FString DomainStr    = GetStringOr(Params, TEXT("domain"),     TEXT("Surface"));
			const FString BlendModeStr = GetStringOr(Params, TEXT("blend_mode"), TEXT("Opaque"));

			bool bDomainOk = true, bBlendOk = true;
			const EMaterialDomain Domain = ParseMaterialDomain(DomainStr, bDomainOk);
			const EBlendMode      Blend  = ParseBlendMode(BlendModeStr, bBlendOk);
			if (!bDomainOk)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown material domain: '%s' (expected Surface|DeferredDecal|LightFunction|Volume|PostProcess|UI|RuntimeVirtualTexture)"), *DomainStr),
					TEXT("UNKNOWN_DOMAIN"));
				return;
			}
			if (!bBlendOk)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown blend mode: '%s' (expected Opaque|Masked|Translucent|Additive|Modulate|AlphaComposite|AlphaHoldout)"), *BlendModeStr),
					TEXT("UNKNOWN_BLEND_MODE"));
				return;
			}

			const FString FullAssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *Name);
			if (FPackageName::DoesPackageExist(FullAssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset already exists at '%s'"), *FullAssetPath),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*FullAssetPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
			if (!Factory)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to instantiate UMaterialFactoryNew"), TEXT("FACTORY_FAILED"));
				return;
			}
			const EObjectFlags Flags = RF_Public | RF_Standalone;
			UObject* Created = Factory->FactoryCreateNew(UMaterial::StaticClass(), Package, FName(*Name), Flags, nullptr, GWarn);
			UMaterial* NewMaterial = Cast<UMaterial>(Created);
			if (!NewMaterial)
			{
				BuildErrorResponse(OutResponse, TEXT("Factory returned null UMaterial"), TEXT("MATERIAL_CREATE_FAILED"));
				return;
			}
			NewMaterial->MaterialDomain = Domain;
			NewMaterial->BlendMode      = Blend;
			NewMaterial->PostEditChange();
			Package->MarkPackageDirty();
			FAssetRegistryModule::AssetCreated(NewMaterial);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), Name);
			Result->SetStringField(TEXT("path"), FullAssetPath);
			Result->SetStringField(TEXT("domain"), DomainStr);
			Result->SetStringField(TEXT("blend_mode"), BlendModeStr);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 2. create_material_instance — UMaterialInstanceConstant from parent
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Parent can be either a UMaterial or another UMaterialInstanceConstant.
		// UMaterialInterface is the common base — accepts both.

		void HandleCreateMaterialInstance(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_material_instance requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name, ParentPath;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("parent_path"), ParentPath) || ParentPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'parent_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FString PackagePath = GetStringOr(Params, TEXT("path"), TEXT("/Game/Materials"));

			const FString ParentObjectPath = ToObjectPath(ParentPath);
			UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr, *ParentObjectPath);
			if (!Parent)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Parent material/MIC not found at '%s'"), *ParentPath),
					TEXT("PARENT_NOT_FOUND"));
				return;
			}

			const FString FullAssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *Name);
			if (FPackageName::DoesPackageExist(FullAssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset already exists at '%s'"), *FullAssetPath),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*FullAssetPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UMaterialInstanceConstantFactoryNew* Factory = NewObject<UMaterialInstanceConstantFactoryNew>();
			if (!Factory)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to instantiate UMaterialInstanceConstantFactoryNew"), TEXT("FACTORY_FAILED"));
				return;
			}
			Factory->InitialParent = Parent;
			const EObjectFlags Flags = RF_Public | RF_Standalone;
			UObject* Created = Factory->FactoryCreateNew(UMaterialInstanceConstant::StaticClass(), Package, FName(*Name), Flags, nullptr, GWarn);
			UMaterialInstanceConstant* NewMIC = Cast<UMaterialInstanceConstant>(Created);
			if (!NewMIC)
			{
				BuildErrorResponse(OutResponse, TEXT("Factory returned null UMaterialInstanceConstant"), TEXT("MIC_CREATE_FAILED"));
				return;
			}
			NewMIC->PostEditChange();
			Package->MarkPackageDirty();
			FAssetRegistryModule::AssetCreated(NewMIC);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), Name);
			Result->SetStringField(TEXT("path"), FullAssetPath);
			Result->SetStringField(TEXT("parent"), Parent->GetPathName());
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterMaterialsHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("create_material"),          &HandleCreateMaterial);
		Registry.Register(TEXT("create_material_instance"), &HandleCreateMaterialInstance);
		// set_material_parameter: ships as RC HTTP delegate via rc-tools.mjs per
		// D101 (ii). Routes through SetScalar/Vector/TextureParameterValueEditorOnly
		// UFUNCTIONs on the MIC asset itself — no plugin C++ handler required.
	}
}
