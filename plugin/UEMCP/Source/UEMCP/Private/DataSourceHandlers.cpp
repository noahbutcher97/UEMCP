// Copyright Optimum Athena. All Rights Reserved.
#include "DataSourceHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "ReflectionWalker.h"

#include "Engine/DataAsset.h"
#include "Engine/DataTable.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "UObject/SoftObjectPath.h"
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

		// ── list_data_asset_types ─────────────────────────────

		void HandleListDataAssetTypes(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			// Walk all UClass* in memory, filter to UDataAsset subclasses.
			// Iteration is instant; callers can filter client-side.
			TArray<TSharedPtr<FJsonValue>> Classes;
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
	}
}
