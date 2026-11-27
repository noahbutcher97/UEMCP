#include "ChooserFixtureLibrary.h"
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
#include "Animation/AnimMontage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BoolColumn.h"
#include "Chooser.h"
#include "NameColumn.h"
#include "ObjectChooser_Asset.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/SavePackage.h"

namespace
{
	const TCHAR* const ChooserObject = TEXT("/Game/ChooserFixture/CT_Selection.CT_Selection");

	UObject* NewChooserFixtureAsset(UClass* Type, const TCHAR* Name)
	{
		const FString Path = FString(TEXT("/Game/ChooserFixture/")) + Name;
		if (FindPackage(nullptr, *Path) || FPackageName::DoesPackageExist(Path)) return nullptr;
		return NewObject<UObject>(CreatePackage(*Path), Type, FName(Name), RF_Public | RF_Standalone | RF_Transactional);
	}

	bool SaveChooserFixtureAsset(UObject* Object)
	{
		UPackage* Package = Object->GetPackage();
		const FString File = FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetAssetPackageExtension());
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(File), true);
		FAssetRegistryModule::AssetCreated(Object);
		Package->MarkPackageDirty();
		FSavePackageArgs Args;
		Args.TopLevelFlags = RF_Public | RF_Standalone;
		return UPackage::SavePackage(Package, Object, *File, Args);
	}

	UChooserTable* LoadChooserFixture()
	{
		return LoadObject<UChooserTable>(nullptr, ChooserObject);
	}
}
#endif

bool UChooserFixtureLibrary::CreateChooserFixture()
{
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
	UChooserTable* Table = Cast<UChooserTable>(NewChooserFixtureAsset(UChooserTable::StaticClass(), TEXT("CT_Selection")));
	if (!Table) return false;
	Table->OutputObjectType = UAnimMontage::StaticClass();
	Table->ContextData.AddDefaulted_GetRef().InitializeAs<FContextObjectTypeStruct>();
	Table->ContextData[0].GetMutable<FContextObjectTypeStruct>().Struct = FUEMCPChooserInput::StaticStruct();

	FInstancedStruct& Column = Table->ColumnsStructs.AddDefaulted_GetRef();
	Column.InitializeAs<FChooserNameColumn>();
	auto& Filter = Column.GetMutable<FChooserNameColumn>();
	Filter.InputValue.InitializeAs<FNameContextProperty>();
	Filter.InputValue.GetMutable<FNameContextProperty>().Binding.PropertyBindingChain.Add(GET_MEMBER_NAME_CHECKED(FUEMCPChooserInput, Key));
	const TCHAR* Names[] = { TEXT("Idle"), TEXT("Run"), TEXT("Removed"), TEXT("Fallback") };
	for (int32 Index = 0; Index < 4; ++Index)
	{
		UObject* Anim = NewChooserFixtureAsset(UAnimMontage::StaticClass(), Names[Index]);
		if (!Anim || !SaveChooserFixtureAsset(Anim)) return false;
		FInstancedStruct& Entry = Index == 3 ? Table->FallbackResult : Table->ResultsStructs.AddDefaulted_GetRef();
		if (Index == 1)
		{
			Entry.InitializeAs<FSoftAssetChooser>();
			Entry.GetMutable<FSoftAssetChooser>().Asset = Anim;
		}
		else
		{
			Entry.InitializeAs<FAssetChooser>();
			Entry.GetMutable<FAssetChooser>().Asset = Anim;
		}
		if (Index < 3)
		{
			Filter.RowValues.AddDefaulted_GetRef().Value = FName(Names[Index]);
			Table->DisabledRows.Add(Index == 2);
		}
	}
	Table->Compile(true);
	return SaveChooserFixtureAsset(Table);
#else
	return false;
#endif
}

bool UChooserFixtureLibrary::SwapChooserFixtureResults()
{
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
	UChooserTable* Table = LoadChooserFixture();
	if (!Table || Table->ResultsStructs.Num() != 3) return false;
	Table->ResultsStructs.Swap(0, 1);
	Table->MarkPackageDirty();
	Table->Compile(true);
	return true;
#else
	return false;
#endif
}

bool UChooserFixtureLibrary::AddUnsupportedChooserColumn()
{
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
	UChooserTable* Table = LoadChooserFixture();
	if (!Table || Table->ColumnsStructs.Num() != 1) return false;
	Table->ColumnsStructs.AddDefaulted_GetRef().InitializeAs<FBoolColumn>();
	Table->MarkPackageDirty();
	return true;
#else
	return false;
#endif
}

FString UChooserFixtureLibrary::EvaluateChooserFixture(FName Key, bool bProvideInput)
{
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8
	UChooserTable* Table = LoadChooserFixture();
	if (!Table) return {};
	FUEMCPChooserInput Input;
	Input.Key = Key;
	FChooserEvaluationContext Context;
	if (bProvideInput) Context.AddStructParam(Input);
	FString Result;
	UChooserTable::EvaluateChooser(Context, Table, FObjectChooserBase::FObjectChooserIteratorCallback::CreateLambda([&Result](UObject* Object)
	{
		Result = GetPathNameSafe(Object);
		return FObjectChooserBase::EIteratorStatus::Stop;
	}));
	return Result;
#else
	return {};
#endif
}
