// Copyright Optimum Athena. All Rights Reserved.

#if WITH_DEV_AUTOMATION_TESTS

#include <limits>

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

constexpr double MaxJavaScriptSafeInteger = 9007199254740991.0;

bool IsJavaScriptSafeInteger(double Value)
{
	return FMath::IsFinite(Value) && FMath::Abs(Value) <= MaxJavaScriptSafeInteger
		&& FMath::FloorToDouble(Value) == Value;
}

bool IsWholePositiveInt32(double Value)
{
	return IsJavaScriptSafeInteger(Value) && Value > 0.0 && Value <= static_cast<double>(MAX_int32);
}

bool IsWholePositiveInt64(double Value)
{
	return IsJavaScriptSafeInteger(Value) && Value > 0.0 && Value <= static_cast<double>(MAX_int64);
}

bool IsWholeNonNegativeInt64(double Value)
{
	return IsJavaScriptSafeInteger(Value) && Value >= 0.0 && Value <= static_cast<double>(MAX_int64);
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

bool DecodeCanonicalBase64(const FString& Encoded, TArray<uint8>& OutBytes)
{
	OutBytes.Reset();
	if (Encoded.IsEmpty() || Encoded.Len() % 4 != 0)
	{
		return false;
	}

	int32 Padding = 0;
	if (Encoded.EndsWith(TEXT("==")))
	{
		Padding = 2;
	}
	else if (Encoded.EndsWith(TEXT("=")))
	{
		Padding = 1;
	}
	const int32 PayloadLength = Encoded.Len() - Padding;
	if ((Padding == 0 && PayloadLength % 4 != 0)
		|| (Padding == 1 && PayloadLength % 4 != 3)
		|| (Padding == 2 && PayloadLength % 4 != 2))
	{
		return false;
	}

	for (int32 Index = 0; Index < PayloadLength; ++Index)
	{
		const TCHAR Character = Encoded[Index];
		const bool bInAlphabet = (Character >= 'A' && Character <= 'Z')
			|| (Character >= 'a' && Character <= 'z')
			|| (Character >= '0' && Character <= '9')
			|| Character == '+' || Character == '/';
		if (!bInAlphabet)
		{
			return false;
		}
	}
	for (int32 Index = PayloadLength; Index < Encoded.Len(); ++Index)
	{
		if (Encoded[Index] != '=')
		{
			return false;
		}
	}

	return FBase64::Decode(Encoded, OutBytes)
		&& !OutBytes.IsEmpty()
		&& FBase64::Encode(OutBytes) == Encoded;
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

	for (const TSharedPtr<FJsonValue>& TargetValue : Targets)
	{
		if (!TargetValue.IsValid() || TargetValue->Type != EJson::String)
		{
			return false;
		}
		const FString Target = TargetValue->AsString();
		if (Target != TEXT("request") && Target != TEXT("response"))
		{
			return false;
		}
		bTargetsRequest |= Target == TEXT("request");
	}
	return true;
}

enum class EFixtureSchemaError : uint8
{
	None,
	Id,
	Targets,
	EncodingPresence,
	EncodingType,
	EncodedBytes,
	AllSplitPoints,
	PolicyType,
	PolicyShape,
	PolicyValue,
	ChunkPlans,
	ExpectedShape,
	StatusOrFraming,
	DeclaredBodyLength,
	ReasonCode,
	ExpectedJson
};

bool TryValidateFixtureRoot(const TSharedPtr<FJsonObject>& Root, FString& OutError)
{
	if (!Root.IsValid())
	{
		OutError = TEXT("TCP transport fixture root must be an object");
		return false;
	}
	if (!Root->HasTypedField<EJson::Number>(TEXT("version")))
	{
		OutError = TEXT("TCP transport fixture schema version must be numeric");
		return false;
	}
	const double Version = Root->GetNumberField(TEXT("version"));
	if (!IsJavaScriptSafeInteger(Version) || Version != 1.0)
	{
		OutError = TEXT("TCP transport fixture schema version must be exactly 1");
		return false;
	}
	if (!Root->HasTypedField<EJson::Array>(TEXT("cases")))
	{
		OutError = TEXT("TCP transport fixture requires a cases array");
		return false;
	}

	OutError.Reset();
	return true;
}

bool TryParseFixtureCase(
	const TSharedPtr<FJsonObject>& CaseObject,
	FTransportFixtureCase& OutCase,
	bool& bOutTargetsRequest,
	FString& OutError,
	EFixtureSchemaError* OutErrorCode = nullptr)
{
	if (OutErrorCode != nullptr)
	{
		*OutErrorCode = EFixtureSchemaError::None;
	}
	auto Fail = [&OutError, OutErrorCode](EFixtureSchemaError ErrorCode, FString Error)
	{
		if (OutErrorCode != nullptr)
		{
			*OutErrorCode = ErrorCode;
		}
		OutError = MoveTemp(Error);
		return false;
	};

	if (!CaseObject.IsValid() || !CaseObject->HasTypedField<EJson::String>(TEXT("id")))
	{
		return Fail(EFixtureSchemaError::Id, TEXT("TCP transport fixture case is missing a string id"));
	}

	FTransportFixtureCase Parsed;
	Parsed.Id = CaseObject->GetStringField(TEXT("id"));
	if (Parsed.Id.IsEmpty())
	{
		return Fail(EFixtureSchemaError::Id, TEXT("TCP transport fixture id is empty"));
	}

	if (!CaseObject->HasTypedField<EJson::Array>(TEXT("targets")))
	{
		return Fail(EFixtureSchemaError::Targets, FString::Printf(TEXT("%s: targets must be an array"), *Parsed.Id));
	}
	if (!HasOnlyAllowedTargets(CaseObject->GetArrayField(TEXT("targets")), bOutTargetsRequest))
	{
		return Fail(EFixtureSchemaError::Targets, FString::Printf(TEXT("%s: targets must be nonempty request/response strings"), *Parsed.Id));
	}

	const bool bHasAscii = CaseObject->HasField(TEXT("data_ascii"));
	const bool bHasBase64 = CaseObject->HasField(TEXT("data_base64"));
	if (bHasAscii == bHasBase64)
	{
		return Fail(EFixtureSchemaError::EncodingPresence, FString::Printf(TEXT("%s: exactly one data encoding is required"), *Parsed.Id));
	}
	if ((bHasAscii && !CaseObject->HasTypedField<EJson::String>(TEXT("data_ascii")))
		|| (bHasBase64 && !CaseObject->HasTypedField<EJson::String>(TEXT("data_base64"))))
	{
		return Fail(EFixtureSchemaError::EncodingType, FString::Printf(TEXT("%s: the present data encoding must be a string"), *Parsed.Id));
	}
	const bool bDecoded = bHasAscii
		? DecodeAscii(CaseObject->GetStringField(TEXT("data_ascii")), Parsed.Data)
		: DecodeCanonicalBase64(CaseObject->GetStringField(TEXT("data_base64")), Parsed.Data);
	if (!bDecoded || Parsed.Data.IsEmpty())
	{
		return Fail(EFixtureSchemaError::EncodedBytes, FString::Printf(TEXT("%s: encoded bytes are invalid or empty"), *Parsed.Id));
	}

	if (CaseObject->HasField(TEXT("all_split_points")))
	{
		if (!CaseObject->HasTypedField<EJson::Boolean>(TEXT("all_split_points")))
		{
			return Fail(EFixtureSchemaError::AllSplitPoints, FString::Printf(TEXT("%s: all_split_points must be boolean"), *Parsed.Id));
		}
		Parsed.bAllSplitPoints = CaseObject->GetBoolField(TEXT("all_split_points"));
	}

	if (CaseObject->HasField(TEXT("policy")))
	{
		if (!CaseObject->HasTypedField<EJson::Object>(TEXT("policy")))
		{
			return Fail(EFixtureSchemaError::PolicyType, FString::Printf(TEXT("%s: policy must be an object"), *Parsed.Id));
		}
		const TSharedPtr<FJsonObject> Policy = CaseObject->GetObjectField(TEXT("policy"));
		if (Policy->Values.IsEmpty())
		{
			return Fail(EFixtureSchemaError::PolicyShape, FString::Printf(TEXT("%s: policy must contain at least one supported limit"), *Parsed.Id));
		}
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Policy->Values)
		{
			if (Pair.Key != TEXT("max_header_bytes") && Pair.Key != TEXT("max_body_bytes"))
			{
				return Fail(EFixtureSchemaError::PolicyShape, FString::Printf(TEXT("%s: policy contains unsupported key %s"), *Parsed.Id, *Pair.Key));
			}
			if (!Pair.Value.IsValid() || Pair.Value->Type != EJson::Number)
			{
				return Fail(EFixtureSchemaError::PolicyValue, FString::Printf(TEXT("%s: policy limit %s must be numeric"), *Parsed.Id, *Pair.Key));
			}

			const double Value = Pair.Value->AsNumber();
			if (Pair.Key == TEXT("max_header_bytes"))
			{
				if (!IsWholePositiveInt32(Value))
				{
					return Fail(EFixtureSchemaError::PolicyValue, FString::Printf(TEXT("%s: max_header_bytes must be a positive JS-safe int32"), *Parsed.Id));
				}
				Parsed.Policy.MaxHeader = static_cast<int32>(Value);
			}
			else
			{
				if (!IsWholePositiveInt64(Value))
				{
					return Fail(EFixtureSchemaError::PolicyValue, FString::Printf(TEXT("%s: max_body_bytes must be a positive JS-safe int64"), *Parsed.Id));
				}
				Parsed.Policy.MaxBody = static_cast<int64>(Value);
			}
		}
	}

	if (!CaseObject->HasTypedField<EJson::Array>(TEXT("chunk_plans")))
	{
		return Fail(EFixtureSchemaError::ChunkPlans, FString::Printf(TEXT("%s: chunk_plans must be an array"), *Parsed.Id));
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
				|| !IsWholePositiveInt32(SizeValue->AsNumber()))
			{
				bChunkPlansValid = false;
				break;
			}
			const int32 ChunkSize = static_cast<int32>(SizeValue->AsNumber());
			if (PlanTotal > static_cast<int64>(Parsed.Data.Num()) - ChunkSize)
			{
				bChunkPlansValid = false;
				break;
			}
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
		return Fail(EFixtureSchemaError::ChunkPlans, FString::Printf(TEXT("%s: every chunk plan must contain positive integers totaling the input"), *Parsed.Id));
	}

	if (!CaseObject->HasTypedField<EJson::Object>(TEXT("expected")))
	{
		return Fail(EFixtureSchemaError::ExpectedShape, FString::Printf(TEXT("%s: expected must be an object"), *Parsed.Id));
	}
	const TSharedPtr<FJsonObject> Expected = CaseObject->GetObjectField(TEXT("expected"));
	FString StatusText;
	FString FramingText;
	if (!Expected->TryGetStringField(TEXT("status"), StatusText)
		|| !TryParseStatus(StatusText, Parsed.ExpectedStatus)
		|| !Expected->TryGetStringField(TEXT("framing"), FramingText)
		|| !TryParseFraming(FramingText, Parsed.ExpectedFraming))
	{
		return Fail(EFixtureSchemaError::StatusOrFraming, FString::Printf(TEXT("%s: expected status/framing is invalid"), *Parsed.Id));
	}

	if (Expected->HasField(TEXT("declared_body_length")))
	{
		if (!Expected->HasTypedField<EJson::Number>(TEXT("declared_body_length")))
		{
			return Fail(EFixtureSchemaError::DeclaredBodyLength, FString::Printf(TEXT("%s: declared_body_length must be numeric"), *Parsed.Id));
		}
		const double Value = Expected->GetNumberField(TEXT("declared_body_length"));
		if (!IsWholeNonNegativeInt64(Value))
		{
			return Fail(EFixtureSchemaError::DeclaredBodyLength, FString::Printf(TEXT("%s: declared_body_length must be a non-negative JS-safe integer"), *Parsed.Id));
		}
		Parsed.ExpectedDeclaredBodyLength = static_cast<int64>(Value);
	}

	const TSet<FString> AllowedReasons = {
		TEXT("invalid_header"), TEXT("header_too_large"), TEXT("invalid_content_length"),
		TEXT("content_length_overflow"), TEXT("body_too_large"), TEXT("trailing_bytes"),
		TEXT("invalid_utf8"), TEXT("invalid_bom"), TEXT("root_not_object"),
		TEXT("invalid_json"), TEXT("mismatched_delimiter")
	};
	const bool bRequiresReason = Parsed.ExpectedStatus == EMCPDecodeStatus::Malformed
		|| Parsed.ExpectedStatus == EMCPDecodeStatus::TooLarge;
	const bool bHasReason = Expected->HasField(TEXT("reason_code"));
	if (bHasReason && !Expected->HasTypedField<EJson::String>(TEXT("reason_code")))
	{
		return Fail(EFixtureSchemaError::ReasonCode, FString::Printf(TEXT("%s: reason_code must be a string when present"), *Parsed.Id));
	}
	if (bHasReason)
	{
		Parsed.ExpectedReason = Expected->GetStringField(TEXT("reason_code"));
	}
	if (bRequiresReason != bHasReason || (bHasReason && !AllowedReasons.Contains(Parsed.ExpectedReason)))
	{
		return Fail(EFixtureSchemaError::ReasonCode, FString::Printf(TEXT("%s: terminal reason_code does not match the fixture schema"), *Parsed.Id));
	}

	if (Parsed.ExpectedStatus == EMCPDecodeStatus::Complete)
	{
		if (!Expected->HasTypedField<EJson::Object>(TEXT("json")))
		{
			return Fail(EFixtureSchemaError::ExpectedJson, FString::Printf(TEXT("%s: complete cases require an object json field"), *Parsed.Id));
		}
		Parsed.ExpectedObject = Expected->GetObjectField(TEXT("json"));
	}
	else if (Expected->HasField(TEXT("json")))
	{
		return Fail(EFixtureSchemaError::ExpectedJson, FString::Printf(TEXT("%s: non-complete cases must omit json"), *Parsed.Id));
	}

	OutCase = MoveTemp(Parsed);
	OutError.Reset();
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

	FString RootError;
	if (!TryValidateFixtureRoot(Root, RootError))
	{
		Test.AddError(RootError);
		return false;
	}

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
		FTransportFixtureCase Parsed;
		bool bTargetsRequest = false;
		FString ParseError;
		if (!TryParseFixtureCase(CaseObject, Parsed, bTargetsRequest, ParseError))
		{
			Test.AddError(ParseError);
			continue;
		}
		if (SeenIds.Contains(Parsed.Id))
		{
			Test.AddError(FString::Printf(TEXT("TCP transport fixture id is duplicated: %s"), *Parsed.Id));
			continue;
		}
		SeenIds.Add(Parsed.Id);

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

void SetChunkPlan(FJsonObject& CaseObject, const TArray<double>& ChunkLengths)
{
	TArray<TSharedPtr<FJsonValue>> Plan;
	for (const double ChunkLength : ChunkLengths)
	{
		Plan.Add(MakeShared<FJsonValueNumber>(ChunkLength));
	}
	TArray<TSharedPtr<FJsonValue>> Plans;
	Plans.Add(MakeShared<FJsonValueArray>(MoveTemp(Plan)));
	CaseObject.SetArrayField(TEXT("chunk_plans"), MoveTemp(Plans));
}

void SetSingleChunkPlan(FJsonObject& CaseObject, double ChunkLength)
{
	SetChunkPlan(CaseObject, {ChunkLength});
}

TSharedPtr<FJsonObject> MakeValidFixtureSchemaCase()
{
	TSharedPtr<FJsonObject> CaseObject = MakeShared<FJsonObject>();
	CaseObject->SetStringField(TEXT("id"), TEXT("fixture-schema-self-test"));
	CaseObject->SetArrayField(TEXT("targets"), {MakeShared<FJsonValueString>(TEXT("request"))});
	CaseObject->SetStringField(TEXT("data_ascii"), TEXT("{}"));
	SetSingleChunkPlan(*CaseObject, 2.0);

	TSharedPtr<FJsonObject> Expected = MakeShared<FJsonObject>();
	Expected->SetStringField(TEXT("status"), TEXT("complete"));
	Expected->SetStringField(TEXT("framing"), TEXT("legacy"));
	Expected->SetObjectField(TEXT("json"), MakeShared<FJsonObject>());
	CaseObject->SetObjectField(TEXT("expected"), MoveTemp(Expected));
	return CaseObject;
}

void AssertFixtureCaseRejected(
	FAutomationTestBase& Test,
	const TCHAR* Name,
	EFixtureSchemaError ExpectedErrorCode,
	int32& RejectionCount,
	TFunctionRef<void(FJsonObject&)> Mutate)
{
	++RejectionCount;
	TSharedPtr<FJsonObject> CaseObject = MakeValidFixtureSchemaCase();
	Mutate(*CaseObject);
	FTransportFixtureCase Parsed;
	bool bTargetsRequest = false;
	FString Error;
	EFixtureSchemaError ErrorCode = EFixtureSchemaError::None;
	const bool bAccepted = TryParseFixtureCase(CaseObject, Parsed, bTargetsRequest, Error, &ErrorCode);
	Test.TestFalse(Name, bAccepted);
	Test.TestFalse(*FString::Printf(TEXT("%s reports a schema error"), Name), Error.IsEmpty());
	Test.TestTrue(*FString::Printf(TEXT("%s reports the intended schema error category"), Name),
		ErrorCode == ExpectedErrorCode);
}

void AssertFixtureCaseAccepted(
	FAutomationTestBase& Test,
	const TCHAR* Name,
	int32& AcceptanceCount,
	TFunctionRef<void(FJsonObject&)> Mutate)
{
	++AcceptanceCount;
	TSharedPtr<FJsonObject> CaseObject = MakeValidFixtureSchemaCase();
	Mutate(*CaseObject);
	FTransportFixtureCase Parsed;
	bool bTargetsRequest = false;
	FString Error;
	EFixtureSchemaError ErrorCode = EFixtureSchemaError::None;
	Test.TestTrue(Name, TryParseFixtureCase(CaseObject, Parsed, bTargetsRequest, Error, &ErrorCode));
	Test.TestTrue(*FString::Printf(TEXT("%s targets requests"), Name), bTargetsRequest);
	Test.TestTrue(*FString::Printf(TEXT("%s has no schema error"), Name), Error.IsEmpty());
	Test.TestTrue(*FString::Printf(TEXT("%s has no schema error category"), Name),
		ErrorCode == EFixtureSchemaError::None);
}

TArray<uint8> MakeDeepNestedJsonBody(int32 Depth)
{
	FString Json;
	Json.Reserve(Depth * 6 + 16);
	Json += TEXT("{\"root\":");
	for (int32 Index = 0; Index < Depth; ++Index)
	{
		Json += Index % 2 == 0 ? TEXT("{\"v\":") : TEXT("[");
	}
	Json += TEXT("0");
	for (int32 Index = Depth - 1; Index >= 0; --Index)
	{
		Json += Index % 2 == 0 ? TEXT("}") : TEXT("]");
	}
	Json += TEXT("}");
	return MakeAsciiBytes(Json);
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

void AssertCompleteNonFiniteJsonRejected(
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
		Test.TestTrue(*FString::Printf(TEXT("%s rejects complete non-finite JSON number"), *Label),
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
	FUEMCPReceiveDeadlineTest,
	"UEMCP.Transport.ReceiveDeadlines",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPReceiveDeadlineTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;

	auto TestDecision = [this](
		const TCHAR* Description,
		double AcceptedAtSeconds,
		double LastPositiveByteAtSeconds,
		double NowSeconds,
		EMCPReceiveDeadline ExpectedDeadline,
		double ExpectedWaitSeconds)
	{
		const FMCPReceiveWaitDecision Decision = EvaluateReceiveDeadlines(
			AcceptedAtSeconds,
			LastPositiveByteAtSeconds,
			NowSeconds);
		TestTrue(*FString::Printf(TEXT("%s deadline"), Description),
			Decision.Deadline == ExpectedDeadline);
		TestTrue(*FString::Printf(TEXT("%s wait"), Description),
			FMath::IsNearlyEqual(Decision.WaitSeconds, ExpectedWaitSeconds, 1.e-9));
	};

	TestDecision(TEXT("accept initializes idle and wait is capped at 50ms"),
		100.0, 100.0, 100.0, EMCPReceiveDeadline::None, 0.05);
	TestDecision(TEXT("zero-byte and retry attempts leave idle anchored at accept"),
		100.0, 100.0, 101.999, EMCPReceiveDeadline::None, 0.001);
	TestDecision(TEXT("idle expires exactly two seconds after accept without positive bytes"),
		100.0, 100.0, 102.0, EMCPReceiveDeadline::IdleTimeout, 0.0);
	TestDecision(TEXT("positive bytes reset only the idle deadline"),
		100.0, 101.75, 102.0, EMCPReceiveDeadline::None, 0.05);
	TestDecision(TEXT("idle remainder below 50ms owns the wait"),
		100.0, 101.0, 102.975, EMCPReceiveDeadline::None, 0.025);
	TestDecision(TEXT("total remainder below idle and 50ms owns the wait"),
		100.0, 109.0, 109.98, EMCPReceiveDeadline::None, 0.02);
	TestDecision(TEXT("positive progress never resets the total deadline"),
		100.0, 109.999, 110.0, EMCPReceiveDeadline::TotalTimeout, 0.0);
	TestDecision(TEXT("total timeout wins when idle and total expire together"),
		100.0, 108.0, 110.0, EMCPReceiveDeadline::TotalTimeout, 0.0);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPReadOneRequestStoppingTest,
	"UEMCP.Transport.ReadOneRequestStopping",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPReadOneRequestStoppingTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;

	const FMCPRequestReadResult Result = ReadOneRequest(nullptr, 100.0, [] { return false; });
	TestTrue(TEXT("server stop wins before null socket validation"),
		Result.Outcome == EMCPRequestReadOutcome::ServerStopping);
	TestEqual(TEXT("quiet stop consumes no request bytes"), Result.BytesReceived, int64{0});
	TestEqual(TEXT("quiet stop retains no reason code"), Result.ReasonCode, FString());
	TestTrue(TEXT("quiet stop retains no request object"), !Result.Object.IsValid());

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPRequestReadResultMappingTest,
	"UEMCP.Transport.RequestReadResultMapping",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPRequestReadResultMappingTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;

	const TSharedPtr<FJsonObject> CompletedObject = MakeShared<FJsonObject>();
	CompletedObject->SetStringField(TEXT("type"), TEXT("payload_must_not_escape"));

	FMCPDecodeSnapshot CompletedSnapshot;
	CompletedSnapshot.Status = EMCPDecodeStatus::Complete;
	CompletedSnapshot.Framing = EMCPFramingMode::Framed;
	CompletedSnapshot.Object = CompletedObject;
	CompletedSnapshot.BytesReceived = 73;
	CompletedSnapshot.DeclaredBodyLength = 51;

	const FMCPRequestReadResult StoppingResult = BuildRequestReadResult(
		EMCPRequestReadOutcome::ServerStopping,
		CompletedSnapshot,
		12.5);
	TestTrue(TEXT("post-receive server stop wins over a completed decoder snapshot"),
		StoppingResult.Outcome == EMCPRequestReadOutcome::ServerStopping);
	TestFalse(TEXT("post-receive server stop carries no payload object"),
		StoppingResult.Object.IsValid());
	TestTrue(TEXT("post-receive server stop carries no reason text"),
		StoppingResult.ReasonCode.IsEmpty());
	TestTrue(TEXT("post-receive server stop carries no socket error"),
		StoppingResult.SocketError == SE_NO_ERROR);
	TestTrue(TEXT("completed decoder snapshot remains valid after stop mapping"),
		CompletedSnapshot.Object == CompletedObject && CompletedObject.IsValid());
	TestEqual(TEXT("post-receive server stop retains only framing metadata"),
		StoppingResult.Framing, EMCPFramingMode::Framed);
	TestEqual(TEXT("post-receive server stop retains only byte-count metadata"),
		StoppingResult.BytesReceived, int64{73});
	TestEqual(TEXT("post-receive server stop retains only declared-length metadata"),
		StoppingResult.DeclaredBodyLength, int64{51});
	TestTrue(TEXT("post-receive server stop retains elapsed metadata"),
		FMath::IsNearlyEqual(StoppingResult.ElapsedMs, 12.5, 1.e-9));

	const EMCPRequestReadOutcome NonCompleteOutcomes[] = {
		EMCPRequestReadOutcome::Malformed,
		EMCPRequestReadOutcome::TooLarge,
		EMCPRequestReadOutcome::IdleTimeout,
		EMCPRequestReadOutcome::TotalTimeout,
		EMCPRequestReadOutcome::PeerClosed,
		EMCPRequestReadOutcome::SocketError,
		EMCPRequestReadOutcome::ServerStopping
	};
	for (const EMCPRequestReadOutcome Outcome : NonCompleteOutcomes)
	{
		const FMCPRequestReadResult Result = BuildRequestReadResult(
			Outcome,
			CompletedSnapshot,
			3.0);
		TestTrue(
			*FString::Printf(TEXT("non-complete outcome %d carries no payload object"), static_cast<int32>(Outcome)),
			!Result.Object.IsValid());
	}

	const FMCPRequestReadResult CompleteResult = BuildRequestReadResult(
		EMCPRequestReadOutcome::Complete,
		CompletedSnapshot,
		7.0);
	TestTrue(TEXT("complete outcome retains the decoded request object"),
		CompleteResult.Object == CompletedObject && CompleteResult.Object.IsValid());
	TestEqual(TEXT("complete outcome retains elapsed metadata"), CompleteResult.ElapsedMs, 7.0);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPTransportFixtureSchemaTest,
	"UEMCP.Transport.FixtureSchema",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPTransportFixtureSchemaTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport::Tests;

	int32 AcceptanceCount = 0;
	int32 RejectionCount = 0;
	int32 RootRejectionCount = 0;
	auto Accept = [this, &AcceptanceCount](
		const TCHAR* Name,
		TFunctionRef<void(FJsonObject&)> Mutate)
	{
		AssertFixtureCaseAccepted(*this, Name, AcceptanceCount, Mutate);
	};
	auto Reject = [this, &RejectionCount](
		const TCHAR* Name,
		EFixtureSchemaError ExpectedErrorCode,
		TFunctionRef<void(FJsonObject&)> Mutate)
	{
		AssertFixtureCaseRejected(*this, Name, ExpectedErrorCode, RejectionCount, Mutate);
	};

	Accept(TEXT("baseline fixture schema case is accepted"), [](FJsonObject&) {});
	Accept(TEXT("duplicate request targets are accepted"), [](FJsonObject& CaseObject)
	{
		CaseObject.SetArrayField(TEXT("targets"), {
			MakeShared<FJsonValueString>(TEXT("request")),
			MakeShared<FJsonValueString>(TEXT("request"))
		});
	});
	Accept(TEXT("canonical base64 encoding is accepted"), [](FJsonObject& CaseObject)
	{
		CaseObject.RemoveField(TEXT("data_ascii"));
		CaseObject.SetStringField(TEXT("data_base64"), TEXT("e30="));
	});
	Accept(TEXT("JS-safe max body above int32 is accepted"), [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_body_bytes"), 4294967296.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});

	Reject(TEXT("wrong-typed second encoding is rejected"), EFixtureSchemaError::EncodingPresence, [](FJsonObject& CaseObject)
	{
		CaseObject.SetNumberField(TEXT("data_base64"), 1.0);
	});
	Reject(TEXT("wrong-typed sole encoding is rejected"), EFixtureSchemaError::EncodingType, [](FJsonObject& CaseObject)
	{
		CaseObject.SetNumberField(TEXT("data_ascii"), 1.0);
	});
	Reject(TEXT("malformed base64 padding is rejected"), EFixtureSchemaError::EncodedBytes, [](FJsonObject& CaseObject)
	{
		CaseObject.RemoveField(TEXT("data_ascii"));
		CaseObject.SetStringField(TEXT("data_base64"), TEXT("ZA==="));
		SetSingleChunkPlan(CaseObject, 1.0);
	});
	Reject(TEXT("base64 whitespace is rejected"), EFixtureSchemaError::EncodedBytes, [](FJsonObject& CaseObject)
	{
		CaseObject.RemoveField(TEXT("data_ascii"));
		CaseObject.SetStringField(TEXT("data_base64"), TEXT("ZA== "));
		SetSingleChunkPlan(CaseObject, 1.0);
	});
	Reject(TEXT("noncanonical base64 pad bits are rejected"), EFixtureSchemaError::EncodedBytes, [](FJsonObject& CaseObject)
	{
		CaseObject.RemoveField(TEXT("data_ascii"));
		CaseObject.SetStringField(TEXT("data_base64"), TEXT("ZE=="));
		SetSingleChunkPlan(CaseObject, 1.0);
	});

	Reject(TEXT("empty policy is rejected"), EFixtureSchemaError::PolicyShape, [](FJsonObject& CaseObject)
	{
		CaseObject.SetObjectField(TEXT("policy"), MakeShared<FJsonObject>());
	});
	Reject(TEXT("wrong-typed policy object is rejected"), EFixtureSchemaError::PolicyType, [](FJsonObject& CaseObject)
	{
		CaseObject.SetStringField(TEXT("policy"), TEXT("default"));
	});
	Reject(TEXT("unknown-only policy is rejected"), EFixtureSchemaError::PolicyShape, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("unknown_limit"), 1.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("mixed unknown policy is rejected"), EFixtureSchemaError::PolicyShape, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_header_bytes"), 512.0);
		Policy->SetNumberField(TEXT("unknown_limit"), 1.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("wrong-typed policy field is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetStringField(TEXT("max_header_bytes"), TEXT("512"));
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("zero policy field is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_body_bytes"), 0.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("fractional policy field is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_header_bytes"), 1.5);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("unsafe policy field is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_body_bytes"), 9007199254740992.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("header policy outside int32 is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_header_bytes"), 2147483648.0);
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});
	Reject(TEXT("non-finite policy field is rejected"), EFixtureSchemaError::PolicyValue, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Policy = MakeShared<FJsonObject>();
		Policy->SetNumberField(TEXT("max_body_bytes"), std::numeric_limits<double>::infinity());
		CaseObject.SetObjectField(TEXT("policy"), MoveTemp(Policy));
	});

	Reject(TEXT("wrong-typed reason on complete is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetNumberField(TEXT("reason_code"), 1.0);
	});
	Reject(TEXT("string reason on complete is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetStringField(TEXT("reason_code"), TEXT("invalid_json"));
	});
	Reject(TEXT("wrong-typed reason on pending is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Expected = CaseObject.GetObjectField(TEXT("expected"));
		Expected->SetStringField(TEXT("status"), TEXT("pending"));
		Expected->RemoveField(TEXT("json"));
		Expected->SetNumberField(TEXT("reason_code"), 1.0);
	});
	Reject(TEXT("string reason on pending is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Expected = CaseObject.GetObjectField(TEXT("expected"));
		Expected->SetStringField(TEXT("status"), TEXT("pending"));
		Expected->RemoveField(TEXT("json"));
		Expected->SetStringField(TEXT("reason_code"), TEXT("invalid_json"));
	});
	Reject(TEXT("terminal status without reason is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Expected = CaseObject.GetObjectField(TEXT("expected"));
		Expected->SetStringField(TEXT("status"), TEXT("malformed"));
		Expected->RemoveField(TEXT("json"));
	});
	Reject(TEXT("wrong-typed terminal reason is rejected"), EFixtureSchemaError::ReasonCode, [](FJsonObject& CaseObject)
	{
		TSharedPtr<FJsonObject> Expected = CaseObject.GetObjectField(TEXT("expected"));
		Expected->SetStringField(TEXT("status"), TEXT("malformed"));
		Expected->RemoveField(TEXT("json"));
		Expected->SetNumberField(TEXT("reason_code"), 1.0);
	});

	Reject(TEXT("fractional chunk length is rejected"), EFixtureSchemaError::ChunkPlans, [](FJsonObject& CaseObject)
	{
		SetChunkPlan(CaseObject, {1.5, 1.0});
	});
	Reject(TEXT("unsafe chunk length is rejected"), EFixtureSchemaError::ChunkPlans, [](FJsonObject& CaseObject)
	{
		SetSingleChunkPlan(CaseObject, 9007199254740992.0);
	});
	Reject(TEXT("wrong-typed all_split_points is rejected"), EFixtureSchemaError::AllSplitPoints, [](FJsonObject& CaseObject)
	{
		CaseObject.SetStringField(TEXT("all_split_points"), TEXT("true"));
	});
	Reject(TEXT("wrong-typed declared length is rejected"), EFixtureSchemaError::DeclaredBodyLength, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetStringField(TEXT("declared_body_length"), TEXT("2"));
	});
	Reject(TEXT("wrong-typed complete json is rejected"), EFixtureSchemaError::ExpectedJson, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetStringField(TEXT("json"), TEXT("{}"));
	});
	Reject(TEXT("fractional declared length is rejected"), EFixtureSchemaError::DeclaredBodyLength, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetNumberField(TEXT("declared_body_length"), 1.5);
	});
	Reject(TEXT("unsafe declared length is rejected"), EFixtureSchemaError::DeclaredBodyLength, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetNumberField(TEXT("declared_body_length"), 9007199254740992.0);
	});
	Reject(TEXT("int64 rounding hazard is rejected"), EFixtureSchemaError::DeclaredBodyLength, [](FJsonObject& CaseObject)
	{
		CaseObject.GetObjectField(TEXT("expected"))->SetNumberField(TEXT("declared_body_length"), 9223372036854775808.0);
	});

	auto AssertRootRejected = [this, &RootRejectionCount](const TCHAR* Name, double Version)
	{
		++RootRejectionCount;
		TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetNumberField(TEXT("version"), Version);
		Root->SetArrayField(TEXT("cases"), {});
		FString Error;
		TestFalse(Name, TryValidateFixtureRoot(Root, Error));
		TestFalse(*FString::Printf(TEXT("%s reports a schema error"), Name), Error.IsEmpty());
	};
	AssertRootRejected(TEXT("fractional fixture version is rejected"), 1.5);
	AssertRootRejected(TEXT("unsafe fixture version is rejected"), 9007199254740992.0);
	AssertRootRejected(TEXT("non-finite fixture version is rejected"), std::numeric_limits<double>::infinity());

	TestEqual(TEXT("fixture schema executes the exact negative mutation count"), RejectionCount, 29);
	TestEqual(TEXT("fixture schema executes the exact positive control count"), AcceptanceCount, 4);
	TestEqual(TEXT("fixture schema executes the exact root numeric rejection count"), RootRejectionCount, 3);
	AddInfo(FString::Printf(TEXT("fixture_schema_negative_cases=%d fixture_schema_positive_cases=%d root_numeric_negative_cases=%d"),
		RejectionCount, AcceptanceCount, RootRejectionCount));
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
		struct FNonFiniteJsonCase
		{
			const TCHAR* Name;
			TArray<uint8> Body;
		};
		const TArray<FNonFiniteJsonCase> NonFiniteCases = {
			{TEXT("mixedcase-NaN"), MakeAsciiBytes(TEXT("{\"x\":NaN}"))},
			{TEXT("non-finite-number-magnitude"), MakeAsciiBytes(TEXT("{\"x\":1e400}"))}
		};
		for (const FNonFiniteJsonCase& NonFiniteCase : NonFiniteCases)
		{
			AssertCompleteNonFiniteJsonRejected(*this, NonFiniteCase.Name, NonFiniteCase.Body);
		}
	}

#if PLATFORM_WINDOWS
	{
		struct FSurrogateEscapeCase
		{
			const TCHAR* Name;
			const TCHAR* Body;
			TArray<uint16> ExpectedCodeUnits;
		};
		const TArray<FSurrogateEscapeCase> EscapeCases = {
			{TEXT("paired-surrogate-escape"), TEXT("{\"x\":\"\\uD83D\\uDE00\"}"), {0xd83d, 0xde00}},
			{TEXT("lone-surrogate-escape"), TEXT("{\"x\":\"\\uD800\"}"), {0xd800}}
		};
		for (const FSurrogateEscapeCase& EscapeCase : EscapeCases)
		{
			const TArray<uint8> Body = MakeAsciiBytes(EscapeCase.Body);
			for (const bool bFramed : {false, true})
			{
				TArray<uint8> Request;
				if (bFramed)
				{
					Request = MakeFramingHeader(Body.Num());
				}
				Request.Append(Body);
				const FString Label = FString::Printf(TEXT("%s/%s"), EscapeCase.Name,
					bFramed ? TEXT("framed") : TEXT("legacy"));

				TSharedPtr<FJsonObject> RetainedObject;
				int32 ParseCount = 0;
				{
					FMCPRequestDecoder Decoder;
					const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
					TestTrue(*FString::Printf(TEXT("%s completes with an object"), *Label),
						Snapshot.Status == EMCPDecodeStatus::Complete && Snapshot.Object.IsValid());
					RetainedObject = Snapshot.Object;
					ParseCount = Decoder.GetJsonParseCountForTests();
				}
				TestEqual(*FString::Printf(TEXT("%s parses exactly once"), *Label), ParseCount, 1);
				TestTrue(*FString::Printf(TEXT("%s object survives decoder destruction"), *Label),
					RetainedObject.IsValid());
				if (RetainedObject.IsValid())
				{
					const FString Value = RetainedObject->GetStringField(TEXT("x"));
					TestEqual(*FString::Printf(TEXT("%s TCHAR length"), *Label),
						Value.Len(), EscapeCase.ExpectedCodeUnits.Num());
					for (int32 Index = 0; Index < FMath::Min(Value.Len(), EscapeCase.ExpectedCodeUnits.Num()); ++Index)
					{
						TestEqual(*FString::Printf(TEXT("%s TCHAR code unit %d"), *Label, Index),
							static_cast<uint16>(Value[Index]), EscapeCase.ExpectedCodeUnits[Index]);
					}
				}
				RetainedObject.Reset();
				TestFalse(*FString::Printf(TEXT("%s retained object releases cleanly"), *Label),
					RetainedObject.IsValid());
			}
		}
	}
#endif

	{
		constexpr int32 DeepJsonDepth = 5000;
		const TArray<uint8> Body = MakeDeepNestedJsonBody(DeepJsonDepth);
		TSharedPtr<FJsonObject> RetainedObject;
		int32 ParseCount = 0;
		{
			FMCPRequestDecoder Decoder;
			const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Body.GetData(), Body.Num());
			TestTrue(TEXT("depth-5000 alternating object/array JSON completes"),
				Snapshot.Status == EMCPDecodeStatus::Complete && Snapshot.Object.IsValid());
			RetainedObject = Snapshot.Object;
			ParseCount = Decoder.GetJsonParseCountForTests();
		}
		TestEqual(TEXT("depth-5000 JSON parses exactly once"), ParseCount, 1);
		TestTrue(TEXT("depth-5000 JSON object survives decoder destruction"), RetainedObject.IsValid());
		RetainedObject.Reset();
		TestFalse(TEXT("depth-5000 JSON object graph releases cleanly"), RetainedObject.IsValid());
		AddInfo(FString::Printf(TEXT("deep_json_depth=%d deep_json_bytes=%d"), DeepJsonDepth, Body.Num()));
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
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 9\r\n\r\n{\"x\":tru}"));
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
		TArray<uint8> Request = MakeAsciiBytes(TEXT("Content-Length: 3\r\n\r\ntru"));
		const FMCPDecodeSnapshot& Snapshot = Decoder.Consume(Request.GetData(), Request.Num());
		TestTrue(TEXT("malformed framed scalar-like text is rejected as invalid_json"),
			Snapshot.Status == EMCPDecodeStatus::Malformed && Snapshot.ReasonCode == TEXT("invalid_json"));
		TestEqual(TEXT("malformed framed scalar-like text parses exactly once"),
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
