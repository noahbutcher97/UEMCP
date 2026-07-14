// Copyright Optimum Athena. All Rights Reserved.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "MCPServerTransportPolicy.h"

namespace UEMCP::Transport::Tests
{
struct FTransportFixtureCase
{
	FString Id;
	TArray<uint8> Data;
	TArray<TArray<int32>> ChunkPlans;
	bool bAllSplitPoints = false;
	FMCPDecoderPolicy Policy;
	EMCPDecodeStatus ExpectedStatus = EMCPDecodeStatus::Pending;
	EMCPFramingMode ExpectedFraming = EMCPFramingMode::Undecided;
	FString ExpectedReason;
	int64 ExpectedDeclaredBodyLength = -1;
	TSharedPtr<FJsonObject> ExpectedObject;
};

bool IsWholePositiveNumber(double Value)
{
	return FMath::IsFinite(Value) && Value > 0.0 && Value <= static_cast<double>(MAX_int32)
		&& FMath::FloorToDouble(Value) == Value;
}

bool IsWholeNonNegativeNumber(double Value)
{
	return FMath::IsFinite(Value) && Value >= 0.0 && Value <= static_cast<double>(MAX_int64)
		&& FMath::FloorToDouble(Value) == Value;
}

bool DecodeAscii(const FString& Encoded, TArray<uint8>& OutBytes)
{
	OutBytes.Reset(Encoded.Len());
	for (const TCHAR Character : Encoded)
	{
		if (Character > 0x7f)
		{
			return false;
		}
		OutBytes.Add(static_cast<uint8>(Character));
	}
	return true;
}

bool JsonValuesEqual(const TSharedPtr<FJsonValue>& Left, const TSharedPtr<FJsonValue>& Right);

bool JsonObjectsEqual(const TSharedPtr<FJsonObject>& Left, const TSharedPtr<FJsonObject>& Right)
{
	if (!Left.IsValid() || !Right.IsValid() || Left->Values.Num() != Right->Values.Num())
	{
		return false;
	}

	for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Left->Values)
	{
		const TSharedPtr<FJsonValue>* RightValue = Right->Values.Find(Pair.Key);
		if (RightValue == nullptr || !JsonValuesEqual(Pair.Value, *RightValue))
		{
			return false;
		}
	}
	return true;
}

bool JsonValuesEqual(const TSharedPtr<FJsonValue>& Left, const TSharedPtr<FJsonValue>& Right)
{
	if (!Left.IsValid() || !Right.IsValid() || Left->Type != Right->Type)
	{
		return false;
	}

	switch (Left->Type)
	{
	case EJson::None:
	case EJson::Null:
		return true;
	case EJson::String:
		return Left->AsString() == Right->AsString();
	case EJson::Number:
		return Left->AsNumber() == Right->AsNumber();
	case EJson::Boolean:
		return Left->AsBool() == Right->AsBool();
	case EJson::Array:
	{
		const TArray<TSharedPtr<FJsonValue>>& LeftArray = Left->AsArray();
		const TArray<TSharedPtr<FJsonValue>>& RightArray = Right->AsArray();
		if (LeftArray.Num() != RightArray.Num())
		{
			return false;
		}
		for (int32 Index = 0; Index < LeftArray.Num(); ++Index)
		{
			if (!JsonValuesEqual(LeftArray[Index], RightArray[Index]))
			{
				return false;
			}
		}
		return true;
	}
	case EJson::Object:
		return JsonObjectsEqual(Left->AsObject(), Right->AsObject());
	default:
		return false;
	}
}

bool TryParseStatus(const FString& Value, EMCPDecodeStatus& OutStatus)
{
	if (Value == TEXT("pending"))
	{
		OutStatus = EMCPDecodeStatus::Pending;
		return true;
	}
	if (Value == TEXT("complete"))
	{
		OutStatus = EMCPDecodeStatus::Complete;
		return true;
	}
	if (Value == TEXT("malformed"))
	{
		OutStatus = EMCPDecodeStatus::Malformed;
		return true;
	}
	if (Value == TEXT("too_large"))
	{
		OutStatus = EMCPDecodeStatus::TooLarge;
		return true;
	}
	return false;
}

bool TryParseFraming(const FString& Value, EMCPFramingMode& OutFraming)
{
	if (Value == TEXT("undecided"))
	{
		OutFraming = EMCPFramingMode::Undecided;
		return true;
	}
	if (Value == TEXT("legacy"))
	{
		OutFraming = EMCPFramingMode::Legacy;
		return true;
	}
	if (Value == TEXT("framed"))
	{
		OutFraming = EMCPFramingMode::Framed;
		return true;
	}
	return false;
}

bool HasOnlyAllowedTargets(const TArray<TSharedPtr<FJsonValue>>& Targets, bool& bTargetsRequest)
{
	bTargetsRequest = false;
	if (Targets.IsEmpty())
	{
		return false;
	}

	TSet<FString> SeenTargets;
	for (const TSharedPtr<FJsonValue>& TargetValue : Targets)
	{
		if (!TargetValue.IsValid() || TargetValue->Type != EJson::String)
		{
			return false;
		}
		const FString Target = TargetValue->AsString();
		if ((Target != TEXT("request") && Target != TEXT("response")) || SeenTargets.Contains(Target))
		{
			return false;
		}
		SeenTargets.Add(Target);
		bTargetsRequest |= Target == TEXT("request");
	}
	return true;
}

bool LoadRequestFixtureCases(FAutomationTestBase& Test, TArray<FTransportFixtureCase>& OutCases, FString& OutPath)
{
	const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UEMCP"));
	if (!Plugin.IsValid())
	{
		Test.AddError(TEXT("IPluginManager could not resolve the deployed UEMCP plugin"));
		return false;
	}

	OutPath = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources"), TEXT("Tests"), TEXT("tcp-transport-cases.json"));
	FString FixtureText;
	if (!FFileHelper::LoadFileToString(FixtureText, *OutPath))
	{
		Test.AddError(FString::Printf(TEXT("Deployed TCP transport fixture is missing: %s"), *OutPath));
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(FixtureText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		Test.AddError(FString::Printf(TEXT("TCP transport fixture is not valid JSON: %s"), *OutPath));
		return false;
	}

	if (!Root->HasTypedField<EJson::Number>(TEXT("version")) || Root->GetNumberField(TEXT("version")) != 1.0)
	{
		Test.AddError(TEXT("TCP transport fixture schema version must be exactly 1"));
		return false;
	}
	if (!Root->HasTypedField<EJson::Array>(TEXT("cases")))
	{
		Test.AddError(TEXT("TCP transport fixture requires a cases array"));
		return false;
	}

	const TSet<FString> AllowedReasons = {
		TEXT("invalid_header"), TEXT("header_too_large"), TEXT("invalid_content_length"),
		TEXT("content_length_overflow"), TEXT("body_too_large"), TEXT("trailing_bytes"),
		TEXT("invalid_utf8"), TEXT("invalid_bom"), TEXT("root_not_object"),
		TEXT("invalid_json"), TEXT("mismatched_delimiter")
	};
	TSet<FString> SeenIds;
	TSet<FString> SeenRequestIds;
	for (const TSharedPtr<FJsonValue>& CaseValue : Root->GetArrayField(TEXT("cases")))
	{
		if (!CaseValue.IsValid() || CaseValue->Type != EJson::Object)
		{
			Test.AddError(TEXT("Every TCP transport fixture case must be an object"));
			continue;
		}
		const TSharedPtr<FJsonObject> CaseObject = CaseValue->AsObject();
		if (!CaseObject->HasTypedField<EJson::String>(TEXT("id")))
		{
			Test.AddError(TEXT("TCP transport fixture case is missing a string id"));
			continue;
		}

		FTransportFixtureCase Parsed;
		Parsed.Id = CaseObject->GetStringField(TEXT("id"));
		if (Parsed.Id.IsEmpty() || SeenIds.Contains(Parsed.Id))
		{
			Test.AddError(FString::Printf(TEXT("TCP transport fixture id is empty or duplicated: %s"), *Parsed.Id));
			continue;
		}
		SeenIds.Add(Parsed.Id);

		if (!CaseObject->HasTypedField<EJson::Array>(TEXT("targets")))
		{
			Test.AddError(FString::Printf(TEXT("%s: targets must be an array"), *Parsed.Id));
			continue;
		}
		bool bTargetsRequest = false;
		if (!HasOnlyAllowedTargets(CaseObject->GetArrayField(TEXT("targets")), bTargetsRequest))
		{
			Test.AddError(FString::Printf(TEXT("%s: targets must be unique request/response strings"), *Parsed.Id));
			continue;
		}

		const bool bHasAscii = CaseObject->HasTypedField<EJson::String>(TEXT("data_ascii"));
		const bool bHasBase64 = CaseObject->HasTypedField<EJson::String>(TEXT("data_base64"));
		if (bHasAscii == bHasBase64)
		{
			Test.AddError(FString::Printf(TEXT("%s: exactly one data encoding is required"), *Parsed.Id));
			continue;
		}
		const bool bDecoded = bHasAscii
			? DecodeAscii(CaseObject->GetStringField(TEXT("data_ascii")), Parsed.Data)
			: FBase64::Decode(CaseObject->GetStringField(TEXT("data_base64")), Parsed.Data);
		if (!bDecoded || Parsed.Data.IsEmpty())
		{
			Test.AddError(FString::Printf(TEXT("%s: encoded bytes are invalid or empty"), *Parsed.Id));
			continue;
		}

		if (CaseObject->HasField(TEXT("all_split_points")))
		{
			if (!CaseObject->HasTypedField<EJson::Boolean>(TEXT("all_split_points")))
			{
				Test.AddError(FString::Printf(TEXT("%s: all_split_points must be boolean"), *Parsed.Id));
				continue;
			}
			Parsed.bAllSplitPoints = CaseObject->GetBoolField(TEXT("all_split_points"));
		}

		if (CaseObject->HasField(TEXT("policy")))
		{
			if (!CaseObject->HasTypedField<EJson::Object>(TEXT("policy")))
			{
				Test.AddError(FString::Printf(TEXT("%s: policy must be an object"), *Parsed.Id));
				continue;
			}
			const TSharedPtr<FJsonObject> Policy = CaseObject->GetObjectField(TEXT("policy"));
			if (Policy->HasField(TEXT("max_header_bytes")))
			{
				if (!Policy->HasTypedField<EJson::Number>(TEXT("max_header_bytes")))
				{
					Test.AddError(FString::Printf(TEXT("%s: max_header_bytes must be numeric"), *Parsed.Id));
					continue;
				}
				const double Value = Policy->GetNumberField(TEXT("max_header_bytes"));
				if (!IsWholePositiveNumber(Value))
				{
					Test.AddError(FString::Printf(TEXT("%s: max_header_bytes must be a positive integer"), *Parsed.Id));
					continue;
				}
				Parsed.Policy.MaxHeader = static_cast<int32>(Value);
			}
			if (Policy->HasField(TEXT("max_body_bytes")))
			{
				if (!Policy->HasTypedField<EJson::Number>(TEXT("max_body_bytes")))
				{
					Test.AddError(FString::Printf(TEXT("%s: max_body_bytes must be numeric"), *Parsed.Id));
					continue;
				}
				const double Value = Policy->GetNumberField(TEXT("max_body_bytes"));
				if (!IsWholePositiveNumber(Value))
				{
					Test.AddError(FString::Printf(TEXT("%s: max_body_bytes must be a positive integer"), *Parsed.Id));
					continue;
				}
				Parsed.Policy.MaxBody = static_cast<int64>(Value);
			}
		}

		if (!CaseObject->HasTypedField<EJson::Array>(TEXT("chunk_plans")))
		{
			Test.AddError(FString::Printf(TEXT("%s: chunk_plans must be an array"), *Parsed.Id));
			continue;
		}
		bool bChunkPlansValid = !CaseObject->GetArrayField(TEXT("chunk_plans")).IsEmpty();
		for (const TSharedPtr<FJsonValue>& PlanValue : CaseObject->GetArrayField(TEXT("chunk_plans")))
		{
			if (!PlanValue.IsValid() || PlanValue->Type != EJson::Array || PlanValue->AsArray().IsEmpty())
			{
				bChunkPlansValid = false;
				break;
			}
			TArray<int32> Plan;
			int64 PlanTotal = 0;
			for (const TSharedPtr<FJsonValue>& SizeValue : PlanValue->AsArray())
			{
				if (!SizeValue.IsValid() || SizeValue->Type != EJson::Number
					|| !IsWholePositiveNumber(SizeValue->AsNumber()))
				{
					bChunkPlansValid = false;
					break;
				}
				const int32 ChunkSize = static_cast<int32>(SizeValue->AsNumber());
				Plan.Add(ChunkSize);
				PlanTotal += ChunkSize;
			}
			if (!bChunkPlansValid || PlanTotal != Parsed.Data.Num())
			{
				bChunkPlansValid = false;
				break;
			}
			Parsed.ChunkPlans.Add(MoveTemp(Plan));
		}
		if (!bChunkPlansValid)
		{
			Test.AddError(FString::Printf(TEXT("%s: every chunk plan must contain positive integers totaling the input"), *Parsed.Id));
			continue;
		}

		if (!CaseObject->HasTypedField<EJson::Object>(TEXT("expected")))
		{
			Test.AddError(FString::Printf(TEXT("%s: expected must be an object"), *Parsed.Id));
			continue;
		}
		const TSharedPtr<FJsonObject> Expected = CaseObject->GetObjectField(TEXT("expected"));
		FString StatusText;
		FString FramingText;
		if (!Expected->TryGetStringField(TEXT("status"), StatusText)
			|| !TryParseStatus(StatusText, Parsed.ExpectedStatus)
			|| !Expected->TryGetStringField(TEXT("framing"), FramingText)
			|| !TryParseFraming(FramingText, Parsed.ExpectedFraming))
		{
			Test.AddError(FString::Printf(TEXT("%s: expected status/framing is invalid"), *Parsed.Id));
			continue;
		}

		if (Expected->HasField(TEXT("declared_body_length")))
		{
			if (!Expected->HasTypedField<EJson::Number>(TEXT("declared_body_length")))
			{
				Test.AddError(FString::Printf(TEXT("%s: declared_body_length must be numeric"), *Parsed.Id));
				continue;
			}
			const double Value = Expected->GetNumberField(TEXT("declared_body_length"));
			if (!IsWholeNonNegativeNumber(Value))
			{
				Test.AddError(FString::Printf(TEXT("%s: declared_body_length must be a non-negative integer"), *Parsed.Id));
				continue;
			}
			Parsed.ExpectedDeclaredBodyLength = static_cast<int64>(Value);
		}

		const bool bRequiresReason = Parsed.ExpectedStatus == EMCPDecodeStatus::Malformed
			|| Parsed.ExpectedStatus == EMCPDecodeStatus::TooLarge;
		const bool bHasReason = Expected->TryGetStringField(TEXT("reason_code"), Parsed.ExpectedReason);
		if (bRequiresReason != bHasReason || (bHasReason && !AllowedReasons.Contains(Parsed.ExpectedReason)))
		{
			Test.AddError(FString::Printf(TEXT("%s: terminal reason_code does not match the fixture schema"), *Parsed.Id));
			continue;
		}

		if (Parsed.ExpectedStatus == EMCPDecodeStatus::Complete)
		{
			if (!Expected->HasTypedField<EJson::Object>(TEXT("json")))
			{
				Test.AddError(FString::Printf(TEXT("%s: complete cases require an object json field"), *Parsed.Id));
				continue;
			}
			Parsed.ExpectedObject = Expected->GetObjectField(TEXT("json"));
		}
		else if (Expected->HasField(TEXT("json")))
		{
			Test.AddError(FString::Printf(TEXT("%s: non-complete cases must omit json"), *Parsed.Id));
			continue;
		}

		if (bTargetsRequest)
		{
			SeenRequestIds.Add(Parsed.Id);
			OutCases.Add(MoveTemp(Parsed));
		}
	}

	const TSet<FString> RequiredRequestIds = {
		TEXT("framed-basic"), TEXT("framed-case-insensitive"), TEXT("framed-extra-header"),
		TEXT("framed-colon-in-extra-value"), TEXT("framed-bom-multibyte"), TEXT("legacy-bom-multibyte"),
		TEXT("bom-valid-object"), TEXT("legacy-basic"), TEXT("legacy-leading-trailing-whitespace"),
		TEXT("legacy-nested-escaped"), TEXT("partial-prefix"), TEXT("partial-header"),
		TEXT("partial-framed-body"), TEXT("partial-legacy-object"), TEXT("header-empty-length"),
		TEXT("header-signed-length"), TEXT("header-suffixed-length"), TEXT("header-embedded-space"),
		TEXT("header-duplicate-length"), TEXT("header-bad-extra-name"), TEXT("header-missing-extra-colon"),
		TEXT("header-folded-line"), TEXT("header-control-value"), TEXT("header-non-ascii"),
		TEXT("request-huge-length"), TEXT("header-cap-no-terminator"), TEXT("framed-exact-small-limit"),
		TEXT("framed-over-small-limit"), TEXT("legacy-exact-small-limit"), TEXT("legacy-over-small-limit"),
		TEXT("framed-trailing-byte"), TEXT("legacy-trailing-byte"), TEXT("legacy-mismatched-close"),
		TEXT("json-root-array"), TEXT("json-root-scalar"), TEXT("json-invalid-object"),
		TEXT("utf8-overlong"), TEXT("utf8-surrogate"), TEXT("utf8-above-max"),
		TEXT("utf8-forbidden-lead"), TEXT("utf8-lone-continuation"), TEXT("utf8-malformed-continuation"),
		TEXT("utf8-truncated-framed"), TEXT("bom-duplicate"), TEXT("bom-after-whitespace"),
		TEXT("bom-partial-framed")
	};
	for (const FString& RequiredId : RequiredRequestIds)
	{
		if (!SeenRequestIds.Contains(RequiredId))
		{
			Test.AddError(FString::Printf(TEXT("Required request-target fixture case is missing: %s"), *RequiredId));
		}
	}
	if (SeenRequestIds.Num() != RequiredRequestIds.Num() || OutCases.Num() != RequiredRequestIds.Num())
	{
		Test.AddError(FString::Printf(TEXT("Version 1 fixture must contain exactly %d request cases, found %d"),
			RequiredRequestIds.Num(), OutCases.Num()));
	}

	return !OutCases.IsEmpty() && !Test.HasAnyErrors();
}

int64 ExpectedLegacyScanCount(const TArray<uint8>& Data, int64 MaxBody)
{
	constexpr uint8 Bom[] = {0xef, 0xbb, 0xbf};
	bool bBeforeRoot = true;
	bool bBomSeen = false;
	int32 BomProgress = 0;
	bool bRootComplete = false;
	bool bInString = false;
	bool bEscaped = false;
	TArray<uint8> Delimiters;
	int64 Scanned = 0;

	for (const uint8 Byte : Data)
	{
		if (Scanned >= MaxBody)
		{
			break;
		}
		const int64 Position = Scanned++;
		if (bBeforeRoot)
		{
			if (BomProgress == 1)
			{
				if (Byte != Bom[1]) break;
				BomProgress = 2;
				continue;
			}
			if (BomProgress == 2)
			{
				if (Byte != Bom[2]) break;
				BomProgress = 0;
				bBomSeen = true;
				continue;
			}
			if (Byte == Bom[0])
			{
				if (Position != 0 || bBomSeen) break;
				BomProgress = 1;
				continue;
			}
			if (Byte == 0x20 || Byte == 0x09 || Byte == 0x0a || Byte == 0x0d)
			{
				continue;
			}
			if (Byte != 0x7b) break;
			bBeforeRoot = false;
			Delimiters.Add(Byte);
			continue;
		}

		if (bRootComplete)
		{
			if (Byte != 0x20 && Byte != 0x09 && Byte != 0x0a && Byte != 0x0d) break;
			continue;
		}
		if (bInString)
		{
			if (bEscaped) bEscaped = false;
			else if (Byte == 0x5c) bEscaped = true;
			else if (Byte == 0x22) bInString = false;
			continue;
		}
		if (Byte == 0x22)
		{
			bInString = true;
			continue;
		}
		if (Byte == 0x7b || Byte == 0x5b)
		{
			Delimiters.Add(Byte);
			continue;
		}
		if (Byte != 0x7d && Byte != 0x5d)
		{
			continue;
		}
		const uint8 ExpectedOpen = Byte == 0x7d ? 0x7b : 0x5b;
		if (Delimiters.IsEmpty() || Delimiters.Last() != ExpectedOpen) break;
		Delimiters.Pop(EAllowShrinking::No);
		bRootComplete = Delimiters.IsEmpty();
	}
	return Scanned;
}

int32 ExpectedJsonParseCount(const FTransportFixtureCase& Case)
{
	return Case.ExpectedStatus == EMCPDecodeStatus::Complete || Case.ExpectedReason == TEXT("invalid_json") ? 1 : 0;
}

void AssertFixtureSnapshot(
	FAutomationTestBase& Test,
	const FTransportFixtureCase& Case,
	const FString& PlanName,
	const FMCPDecodeSnapshot& Snapshot)
{
	const FString Prefix = FString::Printf(TEXT("%s/%s"), *Case.Id, *PlanName);
	Test.TestTrue(*FString::Printf(TEXT("%s status"), *Prefix), Snapshot.Status == Case.ExpectedStatus);
	Test.TestTrue(*FString::Printf(TEXT("%s framing"), *Prefix), Snapshot.Framing == Case.ExpectedFraming);
	Test.TestEqual(*FString::Printf(TEXT("%s bytes received"), *Prefix), Snapshot.BytesReceived, static_cast<int64>(Case.Data.Num()));
	Test.TestEqual(*FString::Printf(TEXT("%s declared body length"), *Prefix),
		Snapshot.DeclaredBodyLength, Case.ExpectedDeclaredBodyLength);
	Test.TestEqual(*FString::Printf(TEXT("%s reason"), *Prefix), Snapshot.ReasonCode, Case.ExpectedReason);
	if (Case.ExpectedStatus == EMCPDecodeStatus::Complete)
	{
		Test.TestTrue(*FString::Printf(TEXT("%s parsed object"), *Prefix),
			JsonObjectsEqual(Snapshot.Object, Case.ExpectedObject));
	}
	else
	{
		Test.TestFalse(*FString::Printf(TEXT("%s has no dispatchable object"), *Prefix), Snapshot.Object.IsValid());
	}
}

void RunFixturePlan(
	FAutomationTestBase& Test,
	const FTransportFixtureCase& Case,
	const TArray<int32>& Plan,
	const FString& PlanName)
{
	FMCPRequestDecoder Decoder(Case.Policy);
	int32 Offset = 0;
	int64 PreviousScanned = 0;
	for (const int32 ChunkSize : Plan)
	{
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Case.Data.GetData() + Offset, ChunkSize);
		Offset += ChunkSize;
		const int64 CurrentScanned = Decoder.GetLegacyBytesScannedForTests();
		Test.TestTrue(*FString::Printf(TEXT("%s/%s scanner is monotonic"), *Case.Id, *PlanName),
			CurrentScanned >= PreviousScanned && CurrentScanned - PreviousScanned <= ChunkSize);
		PreviousScanned = CurrentScanned;
		if (Offset < Case.Data.Num())
		{
			Test.TestTrue(*FString::Printf(TEXT("%s/%s intermediate chunk remains pending"), *Case.Id, *PlanName),
				Snapshot.Status == EMCPDecodeStatus::Pending);
		}
	}

	const FMCPDecodeSnapshot& Snapshot = Decoder.Snapshot();
	AssertFixtureSnapshot(Test, Case, PlanName, Snapshot);
	Test.TestEqual(*FString::Printf(TEXT("%s/%s parser count"), *Case.Id, *PlanName),
		Decoder.GetJsonParseCountForTests(), ExpectedJsonParseCount(Case));
	if (Case.ExpectedFraming == EMCPFramingMode::Legacy)
	{
		Test.TestEqual(*FString::Printf(TEXT("%s/%s legacy bytes scanned once"), *Case.Id, *PlanName),
			Decoder.GetLegacyBytesScannedForTests(), ExpectedLegacyScanCount(Case.Data, Case.Policy.MaxBody));
	}
	else
	{
		Test.TestEqual(*FString::Printf(TEXT("%s/%s framed input never uses legacy scanner"), *Case.Id, *PlanName),
			Decoder.GetLegacyBytesScannedForTests(), int64{0});
	}

	if (Snapshot.Status == EMCPDecodeStatus::Pending)
	{
		const int32 ParseCountBeforeEof = Decoder.GetJsonParseCountForTests();
		const FString FirstDescription = Decoder.DescribeTerminalEof();
		const FString SecondDescription = Decoder.DescribeTerminalEof();
		Test.TestFalse(*FString::Printf(TEXT("%s/%s EOF description is non-empty"), *Case.Id, *PlanName),
			FirstDescription.IsEmpty());
		Test.TestEqual(*FString::Printf(TEXT("%s/%s EOF description is stable"), *Case.Id, *PlanName),
			SecondDescription, FirstDescription);
		Test.TestTrue(*FString::Printf(TEXT("%s/%s EOF metadata remains pending"), *Case.Id, *PlanName),
			Decoder.Snapshot().Status == EMCPDecodeStatus::Pending);
		Test.TestEqual(*FString::Printf(TEXT("%s/%s EOF metadata does not parse"), *Case.Id, *PlanName),
			Decoder.GetJsonParseCountForTests(), ParseCountBeforeEof);
	}
	else
	{
		const FMCPDecodeSnapshot StableSnapshot = Snapshot;
		const int32 ParseCount = Decoder.GetJsonParseCountForTests();
		const int64 ScanCount = Decoder.GetLegacyBytesScannedForTests();
		const uint8 ExtraByte = static_cast<uint8>('X');
		const FMCPDecodeSnapshot& Reused = Decoder.Consume(&ExtraByte, 1);
		Test.TestTrue(*FString::Printf(TEXT("%s/%s terminal status is stable"), *Case.Id, *PlanName),
			Reused.Status == StableSnapshot.Status && Reused.BytesReceived == StableSnapshot.BytesReceived
			&& Reused.Object == StableSnapshot.Object);
		Test.TestEqual(*FString::Printf(TEXT("%s/%s terminal parser is stable"), *Case.Id, *PlanName),
			Decoder.GetJsonParseCountForTests(), ParseCount);
		Test.TestEqual(*FString::Printf(TEXT("%s/%s terminal scanner is stable"), *Case.Id, *PlanName),
			Decoder.GetLegacyBytesScannedForTests(), ScanCount);
	}
}

TArray<uint8> MakeAsciiBytes(const FString& Text)
{
	TArray<uint8> Bytes;
	DecodeAscii(Text, Bytes);
	return Bytes;
}

TArray<uint8> MakeFramingHeader(int64 BodyLength)
{
	return MakeAsciiBytes(FString::Printf(TEXT("Content-Length: %lld\r\n\r\n"), BodyLength));
}

TArray<uint8> MakePaddingBody(int32 TotalBytes)
{
	const ANSICHAR Prefix[] = "{\"padding\":\"";
	const ANSICHAR Suffix[] = "\"}";
	constexpr int32 PrefixBytes = UE_ARRAY_COUNT(Prefix) - 1;
	constexpr int32 SuffixBytes = UE_ARRAY_COUNT(Suffix) - 1;
	check(TotalBytes >= PrefixBytes + SuffixBytes);

	TArray<uint8> Body;
	Body.SetNumUninitialized(TotalBytes);
	FMemory::Memcpy(Body.GetData(), Prefix, PrefixBytes);
	FMemory::Memset(Body.GetData() + PrefixBytes, 'x', TotalBytes - PrefixBytes - SuffixBytes);
	FMemory::Memcpy(Body.GetData() + TotalBytes - SuffixBytes, Suffix, SuffixBytes);
	return Body;
}

void ConsumeInBoundedChunks(FMCPRequestDecoder& Decoder, const TArray<uint8>& Bytes, int32 BytesToConsume)
{
	constexpr int32 ChunkBytes = 64 * 1024;
	int32 Offset = 0;
	while (Offset < BytesToConsume)
	{
		const int32 Count = FMath::Min(ChunkBytes, BytesToConsume - Offset);
		Decoder.Consume(Bytes.GetData() + Offset, Count);
		Offset += Count;
	}
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPReceiveClassifierTest,
	"UEMCP.Transport.ReceiveClassifier",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPReceiveClassifierTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;

	auto TestAction = [this](
		const TCHAR* Description,
		bool bSucceeded,
		int32 BytesRead,
		ESocketErrors Error,
		EMCPReceiveAction Expected)
	{
		const FMCPReceiveAttempt Attempt{bSucceeded, BytesRead, Error};
		TestTrue(Description, ClassifyReceiveAttempt(Attempt) == Expected);
	};

	TestAction(TEXT("successful positive read consumes data despite stale error"),
		true, 7, SE_ECONNRESET, EMCPReceiveAction::ConsumeData);
	TestAction(TEXT("successful zero-byte read waits"),
		true, 0, SE_ECONNRESET, EMCPReceiveAction::Wait);
	TestAction(TEXT("failed zero-byte read without error is peer close"),
		false, 0, SE_NO_ERROR, EMCPReceiveAction::PeerClosed);
	TestAction(TEXT("would-block waits"),
		false, 0, SE_EWOULDBLOCK, EMCPReceiveAction::Wait);
	TestAction(TEXT("interrupted read waits"),
		false, 0, SE_EINTR, EMCPReceiveAction::Wait);

	TestAction(TEXT("connection reset is a socket error"),
		false, 0, SE_ECONNRESET, EMCPReceiveAction::SocketError);
	TestAction(TEXT("cleared attempt after reset is peer close"),
		false, 0, SE_NO_ERROR, EMCPReceiveAction::PeerClosed);

	TestAction(TEXT("another hard error is a socket error"),
		false, 0, SE_SYSTEM, EMCPReceiveAction::SocketError);
	TestAction(TEXT("negative bytes with would-block wait"),
		false, -1, SE_EWOULDBLOCK, EMCPReceiveAction::Wait);
	TestAction(TEXT("negative bytes with interruption wait"),
		false, -1, SE_EINTR, EMCPReceiveAction::Wait);
	TestAction(TEXT("negative bytes without error are a socket error"),
		false, -1, SE_NO_ERROR, EMCPReceiveAction::SocketError);
	TestAction(TEXT("negative bytes with hard error are a socket error"),
		false, -1, SE_ECONNRESET, EMCPReceiveAction::SocketError);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPTransportSharedFixturesTest,
	"UEMCP.Transport.SharedFixtures",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPTransportSharedFixturesTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;
	using namespace UEMCP::Transport::Tests;

	TestEqual(TEXT("production header cap is 512 bytes"), UEMCP::Transport::MaxHeaderBytes, 512);
	TestEqual(TEXT("production request cap is 8 MiB"), MaxRequestBodyBytes, int64{8 * 1024 * 1024});

	TArray<FTransportFixtureCase> Cases;
	FString FixturePath;
	if (!LoadRequestFixtureCases(*this, Cases, FixturePath))
	{
		return false;
	}
	AddInfo(FString::Printf(TEXT("fixture_path=%s"), *FixturePath));

	int32 ExplicitPlanExecutions = 0;
	int32 SplitExecutions = 0;
	for (const FTransportFixtureCase& Case : Cases)
	{
		for (int32 PlanIndex = 0; PlanIndex < Case.ChunkPlans.Num(); ++PlanIndex)
		{
			RunFixturePlan(*this, Case, Case.ChunkPlans[PlanIndex],
				FString::Printf(TEXT("plan-%d"), PlanIndex));
			++ExplicitPlanExecutions;
		}
		if (Case.bAllSplitPoints)
		{
			for (int32 Split = 1; Split < Case.Data.Num(); ++Split)
			{
				RunFixturePlan(*this, Case, {Split, Case.Data.Num() - Split},
					FString::Printf(TEXT("split-%d"), Split));
				++SplitExecutions;
			}
		}
	}

	TestTrue(TEXT("shared fixture executes request-target cases"), Cases.Num() > 0);
	TestEqual(TEXT("every request case has an explicit plan execution"), ExplicitPlanExecutions, Cases.Num());
	TestTrue(TEXT("exhaustive fixture split executions ran"), SplitExecutions > 0);
	AddInfo(FString::Printf(TEXT("fixture_request_cases=%d explicit_plans=%d exhaustive_splits=%d total_executions=%d"),
		Cases.Num(), ExplicitPlanExecutions, SplitExecutions, ExplicitPlanExecutions + SplitExecutions));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPTransportDecoderBoundariesTest,
	"UEMCP.Transport.DecoderBoundaries",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPTransportDecoderBoundariesTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;
	using namespace UEMCP::Transport::Tests;

	{
		const FString HeaderPrefix = TEXT("Content-Length: 2\r\nX-Pad: ");
		const FString HeaderSuffix = TEXT("\r\n\r\n");
		const int32 PadBytes = UEMCP::Transport::MaxHeaderBytes - HeaderPrefix.Len() - HeaderSuffix.Len();
		TArray<uint8> Request = MakeAsciiBytes(HeaderPrefix + FString::ChrN(PadBytes, 'x') + HeaderSuffix + TEXT("{}"));
		FMCPRequestDecoder Decoder;
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("terminated header exactly at 512 bytes completes"),
			Snapshot.Status == EMCPDecodeStatus::Complete && Snapshot.DeclaredBodyLength == 2);
		TestEqual(TEXT("exact-cap framed candidate parses once"), Decoder.GetJsonParseCountForTests(), 1);
	}

	{
		FMCPRequestDecoder Decoder;
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 6\r\n\r\n{\"x\":}"));
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("complete invalid framed object is malformed invalid_json"),
			Snapshot.Status == EMCPDecodeStatus::Malformed && Snapshot.ReasonCode == TEXT("invalid_json"));
		TestEqual(TEXT("complete invalid framed object parses exactly once"), Decoder.GetJsonParseCountForTests(), 1);
	}

	{
		FMCPRequestDecoder Decoder;
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 2\r\n\r\n[]"));
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("complete framed array is rejected as root_not_object"),
			Snapshot.Status == EMCPDecodeStatus::Malformed && Snapshot.ReasonCode == TEXT("root_not_object"));
		TestEqual(TEXT("complete framed array parses exactly once"), Decoder.GetJsonParseCountForTests(), 1);
	}

	{
		FMCPRequestDecoder Decoder;
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 1\r\n\r\n1"));
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("complete framed scalar is rejected as root_not_object"),
			Snapshot.Status == EMCPDecodeStatus::Malformed && Snapshot.ReasonCode == TEXT("root_not_object"));
		TestEqual(TEXT("complete framed scalar invokes the object parser exactly once"),
			Decoder.GetJsonParseCountForTests(), 1);
	}

	{
		FMCPRequestDecoder Decoder;
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 9223372036854775808\r\n\r\n"));
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("request Content-Length integer overflow is malformed without fallback"),
			Snapshot.Status == EMCPDecodeStatus::Malformed
			&& Snapshot.Framing == EMCPFramingMode::Framed
			&& Snapshot.ReasonCode == TEXT("content_length_overflow"));
		TestEqual(TEXT("request Content-Length overflow never parses JSON"), Decoder.GetJsonParseCountForTests(), 0);
	}

	{
		FMCPRequestDecoder Decoder;
		TArray<uint8> Partial = MakeAsciiBytes(TEXT("Content-Length: 11\r\n\r\n{\"ok\""));
		Decoder.Consume(Partial.GetData(), Partial.Num());
		const FMCPDecodeSnapshot Before = Decoder.Snapshot();
		const FString Reason = Decoder.DescribeTerminalEof();
		TestEqual(TEXT("partial framed body EOF metadata"), Reason, FString(TEXT("incomplete_body")));
		TestTrue(TEXT("EOF metadata does not terminalize pending framed body"),
			Decoder.Snapshot().Status == Before.Status && Decoder.Snapshot().BytesReceived == Before.BytesReceived);
		TestEqual(TEXT("EOF metadata does not parse pending framed body"), Decoder.GetJsonParseCountForTests(), 0);
	}

	struct FEofCase
	{
		TArray<uint8> Bytes;
		const TCHAR* Expected;
	};
	const TArray<FEofCase> EofCases = {
		{{}, TEXT("no_request")},
		{MakeAsciiBytes(TEXT("Content-Le")), TEXT("incomplete_prefix")},
		{MakeAsciiBytes(TEXT("Content-Length: 2\r\n")), TEXT("incomplete_header")},
		{{0xef, 0xbb}, TEXT("partial_bom")},
		{TArray<uint8>{'{', '"', 'x', '"', ':', '"', 0xe2, 0x82}, TEXT("truncated_utf8")},
		{MakeAsciiBytes(TEXT("{\"x\":")), TEXT("incomplete_legacy")}
	};
	for (const FEofCase& EofCase : EofCases)
	{
		FMCPRequestDecoder Decoder;
		if (!EofCase.Bytes.IsEmpty())
		{
			Decoder.Consume(EofCase.Bytes.GetData(), EofCase.Bytes.Num());
		}
		const FMCPDecodeSnapshot Before = Decoder.Snapshot();
		TestEqual(*FString::Printf(TEXT("EOF diagnostic %s"), EofCase.Expected),
			Decoder.DescribeTerminalEof(), FString(EofCase.Expected));
		TestTrue(*FString::Printf(TEXT("EOF diagnostic %s remains metadata-only"), EofCase.Expected),
			Decoder.Snapshot().Status == Before.Status && !Decoder.Snapshot().Object.IsValid());
		TestEqual(*FString::Printf(TEXT("EOF diagnostic %s parser count"), EofCase.Expected),
			Decoder.GetJsonParseCountForTests(), 0);
	}

	{
		TArray<uint8> Body = MakePaddingBody(static_cast<int32>(MaxRequestBodyBytes));
		FMCPRequestDecoder Decoder;
		TArray<uint8> Header = MakeFramingHeader(Body.Num());
		Decoder.Consume(Header.GetData(), Header.Num());
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Body.GetData(), Body.Num());
		TestTrue(TEXT("framed request exactly at 8 MiB completes"), Snapshot.Status == EMCPDecodeStatus::Complete);
		TestEqual(TEXT("exact 8 MiB framed request parses once"), Decoder.GetJsonParseCountForTests(), 1);
	}

	{
		TArray<uint8> Body = MakePaddingBody(static_cast<int32>(MaxRequestBodyBytes + 1));
		FMCPRequestDecoder Decoder;
		TArray<uint8> Header = MakeFramingHeader(Body.Num());
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Header.GetData(), Header.Num());
		TestTrue(TEXT("framed declaration one byte over 8 MiB is too large"),
			Snapshot.Status == EMCPDecodeStatus::TooLarge && Snapshot.ReasonCode == TEXT("body_too_large"));
		TestEqual(TEXT("over-limit framed request never parses"), Decoder.GetJsonParseCountForTests(), 0);
	}

	{
		TArray<uint8> Body = MakePaddingBody(static_cast<int32>(MaxRequestBodyBytes));
		FMCPRequestDecoder Decoder;
		ConsumeInBoundedChunks(Decoder, Body, Body.Num());
		TestTrue(TEXT("legacy request exactly at 8 MiB completes"), Decoder.Snapshot().Status == EMCPDecodeStatus::Complete);
		TestEqual(TEXT("exact 8 MiB legacy request parses once"), Decoder.GetJsonParseCountForTests(), 1);
		TestEqual(TEXT("exact 8 MiB legacy request scans every byte once"),
			Decoder.GetLegacyBytesScannedForTests(), MaxRequestBodyBytes);
	}

	{
		TArray<uint8> Body = MakePaddingBody(static_cast<int32>(MaxRequestBodyBytes + 1));
		FMCPRequestDecoder Decoder;
		ConsumeInBoundedChunks(Decoder, Body, static_cast<int32>(MaxRequestBodyBytes));
		TestTrue(TEXT("legacy request remains pending at 8 MiB before its closing delimiter"),
			Decoder.Snapshot().Status == EMCPDecodeStatus::Pending);
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Body.GetData() + MaxRequestBodyBytes, 1);
		TestTrue(TEXT("legacy request becomes too large before appending byte 8 MiB plus one"),
			Snapshot.Status == EMCPDecodeStatus::TooLarge && Snapshot.ReasonCode == TEXT("body_too_large"));
		TestEqual(TEXT("over-limit legacy request never parses"), Decoder.GetJsonParseCountForTests(), 0);
		TestEqual(TEXT("over-limit legacy byte is not rescanned or retained"),
			Decoder.GetLegacyBytesScannedForTests(), MaxRequestBodyBytes);
	}

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
