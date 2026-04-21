// Copyright Optimum Athena. All Rights Reserved.
//
// Automation tests for M1 P0 helpers (P0-1, P0-2, P0-3, P0-4, P0-10).
// P0-9 (null-params dispatcher check) is tested in MCPCommandRegistry tests.
//
// Run headless: UnrealEditor-Cmd.exe <project.uproject> -run=RunTests -testfilter=UEMCP.
// Run in editor: Tools -> Session Frontend -> Automation -> filter "UEMCP."

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

#include "MCPResponseBuilder.h"
#include "TransformParser.h"
#include "ActorLookupHelper.h"
#include "PropertyHandlerRegistry.h"
#include "UEMCPTestObject.h"

// =====================================================================================
// P0-1: MCPResponseBuilder
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPResponseBuilderSuccessTest,
	"UEMCP.MCPResponseBuilder.BuildSuccess",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPResponseBuilderSuccessTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FJsonObject> Response;
	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetStringField(TEXT("message"), TEXT("pong"));

	UEMCP::BuildSuccessResponse(Response, Data);

	TestTrue(TEXT("Response allocated"), Response.IsValid());
	TestEqual(TEXT("status field"), Response->GetStringField(TEXT("status")), FString(TEXT("success")));
	TestTrue(TEXT("result object present"), Response->HasTypedField<EJson::Object>(TEXT("result")));

	const TSharedPtr<FJsonObject>& Result = Response->GetObjectField(TEXT("result"));
	TestEqual(TEXT("nested result field"), Result->GetStringField(TEXT("message")), FString(TEXT("pong")));

	// Serialization round-trip sanity.
	const FString Serialized = UEMCP::SerializeResponse(Response);
	TestTrue(TEXT("serialized contains status"), Serialized.Contains(TEXT("\"status\":\"success\"")));
	TestTrue(TEXT("serialized contains nested message"), Serialized.Contains(TEXT("\"message\":\"pong\"")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPResponseBuilderErrorTest,
	"UEMCP.MCPResponseBuilder.BuildError",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPResponseBuilderErrorTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FJsonObject> Response;
	UEMCP::BuildErrorResponse(Response, TEXT("boom"), TEXT("INVALID_TRANSFORM"));

	TestTrue(TEXT("Response allocated"), Response.IsValid());
	TestEqual(TEXT("status"), Response->GetStringField(TEXT("status")), FString(TEXT("error")));
	TestEqual(TEXT("error field"), Response->GetStringField(TEXT("error")), FString(TEXT("boom")));
	TestEqual(TEXT("code field"), Response->GetStringField(TEXT("code")), FString(TEXT("INVALID_TRANSFORM")));
	TestFalse(TEXT("result absent on error"), Response->HasField(TEXT("result")));

	// Empty code defaults to "ERROR" so the field is always present.
	TSharedPtr<FJsonObject> GenericError;
	UEMCP::BuildErrorResponse(GenericError, TEXT("whoops"));
	TestEqual(TEXT("default code"), GenericError->GetStringField(TEXT("code")), FString(TEXT("ERROR")));

	return true;
}

// =====================================================================================
// P0-10: TransformParser
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPTransformParserValidTest,
	"UEMCP.TransformParser.Valid",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPTransformParserValidTest::RunTest(const FString& Parameters)
{
	// Build {"location":[1,2,3],"rotation":[10,20,30],"scale":[2,2,2]}
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();

	auto MakeArray = [](double A, double B, double C)
	{
		TArray<TSharedPtr<FJsonValue>> Arr;
		Arr.Add(MakeShared<FJsonValueNumber>(A));
		Arr.Add(MakeShared<FJsonValueNumber>(B));
		Arr.Add(MakeShared<FJsonValueNumber>(C));
		return Arr;
	};

	Params->SetArrayField(TEXT("location"), MakeArray(1.0, 2.0, 3.0));
	Params->SetArrayField(TEXT("rotation"), MakeArray(10.0, 20.0, 30.0));
	Params->SetArrayField(TEXT("scale"),    MakeArray(2.0, 2.0, 2.0));

	FTransform Out;
	FString Error;
	const bool bOk = UEMCP::BuildTransformFromJson(Params, Out, Error);

	TestTrue(TEXT("parse succeeded"), bOk);
	TestTrue(TEXT("no error on success"), Error.IsEmpty());
	TestTrue(TEXT("location"), Out.GetLocation().Equals(FVector(1, 2, 3)));
	TestTrue(TEXT("rotation (pitch,yaw,roll)"), Out.GetRotation().Rotator().Equals(FRotator(10, 20, 30), 0.01f));
	TestTrue(TEXT("scale"), Out.GetScale3D().Equals(FVector(2, 2, 2)));

	// Missing fields -> identity defaults.
	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	FTransform Default;
	TestTrue(TEXT("empty params yields identity"), UEMCP::BuildTransformFromJson(Empty, Default, Error));
	TestTrue(TEXT("default location zero"), Default.GetLocation().IsZero());
	TestTrue(TEXT("default scale one"), Default.GetScale3D().Equals(FVector::OneVector));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPTransformParserInvalidTest,
	"UEMCP.TransformParser.Invalid",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPTransformParserInvalidTest::RunTest(const FString& Parameters)
{
	// Null params.
	FTransform Out;
	FString Error;
	TestFalse(TEXT("null params fails"), UEMCP::BuildTransformFromJson(nullptr, Out, Error));
	TestFalse(TEXT("error populated"), Error.IsEmpty());

	// Wrong element count.
	TSharedPtr<FJsonObject> BadLen = MakeShared<FJsonObject>();
	TArray<TSharedPtr<FJsonValue>> TwoElems;
	TwoElems.Add(MakeShared<FJsonValueNumber>(1.0));
	TwoElems.Add(MakeShared<FJsonValueNumber>(2.0));
	BadLen->SetArrayField(TEXT("location"), TwoElems);

	TestFalse(TEXT("2-element location fails"), UEMCP::BuildTransformFromJson(BadLen, Out, Error));
	TestTrue(TEXT("error mentions location"), Error.Contains(TEXT("location")));

	// Non-numeric element.
	TSharedPtr<FJsonObject> BadType = MakeShared<FJsonObject>();
	TArray<TSharedPtr<FJsonValue>> WithString;
	WithString.Add(MakeShared<FJsonValueNumber>(1.0));
	WithString.Add(MakeShared<FJsonValueString>(TEXT("not a number")));
	WithString.Add(MakeShared<FJsonValueNumber>(3.0));
	BadType->SetArrayField(TEXT("rotation"), WithString);

	TestFalse(TEXT("non-numeric element fails"), UEMCP::BuildTransformFromJson(BadType, Out, Error));
	TestTrue(TEXT("error mentions rotation"), Error.Contains(TEXT("rotation")));

	return true;
}

// =====================================================================================
// P0-2 + P0-3: ActorLookupHelper guards (integration-level coverage requires a test map)
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPActorLookupGuardsTest,
	"UEMCP.ActorLookupHelper.Guards",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPActorLookupGuardsTest::RunTest(const FString& Parameters)
{
	// Null world -> no crash, empty result.
	UEMCP::FActorLookupResult Null = UEMCP::FindActorInAllLevels(TEXT("Anything"), nullptr);
	TestNull(TEXT("null world yields null actor"), Null.Actor);
	TestEqual(TEXT("null world walked no levels"), Null.SearchedLevels.Num(), 0);

	// Empty name in a real (but null here) world -> early return.
	UEMCP::FActorLookupResult EmptyName = UEMCP::FindActorInAllLevels(TEXT(""), nullptr);
	TestNull(TEXT("empty name yields null actor"), EmptyName.Actor);

	// Integration coverage (populated world + sublevel with duplicate labels) is intentionally
	// deferred to manual smoke or to a M1-follow-on map-loading test — requires a fixture level.
	return true;
}

// =====================================================================================
// P0-4: PropertyHandlerRegistry
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPPropertyRegistryScalarsTest,
	"UEMCP.PropertyHandlerRegistry.Scalars",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPPropertyRegistryScalarsTest::RunTest(const FString& Parameters)
{
	UUEMCPTestObject* Obj = NewObject<UUEMCPTestObject>();
	TestNotNull(TEXT("test obj alloc"), Obj);

	FString Error;
	auto& Registry = UEMCP::FPropertyHandlerRegistry::Get();

	// Built-in scalar handlers must be registered after construction.
	TestTrue(TEXT("IntProperty registered"),    Registry.HasHandler(FName(TEXT("IntProperty"))));
	TestTrue(TEXT("FloatProperty registered"),  Registry.HasHandler(FName(TEXT("FloatProperty"))));
	TestTrue(TEXT("BoolProperty registered"),   Registry.HasHandler(FName(TEXT("BoolProperty"))));
	TestTrue(TEXT("StrProperty registered"),    Registry.HasHandler(FName(TEXT("StrProperty"))));
	TestTrue(TEXT("NameProperty registered"),   Registry.HasHandler(FName(TEXT("NameProperty"))));

	// --- Int ---
	FProperty* IntProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("IntValue"));
	TestNotNull(TEXT("IntValue property found"), IntProp);
	TestTrue(TEXT("set IntValue=42"),
		Registry.Handle(Obj, IntProp, MakeShared<FJsonValueNumber>(42.0), Error));
	TestEqual(TEXT("IntValue assigned"), Obj->IntValue, 42);

	// --- Float ---
	FProperty* FloatProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("FloatValue"));
	TestTrue(TEXT("set FloatValue=1.5"),
		Registry.Handle(Obj, FloatProp, MakeShared<FJsonValueNumber>(1.5), Error));
	TestEqual(TEXT("FloatValue assigned"), Obj->FloatValue, 1.5f);

	// --- Bool ---
	FProperty* BoolProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("BoolValue"));
	TestTrue(TEXT("set BoolValue=true"),
		Registry.Handle(Obj, BoolProp, MakeShared<FJsonValueBoolean>(true), Error));
	TestTrue(TEXT("BoolValue assigned"), Obj->BoolValue);

	// --- String ---
	FProperty* StrProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("StringValue"));
	TestTrue(TEXT("set StringValue"),
		Registry.Handle(Obj, StrProp, MakeShared<FJsonValueString>(TEXT("hello")), Error));
	TestEqual(TEXT("StringValue assigned"), Obj->StringValue, FString(TEXT("hello")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPPropertyRegistryInvalidTest,
	"UEMCP.PropertyHandlerRegistry.Invalid",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPPropertyRegistryInvalidTest::RunTest(const FString& Parameters)
{
	UUEMCPTestObject* Obj = NewObject<UUEMCPTestObject>();
	auto& Registry = UEMCP::FPropertyHandlerRegistry::Get();
	FString Error;

	// Null container.
	FProperty* IntProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("IntValue"));
	TestFalse(TEXT("null container fails"),
		Registry.Handle(nullptr, IntProp, MakeShared<FJsonValueNumber>(1.0), Error));

	// Null property.
	TestFalse(TEXT("null property fails"),
		Registry.Handle(Obj, nullptr, MakeShared<FJsonValueNumber>(1.0), Error));

	// Null value.
	TestFalse(TEXT("null value fails"),
		Registry.Handle(Obj, IntProp, nullptr, Error));

	// Type mismatch (string JSON for int property).
	TestFalse(TEXT("string-for-int fails"),
		Registry.Handle(Obj, IntProp, MakeShared<FJsonValueString>(TEXT("not a number")), Error));
	TestTrue(TEXT("error populated on type mismatch"), !Error.IsEmpty());

	// Unregistered property type: register a stub that's different, then try an unhandled class name.
	// StructProperty is intentionally unregistered in M1.
	FProperty* StringProp = FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), TEXT("StringValue"));
	TestNotNull(TEXT("string prop found"), StringProp);
	// We can't easily fabricate an FStructProperty here without a real struct, so we verify the
	// negative case via a registry lookup:
	TestFalse(TEXT("StructProperty unregistered in M1"),
		Registry.HasHandler(FName(TEXT("StructProperty"))));

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
