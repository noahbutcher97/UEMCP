// Copyright Noah Butcher. All Rights Reserved.
#include "BlueprintHandlerHelpers.h"

#include "EdGraphSchema_K2.h"
#include "K2Node_Event.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	FString PinDirectionToString(EEdGraphPinDirection Direction)
	{
		return Direction == EGPD_Input ? TEXT("input") : TEXT("output");
	}

	TSharedPtr<FJsonObject> PinTypeToJson(const FEdGraphPinType& PinType)
	{
		TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetStringField(TEXT("category"), PinType.PinCategory.ToString());
		Obj->SetStringField(TEXT("subcategory"), PinType.PinSubCategory.ToString());
		Obj->SetStringField(TEXT("container"), UEdGraphSchema_K2::TypeToText(PinType).ToString());
		if (PinType.PinSubCategoryObject.IsValid())
		{
			Obj->SetStringField(TEXT("subcategory_object"), PinType.PinSubCategoryObject->GetName());
		}
		return Obj;
	}

	TSharedPtr<FJsonObject> PinToJson(const UEdGraphPin* Pin)
	{
		TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
		if (!Pin) return Obj;
		Obj->SetStringField(TEXT("pin_id"), Pin->PinId.ToString());
		Obj->SetStringField(TEXT("name"), Pin->PinName.ToString());
		Obj->SetStringField(TEXT("direction"), PinDirectionToString(Pin->Direction));
		Obj->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
		Obj->SetStringField(TEXT("subcategory"), Pin->PinType.PinSubCategory.ToString());
		if (Pin->PinType.PinSubCategoryObject.IsValid())
		{
			Obj->SetStringField(TEXT("subcategory_object"), Pin->PinType.PinSubCategoryObject->GetName());
		}
		Obj->SetStringField(TEXT("default"), Pin->DefaultValue);
		if (Pin->DefaultObject)
		{
			Obj->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
		}
		Obj->SetNumberField(TEXT("link_count"), Pin->LinkedTo.Num());
		return Obj;
	}

	bool SetSupportedVariableDefault(UObject* CDO, FProperty* Property,
		const TSharedPtr<FJsonValue>& Value, FString& OutErrorMessage)
	{
		if (!CDO)
		{
			OutErrorMessage = TEXT("Invalid default object");
			return false;
		}
		if (!Property)
		{
			OutErrorMessage = TEXT("Variable property is null");
			return false;
		}
		if (!Value.IsValid())
		{
			OutErrorMessage = TEXT("Missing default value");
			return false;
		}

		if (FBoolProperty* BoolProp = CastField<FBoolProperty>(Property))
		{
			bool BoolValue = false;
			if (!Value->TryGetBool(BoolValue))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects a boolean default"), *Property->GetName());
				return false;
			}
			BoolProp->SetPropertyValue_InContainer(CDO, BoolValue);
			return true;
		}

		if (FIntProperty* IntProp = CastField<FIntProperty>(Property))
		{
			double NumberValue = 0.0;
			if (!Value->TryGetNumber(NumberValue))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects a numeric default"), *Property->GetName());
				return false;
			}
			const double RoundedValue = FMath::RoundToDouble(NumberValue);
			if (NumberValue != RoundedValue
				|| RoundedValue < static_cast<double>(TNumericLimits<int32>::Min())
				|| RoundedValue > static_cast<double>(TNumericLimits<int32>::Max()))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects an integral int32 default"), *Property->GetName());
				return false;
			}
			IntProp->SetPropertyValue_InContainer(CDO, static_cast<int32>(RoundedValue));
			return true;
		}

		if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Property))
		{
			double NumberValue = 0.0;
			if (!Value->TryGetNumber(NumberValue))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects a numeric default"), *Property->GetName());
				return false;
			}
			FloatProp->SetPropertyValue_InContainer(CDO, static_cast<float>(NumberValue));
			return true;
		}

		if (FDoubleProperty* DoubleProp = CastField<FDoubleProperty>(Property))
		{
			double NumberValue = 0.0;
			if (!Value->TryGetNumber(NumberValue))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects a numeric default"), *Property->GetName());
				return false;
			}
			DoubleProp->SetPropertyValue_InContainer(CDO, NumberValue);
			return true;
		}

		if (FStrProperty* StrProp = CastField<FStrProperty>(Property))
		{
			FString StringValue;
			if (!Value->TryGetString(StringValue))
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects a string default"), *Property->GetName());
				return false;
			}
			StrProp->SetPropertyValue_InContainer(CDO, StringValue);
			return true;
		}

		if (FStructProperty* StructProp = CastField<FStructProperty>(Property))
		{
			if (StructProp->Struct != TBaseStructure<FVector>::Get())
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' has unsupported struct default type '%s'"),
					*Property->GetName(),
					StructProp->Struct ? *StructProp->Struct->GetName() : TEXT("<null>"));
				return false;
			}

			if (Value->Type != EJson::Array)
			{
				OutErrorMessage = FString::Printf(TEXT("Variable '%s' expects Vector default as [x,y,z]"), *Property->GetName());
				return false;
			}

			const TArray<TSharedPtr<FJsonValue>>& Arr = Value->AsArray();
			if (Arr.Num() != 3)
			{
				OutErrorMessage = FString::Printf(TEXT("Vector default for variable '%s' requires 3 values, got %d"),
					*Property->GetName(), Arr.Num());
				return false;
			}

			double X = 0.0;
			double Y = 0.0;
			double Z = 0.0;
			if (!Arr[0].IsValid() || !Arr[0]->TryGetNumber(X)
				|| !Arr[1].IsValid() || !Arr[1]->TryGetNumber(Y)
				|| !Arr[2].IsValid() || !Arr[2]->TryGetNumber(Z))
			{
				OutErrorMessage = FString::Printf(TEXT("Vector default for variable '%s' must contain only numbers"),
					*Property->GetName());
				return false;
			}

			FVector Vec(X, Y, Z);
			StructProp->CopySingleValue(StructProp->ContainerPtrToValuePtr<void>(CDO), &Vec);
			return true;
		}

		OutErrorMessage = FString::Printf(TEXT("Variable '%s' has unsupported default property type '%s'"),
			*Property->GetName(), *Property->GetClass()->GetName());
		return false;
	}

	bool FormatLiteralForPinCategory(const FEdGraphPinType& PinType,
		const TSharedPtr<FJsonValue>& Value, FString& OutDefaultValue,
		FString& OutError, FString& OutErrorCode)
	{
		if (!Value.IsValid())
		{
			OutError = TEXT("Literal assignment requires a target value pin and value");
			OutErrorCode = TEXT("MISSING_PARAMS");
			return false;
		}

		const FName Category = PinType.PinCategory;
		if (Category == UEdGraphSchema_K2::PC_Int)
		{
			if (Value->Type != EJson::Number)
			{
				OutError = TEXT("Integer variable assignment requires a numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::FromInt(FMath::RoundToInt(Value->AsNumber()));
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Float || Category == UEdGraphSchema_K2::PC_Real)
		{
			if (Value->Type != EJson::Number)
			{
				OutError = TEXT("Float variable assignment requires a numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::SanitizeFloat(Value->AsNumber());
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Boolean)
		{
			if (Value->Type != EJson::Boolean)
			{
				OutError = TEXT("Boolean variable assignment requires a boolean literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = Value->AsBool() ? TEXT("true") : TEXT("false");
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_String)
		{
			if (Value->Type != EJson::String)
			{
				OutError = TEXT("String variable assignment requires a string literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = Value->AsString();
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Struct
			&& PinType.PinSubCategoryObject == TBaseStructure<FVector>::Get())
		{
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (Value->Type != EJson::Array || !Value->TryGetArray(Arr) || !Arr || Arr->Num() != 3)
			{
				OutError = TEXT("Vector variable assignment requires [x, y, z] numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"),
				(*Arr)[0]->AsNumber(),
				(*Arr)[1]->AsNumber(),
				(*Arr)[2]->AsNumber());
			return true;
		}

		OutError = TEXT("Unsupported literal assignment pin type");
		OutErrorCode = TEXT("UNSUPPORTED_LITERAL_TYPE");
		return false;
	}

	bool EnsureEventNodeEnabled(UK2Node_Event* EventNode)
	{
		if (!EventNode || !EventNode->IsAutomaticallyPlacedGhostNode())
		{
			return false;
		}
		// UEdGraphPin::ConvertConnectedGhostNodesToRealNodes does exactly this, but it
		// is a private static helper (EdGraphPin.h), so this mirrors its three
		// statements rather than calling it — the same conversion MakeLinkTo already
		// runs when a link touches a ghost node, so a node this helper enables is
		// indistinguishable from one the engine's own connection code enables.
		EventNode->Modify();
		EventNode->SetEnabledState(ENodeEnabledState::Enabled, /*bUserAction=*/false);
		EventNode->NodeComment.Empty();
#if WITH_EDITORONLY_DATA
		EventNode->bCommentBubbleVisible = false;
#endif
		return true;
	}
}
