// Copyright Noah Butcher. All Rights Reserved.
#include "DataSourceHandlers.h"

#include "AssetToolsModule.h"
#include "BlueprintHandlerHelpers.h"
#include "HandlerCommon.h"
#include "IAssetTools.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "ReflectionWalker.h"

#include "Engine/DataAsset.h"
#include "Engine/DataTable.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "UObject/Package.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UnrealType.h"
#include "UObject/UObjectIterator.h"

namespace UEMCP
{
	namespace
	{
		// ── get_datatable_contents ────────────────────────────

		void HandleGetDataTableContents(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_datatable_contents requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_datatable_contents requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			const FSoftObjectPath Soft(AssetPath);
			UDataTable* Table = Cast<UDataTable>(Soft.TryLoad());
			if (!Table)
			{
				// Fallback: LoadObject in case path is expressed as a class path
				Table = LoadObject<UDataTable>(nullptr, *AssetPath);
			}
			if (!Table)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UDataTable at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Table->GetPathName());
			if (Table->RowStruct)
			{
				Result->SetStringField(TEXT("row_struct"), Table->RowStruct->GetPathName());
				Result->SetArrayField(TEXT("row_struct_properties"), SerializeStructProperties(Table->RowStruct));
			}

			// Row names (fast, always-correct)
			TArray<TSharedPtr<FJsonValue>> RowNames;
			for (const TPair<FName, uint8*>& Pair : Table->GetRowMap())
			{
				RowNames.Add(MakeShared<FJsonValueString>(Pair.Key.ToString()));
			}
			Result->SetArrayField(TEXT("row_names"), RowNames);
			Result->SetNumberField(TEXT("num_rows"), RowNames.Num());

			// CSV is the canonical text representation. Callers that want structured
			// per-row values can parse the CSV or follow up with read_asset_properties
			// (offline) which emits FPropertyTag-decoded maps per row struct.
			Result->SetStringField(TEXT("csv"), Table->GetTableAsCSV());

			BuildSuccessResponse(OutResponse, Result);
		}

		// ── get_string_table_contents ─────────────────────────

		void HandleGetStringTableContents(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_string_table_contents requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_string_table_contents requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			const FSoftObjectPath Soft(AssetPath);
			UStringTable* Table = Cast<UStringTable>(Soft.TryLoad());
			if (!Table)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UStringTable at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			FStringTableConstRef Inner = Table->GetStringTable();
			TArray<TSharedPtr<FJsonValue>> Entries;
			Inner->EnumerateSourceStrings([&Entries](const FString& Key, const FString& Source) -> bool
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("key"),    Key);
				Entry->SetStringField(TEXT("source"), Source);
				Entries.Add(MakeShared<FJsonValueObject>(Entry));
				return true;
			});

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),  Table->GetPathName());
			Result->SetStringField(TEXT("namespace"),   Inner->GetNamespace());
			Result->SetArrayField(TEXT("entries"),      Entries);
			Result->SetNumberField(TEXT("num_entries"), Entries.Num());
			BuildSuccessResponse(OutResponse, Result);
		}

		// Resolve an exact project asset, including a newly created package in memory.
		UDataAsset* ResolveDataAsset(const FString& Path)
		{
			if (Path.Len() > 512 || !Path.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive)) return nullptr;
			const FString Package = FPackageName::ObjectPathToPackageName(Path);
			if (!FPackageName::IsValidLongPackageName(Package)) return nullptr;
			const FString ObjectPath = Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package);
			if (!Path.Equals(Package) && !Path.Equals(ObjectPath)) return nullptr;
			UDataAsset* Asset = LoadObject<UDataAsset>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn);
			return Asset && Asset->IsAsset() && Asset->GetPathName().Equals(ObjectPath) ? Asset : nullptr;
		}

		// Accept only values representable by the declared leaf type. Validate before opening
		// the transaction so a typo, a lossy integer conversion or a no-op preserves Redo.
		bool CoerceDataAssetNumber(const FNumericProperty* Leaf, double& Value)
		{
			if (!FMath::IsFinite(Value)) return false;
			if ((Leaf->HasMetaData(TEXT("ClampMin")) && Value < Leaf->GetDoubleMetaData(TEXT("ClampMin"))) ||
				(Leaf->HasMetaData(TEXT("ClampMax")) && Value > Leaf->GetDoubleMetaData(TEXT("ClampMax")))) return false;
			if (Leaf->IsInteger()) return Value >= MIN_int32 && Value <= MAX_int32 && static_cast<int32>(Value) == Value;
			if (CastField<FFloatProperty>(Leaf))
			{
				if (FMath::Abs(Value) > TNumericLimits<float>::Max()) return false;
				Value = static_cast<float>(Value);
			}
			return true;
		}

		void HandleDataAssetProperty(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse, bool bWrite)
		{
			FString Path, PropertyName;
			if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) ||
				!Params->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty() || PropertyName.Len() > 512)
			{
				BuildErrorResponse(OutResponse, TEXT("Supply asset_path and a dotted property_name"), TEXT("INVALID_ARGUMENT"));
				return;
			}
			UDataAsset* Asset = ResolveDataAsset(Path);
			if (!Asset)
			{
				BuildErrorResponse(OutResponse, TEXT("Expected an existing /Game DataAsset package or exact object path"), TEXT("ASSET_NOT_FOUND"));
				return;
			}
			if (bWrite && !IsWritableAnimPackage(Asset->GetOutermost()))
			{
				BuildErrorResponse(OutResponse, TEXT("The asset package is read-only"), TEXT("READ_ONLY"));
				return;
			}

			FEditPropertyChain Chain;
			if (PropertyName.StartsWith(TEXT(".")) || PropertyName.EndsWith(TEXT(".")) || PropertyName.Contains(TEXT("..")))
			{
				BuildErrorResponse(OutResponse, TEXT("Property path contains an empty field"), TEXT("INVALID_PROPERTY_PATH"));
				return;
			}
			UStruct* Owner = Asset->GetClass();
			void* Address = Asset;
			TArray<FString> Segments;
			PropertyName.ParseIntoArray(Segments, TEXT("."), false);
			FProperty* Property = nullptr;
			for (int32 Index = 0; Index < Segments.Num(); ++Index)
			{
				Property = Owner->FindPropertyByName(FName(*Segments[Index], FNAME_Find));
				if (!Property || !Property->HasAnyPropertyFlags(CPF_Edit) || Property->HasAnyPropertyFlags(CPF_Transient))
				{
					BuildErrorResponse(OutResponse, FString::Printf(TEXT("Unknown or unavailable field '%s'"), *Segments[Index]), TEXT("INVALID_PROPERTY_PATH"));
					return;
				}
				if (Property->ArrayDim != 1 || Property->HasGetter() || Property->HasSetter())
				{
					BuildErrorResponse(OutResponse, TEXT("Fixed arrays and custom accessors are unsupported"), TEXT("UNSUPPORTED_PROPERTY"));
					return;
				}
				Chain.AddTail(Property);
				Chain.SetActiveMemberPropertyNode(Chain.GetHead()->GetValue());
				Chain.SetActivePropertyNode(Property);
				if (bWrite && (Property->HasAnyPropertyFlags(CPF_EditConst | CPF_DisableEditOnInstance | CPF_NonTransactional) ||
					Property->HasMetaData(TEXT("EditCondition")) || !Asset->CanEditChange(Chain)))
				{
					BuildErrorResponse(OutResponse, TEXT("Field is read-only, conditional or nontransactional"), TEXT("READ_ONLY"));
					return;
				}
				Address = Property->ContainerPtrToValuePtr<void>(Address);
				if (Index + 1 < Segments.Num())
				{
					const FStructProperty* Struct = CastField<FStructProperty>(Property);
					if (!Struct)
					{
						BuildErrorResponse(OutResponse, TEXT("Only inline struct fields can be traversed"), TEXT("INVALID_PROPERTY_PATH"));
						return;
					}
					Owner = Struct->Struct;
				}
			}
			if (!CastField<FIntProperty>(Property) && !CastField<FFloatProperty>(Property) && !CastField<FDoubleProperty>(Property))
			{
				BuildErrorResponse(OutResponse, TEXT("Supported leaves are int32, float and double"), TEXT("UNSUPPORTED_PROPERTY"));
				return;
			}
			const FNumericProperty* Leaf = CastFieldChecked<FNumericProperty>(Property);
			const auto Read = [&]() -> double {
				return Leaf->IsInteger() ? Leaf->GetSignedIntPropertyValue(Address) : Leaf->GetFloatingPointPropertyValue(Address);
			};
			const double Previous = Read();
			if (!FMath::IsFinite(Previous))
			{
				BuildErrorResponse(OutResponse, TEXT("Existing value cannot be represented as a JSON number"), TEXT("INVALID_VALUE"));
				return;
			}
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			if (bWrite)
			{
				double Value;
				if (!Params->HasTypedField<EJson::Number>(TEXT("value")) || !Params->TryGetNumberField(TEXT("value"), Value) ||
					!CoerceDataAssetNumber(Leaf, Value))
				{
					BuildErrorResponse(OutResponse, TEXT("Supply a JSON number within the field's type and clamp bounds"), TEXT("INVALID_VALUE"));
					return;
				}
				if (Value != Previous)
				{
					const FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "SetDataAssetProperty", "Edit DataAsset property"));
					Asset->SetFlags(RF_Transactional);
					Asset->Modify();
					Asset->PreEditChange(Chain);
					if (Leaf->IsInteger()) Leaf->SetIntPropertyValue(Address, static_cast<int64>(Value));
					else Leaf->SetFloatingPointPropertyValue(Address, Value);
					FPropertyChangedEvent Event(Property, EPropertyChangeType::ValueSet);
					Event.SetActiveMemberProperty(Chain.GetHead()->GetValue());
					FPropertyChangedChainEvent Change(Chain, Event);
					Asset->PostEditChangeChainProperty(Change);
				}
				Result->SetNumberField(TEXT("previous_value"), Previous);
				Result->SetBoolField(TEXT("changed"), Previous != Read());
			}
			Result->SetStringField(TEXT("asset_path"), Asset->GetOutermost()->GetName());
			Result->SetStringField(TEXT("property_name"), PropertyName);
			Result->SetNumberField(TEXT("value"), Read());
			Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
			BuildSuccessResponse(OutResponse, Result);
		}


		void HandleCreateDataAsset(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString Name, ClassPath;
			FString Folder = TEXT("/Game");
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), Name) ||
				!Params->TryGetStringField(TEXT("subclass"), ClassPath) ||
				(Params->HasField(TEXT("path")) && !Params->TryGetStringField(TEXT("path"), Folder)))
			{
				BuildErrorResponse(OutResponse, TEXT("Supply name, subclass and an optional /Game folder"), TEXT("INVALID_ARGUMENT"));
				return;
			}
			const FString PackageName = Folder + TEXT("/") + Name;
			if (PackageName.Len() > 512 || !PackageName.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive) ||
				Name.IsEmpty() || Name.Contains(TEXT("/")) || FName(*Name).IsNone() ||
				!FPackageName::IsValidLongPackageName(PackageName) ||
				!FPackageName::IsValidObjectPath(PackageName + TEXT(".") + Name))
			{
				BuildErrorResponse(OutResponse, TEXT("Use a /Game folder and a single valid asset name"), TEXT("INVALID_PATH"));
				return;
			}
			if (ClassPath.Len() >= NAME_SIZE || !ClassPath.StartsWith(TEXT("/")) ||
				!FPackageName::IsValidObjectPath(ClassPath))
			{
				BuildErrorResponse(OutResponse, TEXT("Use the exact class path from list_data_asset_types"), TEXT("INVALID_ASSET_CLASS"));
				return;
			}
			UClass* Class = ResolveClass(ClassPath, UDataAsset::StaticClass());
			if (!Class || Class->GetPathName() != ClassPath || Class == UDataAsset::StaticClass() ||
				Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists | CLASS_Transient) ||
				!UPackage::StaticClass()->IsChildOf(Class->ClassWithin))
			{
				BuildErrorResponse(OutResponse, TEXT("Expected a concrete package-owned UDataAsset subclass"), TEXT("INVALID_ASSET_CLASS"));
				return;
			}
			if (FindPackage(nullptr, *PackageName) || FPackageName::DoesPackageExist(PackageName))
			{
				BuildErrorResponse(OutResponse, TEXT("Destination package already exists"), TEXT("ASSET_ALREADY_EXISTS"));
				return;
			}
			IAssetTools& AssetTools = FAssetToolsModule::GetModule().Get();
			if (!AssetTools.AllPassWritableFolderFilter({Folder}))
			{
				BuildErrorResponse(OutResponse, TEXT("Destination folder is not writable"), TEXT("INVALID_PATH"));
				return;
			}
			UObject* Asset = AssetTools.CreateAsset(Name, Folder, Class, nullptr);
			if (!Asset)
			{
				BuildErrorResponse(OutResponse, TEXT("AssetTools could not create the DataAsset"), TEXT("CREATE_FAILED"));
				return;
			}
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Asset->GetOutermost()->GetName());
			Result->SetStringField(TEXT("object_path"), Asset->GetPathName());
			Result->SetStringField(TEXT("class_path"), Asset->GetClass()->GetPathName());
			Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleListDataAssetTypes(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			// Walk all UClass* in memory, filter to UDataAsset subclasses.
			// Iteration is instant; callers can filter client-side.
			TArray<TSharedPtr<FJsonValue>> Classes;
			// uemcp-allow-class-resolution: enumerates all UClass subclasses (list data-asset types), not identifier→class resolution
			for (TObjectIterator<UClass> It; It; ++It)
			{
				UClass* C = *It;
				if (!C || !C->IsChildOf(UDataAsset::StaticClass()) || C == UDataAsset::StaticClass())
				{
					continue;
				}
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("name"), C->GetName());
				Entry->SetStringField(TEXT("path"), C->GetPathName());
				if (C->GetSuperClass())
				{
					Entry->SetStringField(TEXT("super_class"), C->GetSuperClass()->GetPathName());
				}
				Entry->SetBoolField(TEXT("abstract"), C->HasAnyClassFlags(CLASS_Abstract));
				Entry->SetBoolField(TEXT("native"),   C->HasAnyClassFlags(CLASS_Native));
				Classes.Add(MakeShared<FJsonValueObject>(Entry));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetArrayField(TEXT("classes"),     Classes);
			Result->SetNumberField(TEXT("num_classes"), Classes.Num());
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterDataSourceHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_datatable_contents"),     &HandleGetDataTableContents);
		Registry.Register(TEXT("get_string_table_contents"),  &HandleGetStringTableContents);
		Registry.Register(TEXT("list_data_asset_types"),      &HandleListDataAssetTypes);
		Registry.Register(TEXT("create_data_asset"),          &HandleCreateDataAsset);
		Registry.Register(TEXT("get_data_asset_property"), [](const auto& Params, auto& Out) { HandleDataAssetProperty(Params, Out, false); });
		Registry.Register(TEXT("set_data_asset_property"), [](const auto& Params, auto& Out) { HandleDataAssetProperty(Params, Out, true); });
	}
}
