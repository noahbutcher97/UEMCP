// Copyright Noah Butcher. All Rights Reserved.
#include "ChooserInspection.h"
#include "SavedInspectionSource.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
#include "StructUtils/InstancedStruct.h"

namespace UEMCP::ChooserInspection
{
	using FJson = TSharedPtr<FJsonObject>;
	using FValues = TArray<TSharedPtr<FJsonValue>>;

	// Chooser is optional in consuming projects. Read only reflected layouts that match
	// the declared schema; loading the bridge never requires loading the Chooser plugin.
	const FStructProperty* StructField(const UStruct* Owner, const TCHAR* Field, const FString& Type)
	{
		const FStructProperty* P = Owner ? FindFProperty<FStructProperty>(Owner, Field) : nullptr;
		return P && P->Struct->GetPathName() == Type && P->ArrayDim == 1 ? P : nullptr;
	}

	const FArrayProperty* StructArray(const UStruct* Owner, const TCHAR* Field, const FString& Type)
	{
		const FArrayProperty* P = Owner ? FindFProperty<FArrayProperty>(Owner, Field) : nullptr;
		const FStructProperty* Inner = P ? CastField<FStructProperty>(P->Inner) : nullptr;
		return Inner && Inner->Struct->GetPathName() == Type ? P : nullptr;
	}

	void Issue(FValues& Issues, const TCHAR* Reason, int32 Column = INDEX_NONE, int32 Row = INDEX_NONE, bool bFallback = false)
	{
		FJson I = MakeShared<FJsonObject>();
		I->SetStringField(TEXT("reason"), Reason);
		if (Column != INDEX_NONE) I->SetNumberField(TEXT("column_index"), Column);
		if (Row != INDEX_NONE) I->SetNumberField(TEXT("row_index"), Row);
		if (bFallback) I->SetBoolField(TEXT("fallback"), true);
		Issues.Add(MakeShared<FJsonValueObject>(I));
	}

	TSharedPtr<FJsonValue> ResultValue(const FInstancedStruct& Entry, FValues& Issues, int32 Row, bool bFallback, int32& TextRemaining)
	{
		if (!Entry.IsValid()) return MakeShared<FJsonValueNull>();
		FJson Result = MakeShared<FJsonObject>();
		const UScriptStruct* Struct = Entry.GetScriptStruct();
		const FString Type = Struct->GetPathName();
		Result->SetStringField(TEXT("type"), Type);
		FString Asset;
		bool bSupported = false;
		if (Type == TEXT("/Script/Chooser.AssetChooser"))
		{
			if (const FObjectProperty* P = FindFProperty<FObjectProperty>(Struct, TEXT("Asset")))
			{
				UObject* Object = P->GetObjectPropertyValue_InContainer(Entry.GetMemory());
				if (Object) Asset = Object->GetPathName();
				bSupported = true;
			}
		}
		else if (Type == TEXT("/Script/Chooser.SoftAssetChooser"))
		{
			if (const FSoftObjectProperty* P = FindFProperty<FSoftObjectProperty>(Struct, TEXT("Asset")))
			{
				Asset = P->GetPropertyValue_InContainer(Entry.GetMemory()).ToSoftObjectPath().ToString();
				bSupported = true;
			}
		}
		if (!bSupported) Issue(Issues, TEXT("unsupported_result_type_or_layout"), INDEX_NONE, Row, bFallback);
		else if (Asset.IsEmpty()) Result->SetField(TEXT("asset_path"), MakeShared<FJsonValueNull>());
		else if (Asset.Len() > TextRemaining) Issue(Issues, TEXT("result_path_text_limit"), INDEX_NONE, Row, bFallback);
		else
		{
			Result->SetStringField(TEXT("asset_path"), Asset);
			TextRemaining -= Asset.Len();
		}
		return MakeShared<FJsonValueObject>(Result);
	}

	bool ReadNameBinding(const FInstancedStruct& Column, FJson& Description, int32& TextRemaining)
	{
		const auto* Input = StructField(Column.GetScriptStruct(), TEXT("InputValue"), FInstancedStruct::StaticStruct()->GetPathName());
		if (!Input) return false;
		const auto* Param = Input->ContainerPtrToValuePtr<FInstancedStruct>(Column.GetMemory());
		if (!Param->IsValid() || Param->GetScriptStruct()->GetPathName() != TEXT("/Script/Chooser.NameContextProperty")) return false;
		const auto* Binding = StructField(Param->GetScriptStruct(), TEXT("Binding"), TEXT("/Script/Chooser.ChooserPropertyBinding"));
		if (!Binding) return false;
		const void* Data = Binding->ContainerPtrToValuePtr<void>(Param->GetMemory());
		const auto* Chain = FindFProperty<FArrayProperty>(Binding->Struct, TEXT("PropertyBindingChain"));
		const auto* Index = FindFProperty<FIntProperty>(Binding->Struct, TEXT("ContextIndex"));
		const auto* Root = FindFProperty<FBoolProperty>(Binding->Struct, TEXT("IsBoundToRoot"));
		if (!Chain || !CastField<FNameProperty>(Chain->Inner) || !Index || !Root) return false;
		Description->SetNumberField(TEXT("context_index"), Index->GetPropertyValue_InContainer(Data));
		Description->SetBoolField(TEXT("bound_to_root"), Root->GetPropertyValue_InContainer(Data));
		FScriptArrayHelper Names(Chain, Chain->ContainerPtrToValuePtr<void>(Data));
		if (Names.Num() > 32) return false;
		FValues Elements;
		for (int32 I = 0; I < Names.Num(); ++I)
		{
			const FString Name = reinterpret_cast<const FName*>(Names.GetRawPtr(I))->ToString();
			if (Name.Len() > TextRemaining) return false;
			TextRemaining -= Name.Len();
			Elements.Add(MakeShared<FJsonValueString>(Name));
		}
		Description->SetArrayField(TEXT("property_chain"), Elements);
		return true;
	}

	void ReadColumn(const FInstancedStruct& Col, int32 Index, FValues& Columns, TArray<FValues>& RowCells, FValues& Issues, int32& TextRemaining)
	{
		FJson Desc = MakeShared<FJsonObject>();
		Columns.Add(MakeShared<FJsonValueObject>(Desc));
		Desc->SetNumberField(TEXT("column_index"), Index);
		const UScriptStruct* Struct = Col.GetScriptStruct();
		const FString Type = Struct ? Struct->GetPathName() : FString();
		Desc->SetStringField(TEXT("type"), Type);
		if (const auto* Disabled = Struct ? FindFProperty<FBoolProperty>(Struct, TEXT("bDisabled")) : nullptr)
			Desc->SetBoolField(TEXT("disabled"), Disabled->GetPropertyValue_InContainer(Col.GetMemory()));
		else Issue(Issues, TEXT("missing_column_disabled_state"), Index);
		const auto* Values = StructArray(Struct, TEXT("RowValues"), TEXT("/Script/Chooser.ChooserNameRowData"));
		if (Type != TEXT("/Script/Chooser.ChooserNameColumn") || !Values)
		{
			Issue(Issues, TEXT("unsupported_column_type_or_layout"), Index);
			return;
		}
		Desc->SetStringField(TEXT("on_unresolved_input"), TEXT("pass_all_rows"));
		if (!ReadNameBinding(Col, Desc, TextRemaining)) Issue(Issues, TEXT("unsupported_or_oversized_input_binding"), Index);
		const UScriptStruct* CellType = CastFieldChecked<FStructProperty>(Values->Inner)->Struct;
		const auto* Op = FindFProperty<FEnumProperty>(CellType, TEXT("Comparison"));
		const auto* Name = FindFProperty<FNameProperty>(CellType, TEXT("Value"));
		if (!Op || !Op->GetEnum() || !Name)
		{
			Issue(Issues, TEXT("unsupported_cell_layout"), Index);
			return;
		}
		FScriptArrayHelper Cells(Values, Values->ContainerPtrToValuePtr<void>(Col.GetMemory()));
		if (Cells.Num() != RowCells.Num()) Issue(Issues, TEXT("cell_count_mismatch"), Index);
		for (int32 Row = 0; Row < FMath::Min(Cells.Num(), RowCells.Num()); ++Row)
		{
			const void* Data = Cells.GetRawPtr(Row);
			const int64 Raw = Op->GetUnderlyingProperty()->GetSignedIntPropertyValue(Op->ContainerPtrToValuePtr<void>(Data));
			const FString Comparison = Op->GetEnum()->GetNameStringByValue(Raw);
			FJson Cell = MakeShared<FJsonObject>();
			Cell->SetNumberField(TEXT("column_index"), Index);
			const FString Key = Name->GetPropertyValue_InContainer(Data).ToString();
			if (Key.Len() > TextRemaining)
			{
				Issue(Issues, TEXT("cell_text_limit"), Index, Row);
				return;
			}
			TextRemaining -= Key.Len();
			Cell->SetStringField(TEXT("value"), Key);
			Cell->SetStringField(TEXT("comparison"), Comparison);
			if (Comparison != TEXT("MatchEqual") && Comparison != TEXT("MatchNotEqual") && Comparison != TEXT("MatchAny"))
				Issue(Issues, TEXT("unsupported_comparison"), Index, Row);
			RowCells[Row].Add(MakeShared<FJsonValueObject>(Cell));
		}
	}

	void Inspect(const TSharedPtr<FJsonObject>& Params, FJson& Out)
	{
		FString Path;
		if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) || Path.Len() > 512 ||
			!Path.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive) || !FPackageName::IsValidLongPackageName(Path))
		{
			BuildErrorResponse(Out, TEXT("Supply a /Game package path for a Chooser table"), TEXT("INVALID_ASSET_PATH"));
			return;
		}
		const FString ObjPath = Path + TEXT(".") + FPackageName::GetLongPackageAssetName(Path);
		// uemcp-allow-class-resolution: probe the already-loaded optional Chooser class without loading its module.
		UClass* ChooserClass = FindObject<UClass>(nullptr, TEXT("/Script/Chooser.ChooserTable"));
		if (!ChooserClass)
		{
			BuildErrorResponse(Out, TEXT("Enable the Chooser plugin in this project and reopen the editor"), TEXT("CHOOSER_UNAVAILABLE"));
			return;
		}
		UObject* Table = StaticLoadObject(ChooserClass, nullptr, *ObjPath, nullptr, LOAD_NoWarn);
		if (!Table || !Table->IsAsset() || !Table->GetPathName().Equals(ObjPath, ESearchCase::CaseSensitive))
		{
			BuildErrorResponse(Out, TEXT("Expected an existing Chooser table at the exact supplied path"), TEXT("ASSET_NOT_FOUND"));
			return;
		}
		const FString Instanced = FInstancedStruct::StaticStruct()->GetPathName();
		const auto* Results = StructArray(ChooserClass, TEXT("ResultsStructs"), Instanced);
		const auto* Cols = StructArray(ChooserClass, TEXT("ColumnsStructs"), Instanced);
		const auto* Disabled = FindFProperty<FArrayProperty>(ChooserClass, TEXT("DisabledRows"));
		const auto* Fallback = StructField(ChooserClass, TEXT("FallbackResult"), Instanced);
		const auto* Bool = Disabled ? CastField<FBoolProperty>(Disabled->Inner) : nullptr;
		if (!Results || !Cols || !Fallback || !Bool || Table->GetPackage()->HasAnyPackageFlags(PKG_Cooked | PKG_FilterEditorOnly))
		{
			BuildErrorResponse(Out, TEXT("Expected an editor Chooser table with a supported row layout"), TEXT("UNSUPPORTED_CHOOSER_LAYOUT"));
			return;
		}
		FScriptArrayHelper R(Results, Results->ContainerPtrToValuePtr<void>(Table));
		FScriptArrayHelper C(Cols, Cols->ContainerPtrToValuePtr<void>(Table));
		FScriptArrayHelper D(Disabled, Disabled->ContainerPtrToValuePtr<void>(Table));
		if (R.Num() > 2048 || C.Num() > 64 || static_cast<int64>(R.Num()) * C.Num() > 8192)
		{
			BuildErrorResponse(Out, TEXT("Table exceeds the per-read row or column budget"), TEXT("CHOOSER_TOO_LARGE"));
			return;
		}
		int32 TextRemaining = 512 * 1024;
		FValues RowList, Columns, Issues;
		TArray<FValues> RowCells;
		RowCells.SetNum(R.Num());
		for (int32 I = 0; I < C.Num(); ++I)
			ReadColumn(*reinterpret_cast<const FInstancedStruct*>(C.GetRawPtr(I)), I, Columns, RowCells, Issues, TextRemaining);
		for (int32 I = 0; I < R.Num(); ++I)
		{
			FJson Row = MakeShared<FJsonObject>();
			Row->SetNumberField(TEXT("row_index"), I);
			Row->SetBoolField(TEXT("disabled"), I < D.Num() && Bool->GetPropertyValue(D.GetRawPtr(I)));
			Row->SetArrayField(TEXT("cells"), RowCells[I]);
			Row->SetField(TEXT("result"), ResultValue(*reinterpret_cast<const FInstancedStruct*>(R.GetRawPtr(I)), Issues, I, false, TextRemaining));
			RowList.Add(MakeShared<FJsonValueObject>(Row));
		}
		FJson Data = MakeShared<FJsonObject>();
		Data->SetField(TEXT("fallback"), ResultValue(*Fallback->ContainerPtrToValuePtr<FInstancedStruct>(Table), Issues, INDEX_NONE, true, TextRemaining));
		Data->SetNumberField(TEXT("schema_version"), 1);
		Data->SetStringField(TEXT("asset_path"), Path);
		AddInspectionSource(*Data, *Table, Params);
		Data->SetArrayField(TEXT("columns"), Columns);
		Data->SetArrayField(TEXT("rows"), RowList);
		Data->SetArrayField(TEXT("issues"), Issues);
		Data->SetBoolField(TEXT("complete"), Issues.IsEmpty());
		BuildSuccessResponse(Out, Data);
	}
}
#endif

void UEMCP::RegisterChooserInspection(FMCPCommandRegistry& Registry)
{
#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
	Registry.Register(TEXT("get_chooser_table"), &ChooserInspection::Inspect);
#else
	Registry.Register(TEXT("get_chooser_table"), [](const auto&, auto& Out)
	{
		BuildErrorResponse(Out, TEXT("Chooser inspection requires UE 5.8 or newer"), TEXT("UNSUPPORTED_ENGINE_VERSION"));
	});
#endif
}
