// Copyright Noah Butcher. All Rights Reserved.
#include "BlueprintHandlerHelpers.h"
#include "CachePoseAuthoring.h"

#include "EdGraphSchema_K2.h"
#include "AnimGraphNode_Slot.h"
#include "AnimGraphNode_CustomProperty.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Animation/AnimBlueprint.h"
#include "Animation/Skeleton.h"
#include "EdGraph/EdGraph.h"
#include "Misc/SecureHash.h"
#include "K2Node_Event.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	bool IsWritableAnimPackage(const UPackage* Package)
	{
		FString Filename;
		return !Package->HasAnyPackageFlags(PKG_Cooked | PKG_FilterEditorOnly) &&
			FPackageName::IsValidLongPackageName(Package->GetName(), false) &&
			FAssetToolsModule::GetModule().Get().AllPassWritableFolderFilter({FPackageName::GetLongPackagePath(Package->GetName())}) &&
			(!FPackageName::DoesPackageExist(Package->GetName(), &Filename) || !IFileManager::Get().IsReadOnly(*Filename));
	}

	bool HasConnectionBinding(const UEdGraphPin* Pin)
	{
		const auto* Node = Cast<UAnimGraphNode_Base>(Pin->GetOwningNode());
		if (!Node) return false;
		// The schema clears the unnumbered property. Linked nodes also clear a generated key.
		const auto* Custom = Cast<UAnimGraphNode_CustomProperty>(Node);
		const FName Generated = Custom ? FName(*Custom->GetPinTargetVariableName(Pin)) : NAME_None;
		const FName Name(Pin->PinName, 0);
#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION <= 3
		for (const auto& Binding : Node->PropertyBindings)
			if (FName(Binding.Key, 0) == Name || (Custom && Binding.Key == Generated)) return true;
		return false;
#else
		return Node->UAnimGraphNode_Base::HasBinding(Name) || (Custom && Node->HasBinding(Generated));
#endif
	}

	FString GraphTopologyRevision(const UEdGraph* Graph)
	{
		TArray<FString> Rows;
		Rows.Add(Graph->GraphGuid.ToString());
		const auto* Blueprint = Cast<UAnimBlueprint>(Graph->GetOuter());
		if (Blueprint && Blueprint->TargetSkeleton)
		{
			Rows.Add(Blueprint->TargetSkeleton->GetPathName());
			for (const auto& Group : Blueprint->TargetSkeleton->GetSlotGroups())
				for (FName Slot : Group.SlotNames)
					Rows.Add(TEXT("slot|") + Group.GroupName.ToString() + TEXT("|") + Slot.ToString());
		}
		for (const UEdGraphNode* Node : Graph->Nodes)
		{
			if (!Node) continue;
			const FString NodeId = Node->NodeGuid.ToString();
			Rows.Add(NodeId);
			const FString CacheState = CachedPoseRevision(Node);
			if (!CacheState.IsEmpty()) Rows.Add(NodeId + TEXT("|") + CacheState);
			if (const auto* Slot = Cast<UAnimGraphNode_Slot>(Node))
				Rows.Add(NodeId + TEXT("|slot|") + Slot->Node.SlotName.ToString());
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin) continue;
				const FString Endpoint = NodeId + Pin->PinId.ToString();
				Rows.Add(Endpoint);
				if (HasConnectionBinding(Pin)) Rows.Add(Endpoint + TEXT("|bound"));
				for (const UEdGraphPin* Peer : Pin->LinkedTo)
				{
					if (Peer) Rows.Add(Endpoint + Peer->PinId.ToString());
				}
			}
		}
		Rows.Sort();
		const FString State = FString::Join(Rows, TEXT("\n"));
		const FTCHARToUTF8 Encoded(*State);
		return FMD5::HashBytes(reinterpret_cast<const uint8*>(Encoded.Get()), Encoded.Length());
	}

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
		if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Text || !Pin->DefaultTextValue.IsEmpty())
		{
			Obj->SetStringField(TEXT("default_text_value"), Pin->DefaultTextValue.ToString());
		}
		if (Pin->DefaultObject)
		{
			Obj->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
		}
		Obj->SetNumberField(TEXT("link_count"), Pin->LinkedTo.Num());
		return Obj;
	}

	/** Reads [x, y, z] as three numbers; on failure OutBadIndex names the first offender. */
	static bool ReadVectorComponents(const TArray<TSharedPtr<FJsonValue>>& Arr, double& X, double& Y, double& Z, int32& OutBadIndex)
	{
		double* Slots[3] = { &X, &Y, &Z };
		for (int32 Index = 0; Index < 3; ++Index)
		{
			if (Index >= Arr.Num() || !Arr[Index].IsValid() || !Arr[Index]->TryGetNumber(*Slots[Index]))
			{
				OutBadIndex = Index;
				return false;
			}
		}
		return true;
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
			int32 BadIndex = 0;
			if (!ReadVectorComponents(Arr, X, Y, Z, BadIndex))
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

	bool IsRepresentableRealPinValue(double Value, bool bSinglePrecision)
	{
		if (!FMath::IsFinite(Value)) return false;
		if (!bSinglePrecision) return true;
		// A decimal just beyond FLT_MAX can still round to the largest finite float.
		const float Rounded = static_cast<float>(Value);
		return FMath::IsFinite(Rounded) && (Value == 0.0 || Rounded != 0.f);
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
			const double Number = Value->AsNumber();
			const bool bSinglePrecision = Category == UEdGraphSchema_K2::PC_Float || PinType.PinSubCategory == UEdGraphSchema_K2::PC_Float;
			if (!IsRepresentableRealPinValue(Number, bSinglePrecision))
			{
				OutError = TEXT("Numeric literal exceeds the pin's finite range");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			// Preserve established pin text when it already represents the value.
			// SanitizeFloat starts from %f, so small values can otherwise become 0.
			OutDefaultValue = FString::SanitizeFloat(Number);
			const bool bRoundTrips = bSinglePrecision ? FCString::Atof(*OutDefaultValue) == static_cast<float>(Number) :
				FCString::Atod(*OutDefaultValue) == Number;
			if (!bRoundTrips)
			{
				OutDefaultValue = FString::Printf(TEXT("%.17g"), Number);
			}
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
			double X = 0.0;
			double Y = 0.0;
			double Z = 0.0;
			int32 BadIndex = 0;
			if (!ReadVectorComponents(*Arr, X, Y, Z, BadIndex))
			{
				OutError = FString::Printf(TEXT("Vector variable assignment requires [x, y, z] numeric literal; element %d is not a number"), BadIndex);
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"), X, Y, Z);
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
