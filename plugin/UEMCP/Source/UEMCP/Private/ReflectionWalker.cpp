// Copyright Optimum Athena. All Rights Reserved.
#include "ReflectionWalker.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/UserDefinedStruct.h"
#include "UObject/Class.h"
#include "UObject/Interface.h"
#include "UObject/Package.h"
#include "UObject/PropertyPortFlags.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	namespace
	{
		/**
		 * Human-readable UPROPERTY flag list. Covers the Blueprint-visible subset
		 * plus the ones RC's SanitizeMetadata omits — the point of this walker is
		 * exactly the fields RC won't give us.
		 */
		TArray<TSharedPtr<FJsonValue>> SerializePropertyFlags(EPropertyFlags Flags)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			#define ADD_FLAG(BIT, NAME) if ((Flags & (BIT)) != 0) Out.Add(MakeShared<FJsonValueString>(TEXT(NAME)))
			ADD_FLAG(CPF_Edit,              "EditAnywhere");
			ADD_FLAG(CPF_EditConst,         "EditConst");
			ADD_FLAG(CPF_DisableEditOnInstance, "DisableEditOnInstance");
			ADD_FLAG(CPF_DisableEditOnTemplate, "DisableEditOnTemplate");
			ADD_FLAG(CPF_BlueprintVisible,  "BlueprintReadOnly_or_ReadWrite");
			ADD_FLAG(CPF_BlueprintReadOnly, "BlueprintReadOnly");
			ADD_FLAG(CPF_BlueprintAssignable, "BlueprintAssignable");
			ADD_FLAG(CPF_Net,               "Replicated");
			ADD_FLAG(CPF_RepNotify,         "RepNotify");
			ADD_FLAG(CPF_Transient,         "Transient");
			ADD_FLAG(CPF_SaveGame,          "SaveGame");
			ADD_FLAG(CPF_Config,            "Config");
			ADD_FLAG(CPF_GlobalConfig,      "GlobalConfig");
			ADD_FLAG(CPF_Interp,            "Interp");
			ADD_FLAG(CPF_NonTransactional,  "NonTransactional");
			ADD_FLAG(CPF_AdvancedDisplay,   "AdvancedDisplay");
			ADD_FLAG(CPF_Deprecated,        "Deprecated");
			ADD_FLAG(CPF_NoClear,           "NoClear");
			ADD_FLAG(CPF_Protected,         "Protected");
			ADD_FLAG(CPF_Parm,              "Parm");
			ADD_FLAG(CPF_ReturnParm,        "ReturnParm");
			ADD_FLAG(CPF_OutParm,           "OutParm");
			ADD_FLAG(CPF_ReferenceParm,     "ReferenceParm");
			ADD_FLAG(CPF_ConstParm,         "ConstParm");
			#undef ADD_FLAG
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeClassFlagList(EClassFlags Flags)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			#define ADD_FLAG(BIT, NAME) if ((Flags & (BIT)) != 0) Out.Add(MakeShared<FJsonValueString>(TEXT(NAME)))
			ADD_FLAG(CLASS_Abstract,             "Abstract");
			ADD_FLAG(CLASS_Deprecated,           "Deprecated");
			ADD_FLAG(CLASS_Interface,            "Interface");
			ADD_FLAG(CLASS_DefaultConfig,        "DefaultConfig");
			ADD_FLAG(CLASS_Config,               "Config");
			ADD_FLAG(CLASS_Hidden,               "Hidden");
			ADD_FLAG(CLASS_HideDropDown,         "HideDropDown");
			ADD_FLAG(CLASS_NotPlaceable,         "NotPlaceable");
			ADD_FLAG(CLASS_EditInlineNew,        "EditInlineNew");
			ADD_FLAG(CLASS_CollapseCategories,   "CollapseCategories");
			ADD_FLAG(CLASS_Transient,            "Transient");
			ADD_FLAG(CLASS_Const,                "Const");
			#undef ADD_FLAG
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeFunctionFlags(EFunctionFlags Flags)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			#define ADD_FLAG(BIT, NAME) if ((Flags & (BIT)) != 0) Out.Add(MakeShared<FJsonValueString>(TEXT(NAME)))
			ADD_FLAG(FUNC_Exec,                  "Exec");
			ADD_FLAG(FUNC_BlueprintCallable,     "BlueprintCallable");
			ADD_FLAG(FUNC_BlueprintEvent,        "BlueprintEvent");
			ADD_FLAG(FUNC_BlueprintPure,         "BlueprintPure");
			ADD_FLAG(FUNC_Net,                   "Replicated");
			ADD_FLAG(FUNC_NetClient,             "Client");
			ADD_FLAG(FUNC_NetServer,             "Server");
			ADD_FLAG(FUNC_NetMulticast,          "Multicast");
			ADD_FLAG(FUNC_NetReliable,           "Reliable");
			ADD_FLAG(FUNC_Native,                "Native");
			ADD_FLAG(FUNC_Static,                "Static");
			ADD_FLAG(FUNC_Const,                 "Const");
			ADD_FLAG(FUNC_Protected,             "Protected");
			ADD_FLAG(FUNC_Public,                "Public");
			ADD_FLAG(FUNC_Private,               "Private");
			ADD_FLAG(FUNC_BlueprintCosmetic,     "BlueprintCosmetic");
			ADD_FLAG(FUNC_BlueprintAuthorityOnly,"BlueprintAuthorityOnly");
			#undef ADD_FLAG
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeMetadataMap(const FProperty* Property)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
#if WITH_EDITORONLY_DATA
			if (const TMap<FName, FString>* Meta = Property->GetMetaDataMap())
			{
				for (const TPair<FName, FString>& Pair : *Meta)
				{
					Out->SetStringField(Pair.Key.ToString(), Pair.Value);
				}
			}
#endif
			return Out;
		}
	} // anonymous namespace

	// ── Public API ─────────────────────────────────────────────

	TSharedPtr<FJsonObject> SerializeProperty(const FProperty* Property)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		if (!Property) return Out;

		Out->SetStringField(TEXT("name"), Property->GetName());
		Out->SetStringField(TEXT("cpp_type"), Property->GetCPPType());
		Out->SetStringField(TEXT("class"), Property->GetClass()->GetName());
		Out->SetArrayField(TEXT("flags"), SerializePropertyFlags(Property->GetPropertyFlags()));
		Out->SetObjectField(TEXT("metadata"), SerializeMetadataMap(Property));

		// Surface object-class types for object/class properties — callers often
		// need to know "what kind of object does this reference" without a second
		// round-trip.
		if (const FObjectPropertyBase* ObjProp = CastField<FObjectPropertyBase>(Property))
		{
			if (ObjProp->PropertyClass)
			{
				Out->SetStringField(TEXT("property_class"), ObjProp->PropertyClass->GetPathName());
			}
		}
		if (const FClassProperty* ClassProp = CastField<FClassProperty>(Property))
		{
			if (ClassProp->MetaClass)
			{
				Out->SetStringField(TEXT("meta_class"), ClassProp->MetaClass->GetPathName());
			}
		}
		if (const FSoftObjectProperty* SoftProp = CastField<FSoftObjectProperty>(Property))
		{
			if (SoftProp->PropertyClass)
			{
				Out->SetStringField(TEXT("property_class"), SoftProp->PropertyClass->GetPathName());
			}
		}

		return Out;
	}

	TArray<TSharedPtr<FJsonValue>> SerializeStructProperties(const UStruct* Struct)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		if (!Struct) return Out;
		for (TFieldIterator<FProperty> It(Struct, EFieldIteratorFlags::IncludeSuper); It; ++It)
		{
			Out.Add(MakeShared<FJsonValueObject>(SerializeProperty(*It)));
		}
		return Out;
	}

	TSharedPtr<FJsonObject> SerializeFunctionSignature(const UFunction* Function)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		if (!Function) return Out;

		Out->SetStringField(TEXT("name"), Function->GetName());
		Out->SetArrayField(TEXT("flags"), SerializeFunctionFlags(Function->FunctionFlags));

		TArray<TSharedPtr<FJsonValue>> Params;
		TSharedPtr<FJsonValue> ReturnParam;
		for (TFieldIterator<FProperty> It(Function); It && (It->PropertyFlags & CPF_Parm) != 0; ++It)
		{
			TSharedPtr<FJsonObject> P = SerializeProperty(*It);
			if ((It->PropertyFlags & CPF_ReturnParm) != 0)
			{
				ReturnParam = MakeShared<FJsonValueObject>(P);
			}
			else
			{
				Params.Add(MakeShared<FJsonValueObject>(P));
			}
		}
		Out->SetArrayField(TEXT("parameters"), Params);
		if (ReturnParam.IsValid())
		{
			Out->SetField(TEXT("return"), ReturnParam);
		}
		return Out;
	}

	TSharedPtr<FJsonObject> SerializeClassReflection(const UClass* Class)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		if (!Class) return Out;

		Out->SetStringField(TEXT("name"), Class->GetName());
		Out->SetStringField(TEXT("path"), Class->GetPathName());
		if (Class->GetSuperClass())
		{
			Out->SetStringField(TEXT("super_class"), Class->GetSuperClass()->GetPathName());
		}
		Out->SetArrayField(TEXT("class_flags"), SerializeClassFlagList(Class->GetClassFlags()));

		// Implemented interfaces
		TArray<TSharedPtr<FJsonValue>> Interfaces;
		for (const FImplementedInterface& Iface : Class->Interfaces)
		{
			if (Iface.Class)
			{
				Interfaces.Add(MakeShared<FJsonValueString>(Iface.Class->GetPathName()));
			}
		}
		Out->SetArrayField(TEXT("interfaces"), Interfaces);

		// Declared properties on THIS class only (no super walk) — callers can follow super_class for parent traversal.
		TArray<TSharedPtr<FJsonValue>> Props;
		for (TFieldIterator<FProperty> It(Class, EFieldIteratorFlags::ExcludeSuper); It; ++It)
		{
			Props.Add(MakeShared<FJsonValueObject>(SerializeProperty(*It)));
		}
		Out->SetArrayField(TEXT("properties"), Props);

		// Functions declared directly on this class
		TArray<TSharedPtr<FJsonValue>> Functions;
		for (TFieldIterator<UFunction> It(Class, EFieldIteratorFlags::ExcludeSuper); It; ++It)
		{
			Functions.Add(MakeShared<FJsonValueObject>(SerializeFunctionSignature(*It)));
		}
		Out->SetArrayField(TEXT("functions"), Functions);

		return Out;
	}

	// ── Command handlers ───────────────────────────────────────

	namespace
	{
		/**
		 * Resolve a class path → UClass*. Handles both the BP generated-class
		 * convention (`/Game/BPs/X.X_C`) and direct native classes (`/Script/Engine.Actor`).
		 */
		UClass* ResolveClass(const FString& Path)
		{
			if (UClass* Loaded = LoadClass<UObject>(nullptr, *Path))
			{
				return Loaded;
			}
			const FSoftObjectPath Soft(Path);
			if (UObject* Obj = Soft.TryLoad())
			{
				if (UBlueprint* BP = Cast<UBlueprint>(Obj))
				{
					return BP->GeneratedClass;
				}
				if (UClass* C = Cast<UClass>(Obj))
				{
					return C;
				}
			}
			return nullptr;
		}

		/**
		 * Resolve a struct path → UStruct*. Handles both UUserDefinedStruct
		 * ('/Game/Structs/X.X' loads the asset; cast to UUserDefinedStruct)
		 * and native UScriptStruct ('/Script/Engine.Transform').
		 */
		UStruct* ResolveStruct(const FString& Path)
		{
			const FSoftObjectPath Soft(Path);
			if (UObject* Obj = Soft.TryLoad())
			{
				if (UUserDefinedStruct* Uds = Cast<UUserDefinedStruct>(Obj))
				{
					return Uds;
				}
				if (UScriptStruct* Ss = Cast<UScriptStruct>(Obj))
				{
					return Ss;
				}
				// Some callers pass a class path to our struct handler by mistake —
				// if the object is actually a UClass, surface it as a struct too
				// (UClass IS-A UStruct). Keeps the handler forgiving.
				if (UClass* C = Cast<UClass>(Obj))
				{
					return C;
				}
			}
			return nullptr;
		}

		void HandleStructReflection(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_struct_reflection requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_struct_reflection requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UStruct* Struct = ResolveStruct(AssetPath);
			if (!Struct)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UStruct / UUserDefinedStruct at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"),            Struct->GetName());
			Result->SetStringField(TEXT("path"),            Struct->GetPathName());
			Result->SetStringField(TEXT("struct_class"),    Struct->GetClass()->GetName());
			if (Struct->GetSuperStruct())
			{
				Result->SetStringField(TEXT("super_struct"), Struct->GetSuperStruct()->GetPathName());
			}
			Result->SetArrayField(TEXT("properties"),       SerializeStructProperties(Struct));

			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleReflectionWalk(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("reflection_walk requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("reflection_walk requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UClass* Class = ResolveClass(AssetPath);
			if (!Class)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve class at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			BuildSuccessResponse(OutResponse, SerializeClassReflection(Class));
		}
	}

	void RegisterReflectionHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("reflection_walk"),       &HandleReflectionWalk);
		Registry.Register(TEXT("get_struct_reflection"), &HandleStructReflection);
	}
}
