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

struct FFixtureExecutionCounts
{
	int32 Whole = 0;
	int32 Explicit = 0;
	int32 GeneratedSplit = 0;

	int32 Total() const
	{
		return Whole + Explicit + GeneratedSplit;
	}
};

const TSet<FString>& RequiredAllSplitPointIds()
{
	static const TSet<FString> Ids = {
		TEXT("framed-basic"),
		TEXT("framed-bom-multibyte"),
		TEXT("legacy-nested-escaped"),
		TEXT("legacy-bom-multibyte")
	};
	return Ids;
}

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
	TSet<FString> SeenAllSplitPointIds;
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
			if (Parsed.bAllSplitPoints)
			{
				if (!RequiredAllSplitPointIds().Contains(Parsed.Id))
				{
					Test.AddError(FString::Printf(TEXT("Unexpected request fixture enables all_split_points: %s"), *Parsed.Id));
					continue;
				}
				SeenAllSplitPointIds.Add(Parsed.Id);
			}
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
	for (const FString& RequiredId : RequiredAllSplitPointIds())
	{
		if (!SeenAllSplitPointIds.Contains(RequiredId))
		{
			Test.AddError(FString::Printf(TEXT("Required all_split_points request fixture is missing or false: %s"), *RequiredId));
		}
	}
	if (SeenAllSplitPointIds.Num() != RequiredAllSplitPointIds().Num())
	{
		Test.AddError(TEXT("Request fixture all_split_points IDs do not match the required exact set"));
	}

	return !OutCases.IsEmpty() && !Test.HasAnyErrors();
}

FFixtureExecutionCounts DeriveExpectedExecutionCounts(const TArray<FTransportFixtureCase>& Cases)
{
	FFixtureExecutionCounts Counts;
	Counts.Whole = Cases.Num();
	for (const FTransportFixtureCase& Case : Cases)
	{
		Counts.Explicit += Case.ChunkPlans.Num();
		if (Case.bAllSplitPoints)
		{
			Counts.GeneratedSplit += Case.Data.Num() - 1;
		}
	}
	return Counts;
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
		if (Case.ExpectedStatus == EMCPDecodeStatus::Complete
			|| Case.ExpectedStatus == EMCPDecodeStatus::Pending
			|| Case.ExpectedReason == TEXT("invalid_json"))
		{
			Test.TestEqual(*FString::Printf(TEXT("%s/%s completed legacy plan scans every delivered byte once"),
				*Case.Id, *PlanName), Decoder.GetLegacyBytesScannedForTests(), static_cast<int64>(Case.Data.Num()));
		}
		else if (Case.ExpectedStatus == EMCPDecodeStatus::TooLarge)
		{
			Test.TestEqual(*FString::Printf(TEXT("%s/%s over-limit legacy plan stops scanning at policy cap"),
				*Case.Id, *PlanName), Decoder.GetLegacyBytesScannedForTests(), Case.Policy.MaxBody);
		}
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

void RunLegacyByteAtATimeProof(FAutomationTestBase& Test, const FTransportFixtureCase& Case)
{
	FMCPRequestDecoder Decoder(Case.Policy);
	int64 ExpectedScanned = 0;
	for (int32 Index = 0; Index < Case.Data.Num(); ++Index)
	{
		const FMCPDecodeSnapshot Before = Decoder.Snapshot();
		const int64 BeforeScanned = Decoder.GetLegacyBytesScannedForTests();
		const FMCPDecodeSnapshot& After = Decoder.Consume(Case.Data.GetData() + Index, 1);
		const int64 AfterScanned = Decoder.GetLegacyBytesScannedForTests();
		const FString Prefix = FString::Printf(TEXT("%s/byte-%d"), *Case.Id, Index);

		if (Before.Status == EMCPDecodeStatus::Pending)
		{
			const int64 ExpectedDelta = BeforeScanned < Case.Policy.MaxBody ? 1 : 0;
			ExpectedScanned += ExpectedDelta;
			Test.TestEqual(*FString::Printf(TEXT("%s scanner advances by the exact current-byte amount"), *Prefix),
				AfterScanned - BeforeScanned, ExpectedDelta);
		}
		else
		{
			Test.TestEqual(*FString::Printf(TEXT("%s terminal repeated consume does not scan"), *Prefix),
				AfterScanned, BeforeScanned);
			Test.TestEqual(*FString::Printf(TEXT("%s terminal repeated consume does not receive"), *Prefix),
				After.BytesReceived, Before.BytesReceived);
		}
		Test.TestEqual(*FString::Printf(TEXT("%s cumulative scanner count is exact"), *Prefix),
			AfterScanned, ExpectedScanned);
	}

	const FMCPDecodeSnapshot& Snapshot = Decoder.Snapshot();
	Test.TestTrue(*FString::Printf(TEXT("%s byte-at-a-time framing"), *Case.Id),
		Snapshot.Framing == EMCPFramingMode::Legacy);
	Test.TestEqual(*FString::Printf(TEXT("%s byte-at-a-time final scanner count"), *Case.Id),
		Decoder.GetLegacyBytesScannedForTests(), ExpectedScanned);

	if (Snapshot.Status != EMCPDecodeStatus::Pending)
	{
		const FMCPDecodeSnapshot StableSnapshot = Snapshot;
		const int64 StableScanned = Decoder.GetLegacyBytesScannedForTests();
		const uint8 ExtraByte = static_cast<uint8>('X');
		Decoder.Consume(&ExtraByte, 1);
		Test.TestEqual(*FString::Printf(TEXT("%s terminal extra byte does not change scanner"), *Case.Id),
			Decoder.GetLegacyBytesScannedForTests(), StableScanned);
		Test.TestEqual(*FString::Printf(TEXT("%s terminal extra byte does not change bytes received"), *Case.Id),
			Decoder.Snapshot().BytesReceived, StableSnapshot.BytesReceived);
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

void AssertCompleteInvalidJsonRejected(
	FAutomationTestBase& Test,
	const FString& CaseName,
	const TArray<uint8>& Body)
{
	for (const bool bFramed : {false, true})
	{
		TArray<uint8> Request;
		if (bFramed)
		{
			Request = MakeFramingHeader(Body.Num());
		}
		Request.Append(Body);

		FMCPRequestDecoder Decoder;
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		const FString Label = FString::Printf(TEXT("%s/%s"), *CaseName, bFramed ? TEXT("framed") : TEXT("legacy"));
		Test.TestTrue(*FString::Printf(TEXT("%s rejects complete non-RFC JSON"), *Label),
			Snapshot.Status == EMCPDecodeStatus::Malformed && Snapshot.ReasonCode == TEXT("invalid_json"));
		Test.TestFalse(*FString::Printf(TEXT("%s has no dispatchable object"), *Label), Snapshot.Object.IsValid());
		Test.TestEqual(*FString::Printf(TEXT("%s invokes FJsonSerializer exactly once"), *Label),
			Decoder.GetJsonParseCountForTests(), 1);
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

	const FFixtureExecutionCounts ExpectedCounts = DeriveExpectedExecutionCounts(Cases);
	TestEqual(TEXT("derived whole-buffer fixture count remains exact"), ExpectedCounts.Whole, 46);
	TestEqual(TEXT("derived explicit fixture count remains exact"), ExpectedCounts.Explicit, 46);
	TestEqual(TEXT("derived generated-split fixture count remains exact"), ExpectedCounts.GeneratedSplit, 145);
	TestEqual(TEXT("derived fixture execution total remains exact"), ExpectedCounts.Total(), 237);
	int32 ExpectedLegacyByteAtATimeExecutions = 0;
	for (const FTransportFixtureCase& Case : Cases)
	{
		ExpectedLegacyByteAtATimeExecutions += Case.ExpectedFraming == EMCPFramingMode::Legacy ? 1 : 0;
	}
	TestEqual(TEXT("derived legacy byte-at-a-time proof count remains exact"),
		ExpectedLegacyByteAtATimeExecutions, 21);
	TestEqual(TEXT("derived total including legacy byte proofs remains exact"),
		ExpectedCounts.Total() + ExpectedLegacyByteAtATimeExecutions, 258);

	int32 WholeExecutions = 0;
	int32 ExplicitPlanExecutions = 0;
	int32 SplitExecutions = 0;
	int32 LegacyByteAtATimeExecutions = 0;
	for (const FTransportFixtureCase& Case : Cases)
	{
		RunFixturePlan(*this, Case, {Case.Data.Num()}, TEXT("whole-buffer"));
		++WholeExecutions;
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
		if (Case.ExpectedFraming == EMCPFramingMode::Legacy)
		{
			RunLegacyByteAtATimeProof(*this, Case);
			++LegacyByteAtATimeExecutions;
		}
	}

	TestEqual(TEXT("fixture runner executes exact derived whole-buffer count"), WholeExecutions, ExpectedCounts.Whole);
	TestEqual(TEXT("fixture runner executes exact derived explicit count"), ExplicitPlanExecutions, ExpectedCounts.Explicit);
	TestEqual(TEXT("fixture runner executes exact derived generated-split count"), SplitExecutions, ExpectedCounts.GeneratedSplit);
	TestEqual(TEXT("fixture runner executes exact derived total"),
		WholeExecutions + ExplicitPlanExecutions + SplitExecutions, ExpectedCounts.Total());
	TestEqual(TEXT("fixture runner executes every derived legacy byte-at-a-time proof"),
		LegacyByteAtATimeExecutions, ExpectedLegacyByteAtATimeExecutions);
	TestEqual(TEXT("fixture runner executes exact total including independent scanner proofs"),
		WholeExecutions + ExplicitPlanExecutions + SplitExecutions + LegacyByteAtATimeExecutions,
		ExpectedCounts.Total() + ExpectedLegacyByteAtATimeExecutions);
	AddInfo(FString::Printf(TEXT("fixture_request_cases=%d whole=%d explicit=%d generated_splits=%d parity_total=%d legacy_byte_at_a_time=%d total_decoder_executions=%d"),
		Cases.Num(), WholeExecutions, ExplicitPlanExecutions, SplitExecutions,
		WholeExecutions + ExplicitPlanExecutions + SplitExecutions, LegacyByteAtATimeExecutions,
		WholeExecutions + ExplicitPlanExecutions + SplitExecutions + LegacyByteAtATimeExecutions));
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
		struct FStrictJsonCase
		{
			const TCHAR* Name;
			TArray<uint8> Body;
		};
		TArray<FStrictJsonCase> StrictCases = {
			{TEXT("lowercase-nan"), MakeAsciiBytes(TEXT("{\"x\":nan}"))},
			{TEXT("mixedcase-NaN"), MakeAsciiBytes(TEXT("{\"x\":NaN}"))},
			{TEXT("negative-nan"), MakeAsciiBytes(TEXT("{\"x\":-nan}"))},
			{TEXT("positive-infinity"), MakeAsciiBytes(TEXT("{\"x\":Infinity}"))},
			{TEXT("negative-infinity"), MakeAsciiBytes(TEXT("{\"x\":-Infinity}"))},
			{TEXT("leading-plus"), MakeAsciiBytes(TEXT("{\"x\":+1}"))},
			{TEXT("leading-zero"), MakeAsciiBytes(TEXT("{\"x\":01}"))},
			{TEXT("negative-leading-zero"), MakeAsciiBytes(TEXT("{\"x\":-01}"))},
			{TEXT("missing-fraction-digits"), MakeAsciiBytes(TEXT("{\"x\":1.}"))},
			{TEXT("missing-integer-digits"), MakeAsciiBytes(TEXT("{\"x\":.1}"))},
			{TEXT("missing-exponent-digits"), MakeAsciiBytes(TEXT("{\"x\":1e}"))},
			{TEXT("missing-signed-exponent-digits"), MakeAsciiBytes(TEXT("{\"x\":1e+}"))},
			{TEXT("non-finite-number-magnitude"), MakeAsciiBytes(TEXT("{\"x\":1e400}"))},
			{TEXT("literal-case"), MakeAsciiBytes(TEXT("{\"x\":True}"))},
			{TEXT("truncated-literal"), MakeAsciiBytes(TEXT("{\"x\":tru}"))},
			{TEXT("unknown-literal"), MakeAsciiBytes(TEXT("{\"x\":undefined}"))},
			{TEXT("unknown-escape"), MakeAsciiBytes(TEXT("{\"x\":\"\\q\"}"))},
			{TEXT("short-unicode-escape"), MakeAsciiBytes(TEXT("{\"x\":\"\\u12\"}"))},
			{TEXT("nonhex-unicode-escape"), MakeAsciiBytes(TEXT("{\"x\":\"\\uZZZZ\"}"))},
			{TEXT("trailing-object-comma"), MakeAsciiBytes(TEXT("{\"x\":1,}"))},
			{TEXT("trailing-array-comma"), MakeAsciiBytes(TEXT("{\"x\":[1,]}"))},
			{TEXT("elided-object-value"), MakeAsciiBytes(TEXT("{\"x\":}"))},
			{TEXT("elided-array-value"), MakeAsciiBytes(TEXT("{\"x\":[,]}"))},
			{TEXT("missing-colon"), MakeAsciiBytes(TEXT("{\"x\" 1}"))},
			{TEXT("missing-comma"), MakeAsciiBytes(TEXT("{\"x\":1 \"y\":2}"))}
		};
		StrictCases.Add({TEXT("raw-unescaped-control"), {'{', '"', 'x', '"', ':', '"', 0x01, '"', '}'}});
		for (const FStrictJsonCase& StrictCase : StrictCases)
		{
			AssertCompleteInvalidJsonRejected(*this, StrictCase.Name, StrictCase.Body);
		}
	}

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
