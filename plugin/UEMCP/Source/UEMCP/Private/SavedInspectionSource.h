// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "Dom/JsonObject.h"
#include "Misc/EngineVersion.h"
#include "UObject/Package.h"

#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Serialization/MemoryReader.h"
#include "UObject/PackageFileSummary.h"
#endif

namespace UEMCP
{
	// Verify the same header/export bytes used by SavePackage's SavedHash.
	// Legacy packages without a load-bound hash can still be inspected live.
	inline bool InspectionMatchesSavedPackage(UPackage& Package)
	{
#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6
		if (Package.IsDirty() || Package.GetSavedHash().IsZero()) return false;
		FString Filename;
		if (!FPackageName::DoesPackageExist(Package.GetName(), &Filename)) return false;
		TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*Filename));
		constexpr int64 MaxBytes = 64 * 1024 * 1024;
		if (!Reader || Reader->TotalSize() <= 0 || Reader->TotalSize() > MaxBytes) return false;
		TArray<uint8> Bytes;
		Bytes.SetNumUninitialized(static_cast<int32>(Reader->TotalSize()));
		Reader->Serialize(Bytes.GetData(), Bytes.Num());
		if (Reader->IsError()) return false;
		FMemoryReader Header(Bytes, true);
		FPackageFileSummary Summary;
		Header << Summary;
		if (Header.IsError() || Summary.GetSavedHash() != Package.GetSavedHash()) return false;
		const int64 Offset = Summary.GetSavedHashRelativeOffset();
		const int64 End = Summary.PayloadTocOffset > 0 ? Summary.PayloadTocOffset : Bytes.Num();
		if (Offset < 0 || Offset + static_cast<int64>(sizeof(FIoHash)) > End || End > Bytes.Num()) return false;
		FMemory::Memzero(Bytes.GetData() + Offset, sizeof(FIoHash));
		return FIoHash::HashBuffer(Bytes.GetData(), End) == Package.GetSavedHash();
#else
		return false;
#endif
	}

	inline void AddInspectionSource(FJsonObject& Result, UObject& Asset, const TSharedPtr<FJsonObject>& Params)
	{
		UPackage* Package = Asset.GetOutermost();
		Result.SetBoolField(TEXT("dirty"), Package->IsDirty());
		Result.SetStringField(TEXT("engine_version"), FEngineVersion::Current().ToString());
		bool bVerify = false;
		if (Params && Params->TryGetBoolField(TEXT("verify_saved_source"), bVerify) && bVerify)
		{
			Result.SetBoolField(TEXT("saved_source_verified"), InspectionMatchesSavedPackage(*Package));
		}
	}
}
