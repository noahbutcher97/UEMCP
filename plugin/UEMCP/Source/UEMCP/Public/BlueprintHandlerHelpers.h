// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"

class FProperty;
class UObject;

/**
 * WS5a: the pure parts of BlueprintHandlers.cpp, lifted out of its anonymous
 * namespace so automation tests can reach them.
 *
 * Why a Public/ header and not a second anonymous namespace: this module builds
 * with bUseUnity = true, so a duplicate anonymous-namespace symbol is a link
 * error (D133 / D135 / D137), server/test-anon-namespace-audit.mjs blocks the
 * commit that reintroduces one, and a Public/ header is the only shape that
 * Private/Tests/*.cpp can include.
 *
 * Everything here is free of editor state: JSON and pin types in, JSON or an
 * FString out. The handlers keep the parts that need a live UEdGraphPin, a
 * UBlueprint, or a response envelope — including the TryApplyLiteralAssignment-
 * Default wrapper around FormatLiteralForPinCategory.
 *
 * Covered by Private/Tests/UEMCPBlueprintHelperTests.cpp (UEMCP.BlueprintHelpers.*).
 */
namespace UEMCP
{
	/** "input" for EGPD_Input, "output" for anything else. */
	FString PinDirectionToString(EEdGraphPinDirection Direction);

	/**
	 * {category, subcategory, container} for a pin type, plus subcategory_object
	 * when the type references one. container is UEdGraphSchema_K2::TypeToText,
	 * so it is display text and not a stable identifier.
	 */
	TSharedPtr<FJsonObject> PinTypeToJson(const FEdGraphPinType& PinType);

	/**
	 * The full pin row used in every BP-write response: pin_id, name, direction,
	 * category, subcategory, subcategory_object (when present), default,
	 * default_object (when present), link_count. Returns an empty object for a
	 * null pin rather than failing.
	 */
	TSharedPtr<FJsonObject> PinToJson(const UEdGraphPin* Pin);

	/**
	 * Writes one JSON value into a class-default-object property, for the
	 * variable kinds set_blueprint_variable_default supports: bool, int32,
	 * float, double, FString, and an FVector struct as [x,y,z]. Returns false
	 * with OutErrorMessage set for a null argument, a JSON type the property
	 * cannot take, a non-integral or out-of-range int32, a struct that is not
	 * FVector, or a property class with no branch here.
	 */
	bool SetSupportedVariableDefault(UObject* CDO, FProperty* Property,
		const TSharedPtr<FJsonValue>& Value, FString& OutErrorMessage);

	/**
	 * Renders a JSON literal as the string a pin's DefaultValue expects, for the
	 * categories literal assignment supports: int, float/real, boolean, string,
	 * and an FVector struct. Returns false with OutError and OutErrorCode set —
	 * MISSING_PARAMS for an invalid value, LITERAL_TYPE_MISMATCH when the JSON
	 * type does not match the category, UNSUPPORTED_LITERAL_TYPE for any other
	 * category. Takes the whole pin type because the struct branch reads
	 * PinSubCategoryObject; a category alone cannot tell FVector from FRotator.
	 */
	bool FormatLiteralForPinCategory(const FEdGraphPinType& PinType,
		const TSharedPtr<FJsonValue>& Value, FString& OutDefaultValue,
		FString& OutError, FString& OutErrorCode);
}
