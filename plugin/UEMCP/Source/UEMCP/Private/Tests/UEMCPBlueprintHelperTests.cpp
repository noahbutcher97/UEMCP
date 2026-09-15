// Copyright Noah Butcher. All Rights Reserved.
//
// WS5a unit tests for the pure helpers in Public/BlueprintHandlerHelpers.h.
// No Blueprint, no graph, no editor world: pin types are built by hand and
// property defaults are written onto a UUEMCPTestObject instance. The handler-
// level tests that need a real Blueprint live in UEMCPBlueprintHandlerTests.cpp.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "GameFramework/Actor.h"
#include "Misc/AutomationTest.h"

#include "BlueprintHandlerHelpers.h"
#include "UEMCPTestObject.h"

// Distinct from UEMCP::Blueprint::Tests in UEMCPBlueprintHandlerTests.cpp:
// Unity may bundle both files into one translation unit, and same-named
// helpers in one namespace would be a redefinition.
namespace UEMCP::Blueprint::HelperTests
{
	FEdGraphPinType MakePinType(FName Category, FName SubCategory = NAME_None, UObject* SubCategoryObject = nullptr)
	{
		FEdGraphPinType PinType;
		PinType.PinCategory = Category;
		PinType.PinSubCategory = SubCategory;
		PinType.PinSubCategoryObject = SubCategoryObject;
		return PinType;
	}

	TSharedPtr<FJsonValue> JsonNumber(double In) { return MakeShared<FJsonValueNumber>(In); }
	TSharedPtr<FJsonValue> JsonString(const FString& In) { return MakeShared<FJsonValueString>(In); }
	TSharedPtr<FJsonValue> JsonBool(bool In) { return MakeShared<FJsonValueBoolean>(In); }

	TSharedPtr<FJsonValue> JsonNumberArray(const TArray<double>& In)
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		for (const double Entry : In)
		{
			Values.Add(MakeShared<FJsonValueNumber>(Entry));
		}
		return MakeShared<FJsonValueArray>(Values);
	}

	/** [1, "two", 3] — reaches the "must contain only numbers" branch. */
	TSharedPtr<FJsonValue> JsonMixedArray()
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		Values.Add(MakeShared<FJsonValueNumber>(1.0));
		Values.Add(MakeShared<FJsonValueString>(TEXT("two")));
		Values.Add(MakeShared<FJsonValueNumber>(3.0));
		return MakeShared<FJsonValueArray>(Values);
	}

	FProperty* TestProperty(const TCHAR* Name)
	{
		return FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), Name);
	}
}

// =====================================================================================
// PinTypeToJson + PinDirectionToString — the pin-shape contract every BP-write
// response depends on.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersPinTypeToJsonTest,
	"UEMCP.BlueprintHelpers.PinTypeToJson",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersPinTypeToJsonTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	// Int pin: category and subcategory round-trip, container text is present,
	// subcategory_object is omitted rather than emitted empty.
	const TSharedPtr<FJsonObject> IntJson = UEMCP::PinTypeToJson(MakePinType(UEdGraphSchema_K2::PC_Int));
	TestTrue(TEXT("int json allocated"), IntJson.IsValid());
	TestEqual(TEXT("int category"), IntJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Int.ToString());
	TestEqual(TEXT("int subcategory is None"), IntJson->GetStringField(TEXT("subcategory")), FString(TEXT("None")));
	TestFalse(TEXT("int container text empty"), IntJson->GetStringField(TEXT("container")).IsEmpty());
	TestFalse(TEXT("int omits subcategory_object"), IntJson->HasField(TEXT("subcategory_object")));

	// Object pin: subcategory_object is the referenced class's name, not its path.
	const TSharedPtr<FJsonObject> ObjectJson = UEMCP::PinTypeToJson(
		MakePinType(UEdGraphSchema_K2::PC_Object, NAME_None, AActor::StaticClass()));
	TestEqual(TEXT("object category"), ObjectJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Object.ToString());
	TestEqual(TEXT("object subcategory_object"), ObjectJson->GetStringField(TEXT("subcategory_object")), FString(TEXT("Actor")));
	TestFalse(TEXT("object container text empty"), ObjectJson->GetStringField(TEXT("container")).IsEmpty());

	// Float pin carries a subcategory, so the field is not always None.
	const TSharedPtr<FJsonObject> FloatJson = UEMCP::PinTypeToJson(
		MakePinType(UEdGraphSchema_K2::PC_Real, UEdGraphSchema_K2::PC_Float));
	TestEqual(TEXT("float category"), FloatJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Real.ToString());
	TestEqual(TEXT("float subcategory"), FloatJson->GetStringField(TEXT("subcategory")), UEdGraphSchema_K2::PC_Float.ToString());

	// Direction mapping is the other half of the contract.
	TestEqual(TEXT("input direction"), UEMCP::PinDirectionToString(EGPD_Input), FString(TEXT("input")));
	TestEqual(TEXT("output direction"), UEMCP::PinDirectionToString(EGPD_Output), FString(TEXT("output")));

	return true;
}

// =====================================================================================
// SetSupportedVariableDefault — every supported property kind and every rejection.
// Note the JSON coercion rules this exercises: FJsonValueNumber::TryGetBool and
// ::TryGetString both succeed, so a number is NOT a type error for a bool or
// string property. Only arrays and objects fail TryGetBool / TryGetString, and
// only non-numeric strings fail TryGetNumber.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersVariableDefaultsTest,
	"UEMCP.BlueprintHelpers.VariableDefaults",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersVariableDefaultsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	UUEMCPTestObject* Obj = NewObject<UUEMCPTestObject>();
	if (!Obj)
	{
		AddError(TEXT("failed to allocate UUEMCPTestObject"));
		return false;
	}
	FString Error;

	// --- supported kinds write through to the object ---
	TestTrue(TEXT("bool accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("BoolValue")), JsonBool(true), Error));
	TestTrue(TEXT("bool written"), Obj->BoolValue);

	TestTrue(TEXT("int accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(7.0), Error));
	TestEqual(TEXT("int written"), Obj->IntValue, 7);

	TestTrue(TEXT("float accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("FloatValue")), JsonNumber(1.5), Error));
	TestEqual(TEXT("float written"), Obj->FloatValue, 1.5f);

	TestTrue(TEXT("double accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("DoubleValue")), JsonNumber(2.25), Error));
	TestEqual(TEXT("double written"), Obj->DoubleValue, 2.25);

	TestTrue(TEXT("string accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("StringValue")), JsonString(TEXT("hello")), Error));
	TestEqual(TEXT("string written"), Obj->StringValue, FString(TEXT("hello")));

	TestTrue(TEXT("vector accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumberArray({1.0, 2.0, 3.0}), Error));
	TestTrue(TEXT("vector written"), Obj->VectorValue.Equals(FVector(1.0, 2.0, 3.0)));

	// --- argument guards, asserted on the exact messages ---
	TestFalse(TEXT("null CDO rejected"),
		UEMCP::SetSupportedVariableDefault(nullptr, TestProperty(TEXT("IntValue")), JsonNumber(1.0), Error));
	TestEqual(TEXT("null CDO message"), Error, FString(TEXT("Invalid default object")));

	TestFalse(TEXT("null property rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, nullptr, JsonNumber(1.0), Error));
	TestEqual(TEXT("null property message"), Error, FString(TEXT("Variable property is null")));

	TestFalse(TEXT("missing value rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), nullptr, Error));
	TestEqual(TEXT("missing value message"), Error, FString(TEXT("Missing default value")));

	// --- per-kind type mismatches ---
	TestFalse(TEXT("bool rejects array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("BoolValue")), JsonNumberArray({1.0}), Error));
	TestTrue(TEXT("bool mismatch message"), Error.Contains(TEXT("BoolValue")) && Error.Contains(TEXT("boolean")));

	TestFalse(TEXT("int rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("int mismatch message"), Error.Contains(TEXT("IntValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("float rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("FloatValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("float mismatch message"), Error.Contains(TEXT("FloatValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("double rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("DoubleValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("double mismatch message"), Error.Contains(TEXT("DoubleValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("string rejects array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("StringValue")), JsonNumberArray({1.0}), Error));
	TestTrue(TEXT("string mismatch message"), Error.Contains(TEXT("StringValue")) && Error.Contains(TEXT("string")));

	// --- int32 range and integrality ---
	TestFalse(TEXT("int rejects fractional"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(1.5), Error));
	TestTrue(TEXT("fractional message"), Error.Contains(TEXT("integral int32")));

	TestFalse(TEXT("int rejects out-of-range"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(3000000000.0), Error));
	TestTrue(TEXT("out-of-range message"), Error.Contains(TEXT("integral int32")));
	TestEqual(TEXT("rejections left the property alone"), Obj->IntValue, 7);

	// --- struct branches ---
	TestFalse(TEXT("vector rejects non-array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumber(1.0), Error));
	TestTrue(TEXT("non-array message"), Error.Contains(TEXT("[x,y,z]")));

	TestFalse(TEXT("vector rejects wrong arity"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumberArray({1.0, 2.0}), Error));
	TestTrue(TEXT("arity message"), Error.Contains(TEXT("requires 3 values")) && Error.Contains(TEXT("got 2")));

	TestFalse(TEXT("vector rejects non-numeric element"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonMixedArray(), Error));
	TestTrue(TEXT("element message"), Error.Contains(TEXT("only numbers")));

	TestFalse(TEXT("non-Vector struct rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("RotatorValue")), JsonNumberArray({1.0, 2.0, 3.0}), Error));
	TestTrue(TEXT("unsupported struct message"),
		Error.Contains(TEXT("unsupported struct default type")) && Error.Contains(TEXT("Rotator")));

	// --- the tail: a property class with no branch at all (FNameProperty) ---
	TestFalse(TEXT("name property rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("NameValue")), JsonString(TEXT("Tag")), Error));
	TestTrue(TEXT("unsupported property message"),
		Error.Contains(TEXT("unsupported default property type")) && Error.Contains(TEXT("NameProperty")));

	return true;
}

// =====================================================================================
// FormatLiteralForPinCategory — the mapping behind add_blueprint_variable_assignment's
// literal kind. Unlike the property path above, these are strict EJson::Type checks,
// so a number is a type error for a boolean pin.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersLiteralDefaultsTest,
	"UEMCP.BlueprintHelpers.LiteralDefaults",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersLiteralDefaultsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	FString Default, Error, Code;

	// --- int: rounded, rendered by FString::FromInt ---
	TestTrue(TEXT("int literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), JsonNumber(4.6), Default, Error, Code));
	TestEqual(TEXT("int literal rounds"), Default, FString(TEXT("5")));

	TestFalse(TEXT("int literal rejects string"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), JsonString(TEXT("5")), Default, Error, Code));
	TestEqual(TEXT("int mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestEqual(TEXT("int mismatch message"), Error, FString(TEXT("Integer variable assignment requires a numeric literal")));

	// --- float and real share one branch; the formatter is SanitizeFloat ---
	TestTrue(TEXT("real literal accepted"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Real, UEdGraphSchema_K2::PC_Float), JsonNumber(2.5), Default, Error, Code));
	TestEqual(TEXT("real literal formatting"), Default, FString::SanitizeFloat(2.5));

	TestTrue(TEXT("float literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Float), JsonNumber(2.5), Default, Error, Code));
	TestEqual(TEXT("float literal formatting"), Default, FString::SanitizeFloat(2.5));

	TestFalse(TEXT("float literal rejects bool"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Float), JsonBool(true), Default, Error, Code));
	TestEqual(TEXT("float mismatch message"), Error, FString(TEXT("Float variable assignment requires a numeric literal")));

	// --- boolean ---
	TestTrue(TEXT("bool literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonBool(true), Default, Error, Code));
	TestEqual(TEXT("bool literal true"), Default, FString(TEXT("true")));
	TestTrue(TEXT("bool literal false accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonBool(false), Default, Error, Code));
	TestEqual(TEXT("bool literal false"), Default, FString(TEXT("false")));

	TestFalse(TEXT("bool literal rejects number"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("bool mismatch message"), Error, FString(TEXT("Boolean variable assignment requires a boolean literal")));

	// --- string ---
	TestTrue(TEXT("string literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_String), JsonString(TEXT("abc")), Default, Error, Code));
	TestEqual(TEXT("string literal verbatim"), Default, FString(TEXT("abc")));

	TestFalse(TEXT("string literal rejects number"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_String), JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("string mismatch message"), Error, FString(TEXT("String variable assignment requires a string literal")));

	// --- Vector struct: only when the sub-category object is FVector ---
	const FEdGraphPinType VectorPin = MakePinType(
		UEdGraphSchema_K2::PC_Struct, NAME_None, TBaseStructure<FVector>::Get());
	TestTrue(TEXT("vector literal accepted"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumberArray({1.0, 2.0, 3.0}), Default, Error, Code));
	TestEqual(TEXT("vector literal formatting"), Default, FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"), 1.0, 2.0, 3.0));

	TArray<TSharedPtr<FJsonValue>> Mixed;
	Mixed.Add(JsonNumber(1.0));
	Mixed.Add(JsonString(TEXT("a")));
	Mixed.Add(JsonNumber(3.0));
	TestFalse(TEXT("vector literal rejects a non-numeric element"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, MakeShared<FJsonValueArray>(Mixed), Default, Error, Code));
	TestEqual(TEXT("vector element mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestTrue(TEXT("vector element mismatch names the element"), Error.Contains(TEXT("element 1")));

	TestTrue(TEXT("vector literal shape"), Default.StartsWith(TEXT("(X=1.")) && Default.EndsWith(TEXT(")")));

	TestFalse(TEXT("vector literal rejects non-array"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("vector mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestEqual(TEXT("vector mismatch message"), Error, FString(TEXT("Vector variable assignment requires [x, y, z] numeric literal")));

	TestFalse(TEXT("vector literal rejects wrong arity"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumberArray({1.0, 2.0}), Default, Error, Code));
	TestEqual(TEXT("vector arity code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));

	// A struct pin that is not FVector falls through to the unsupported tail —
	// this is why the function takes the whole pin type, not just the category.
	TestFalse(TEXT("rotator struct pin unsupported"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Struct, NAME_None, TBaseStructure<FRotator>::Get()),
			JsonNumberArray({1.0, 2.0, 3.0}), Default, Error, Code));
	TestEqual(TEXT("rotator struct code"), Code, FString(TEXT("UNSUPPORTED_LITERAL_TYPE")));

	// --- unsupported category, and the missing-value guard ---
	TestFalse(TEXT("object pin unsupported"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Object, NAME_None, AActor::StaticClass()),
			JsonString(TEXT("x")), Default, Error, Code));
	TestEqual(TEXT("unsupported code"), Code, FString(TEXT("UNSUPPORTED_LITERAL_TYPE")));
	TestEqual(TEXT("unsupported message"), Error, FString(TEXT("Unsupported literal assignment pin type")));

	TestFalse(TEXT("invalid value rejected"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), nullptr, Default, Error, Code));
	TestEqual(TEXT("invalid value code"), Code, FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("invalid value message"), Error,
		FString(TEXT("Literal assignment requires a target value pin and value")));

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
