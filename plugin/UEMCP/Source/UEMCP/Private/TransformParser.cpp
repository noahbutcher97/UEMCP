// Copyright Optimum Athena. All Rights Reserved.
#include "TransformParser.h"
#include "Dom/JsonValue.h"

namespace
{
	/** Reads a JSON array of exactly 3 numeric elements. Returns false with diagnostic on any failure. */
	bool ReadNumericTriple(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, double Out[3], FString& OutError)
	{
		if (!Obj.IsValid())
		{
			OutError = TEXT("params object is null");
			return false;
		}

		const TArray<TSharedPtr<FJsonValue>>* ArrayPtr = nullptr;
		if (!Obj->TryGetArrayField(FieldName, ArrayPtr) || !ArrayPtr)
		{
			OutError = FString::Printf(TEXT("'%s' must be an array"), *FieldName);
			return false;
		}

		if (ArrayPtr->Num() != 3)
		{
			OutError = FString::Printf(TEXT("'%s' must have exactly 3 numbers (got %d)"), *FieldName, ArrayPtr->Num());
			return false;
		}

		for (int32 i = 0; i < 3; ++i)
		{
			double Value = 0.0;
			if (!(*ArrayPtr)[i].IsValid() || !(*ArrayPtr)[i]->TryGetNumber(Value))
			{
				OutError = FString::Printf(TEXT("'%s'[%d] must be a number"), *FieldName, i);
				return false;
			}
			Out[i] = Value;
		}
		return true;
	}
}

namespace UEMCP
{
	bool ParseVector3(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FVector& OutVec, FString& OutError)
	{
		double Values[3];
		if (!ReadNumericTriple(Obj, FieldName, Values, OutError))
		{
			return false;
		}
		OutVec = FVector(Values[0], Values[1], Values[2]);
		return true;
	}

	bool ParseRotator(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FRotator& OutRot, FString& OutError)
	{
		double Values[3];
		if (!ReadNumericTriple(Obj, FieldName, Values, OutError))
		{
			return false;
		}
		// [pitch, yaw, roll] — matches legacy 55557 convention (see tcp-protocol.md / P0-4).
		OutRot = FRotator(Values[0], Values[1], Values[2]);
		return true;
	}

	bool BuildTransformFromJson(const TSharedPtr<FJsonObject>& Params, FTransform& OutTransform, FString& OutError)
	{
		if (!Params.IsValid())
		{
			OutError = TEXT("params object is null");
			return false;
		}

		FVector Location = FVector::ZeroVector;
		FRotator Rotation = FRotator::ZeroRotator;
		FVector Scale = FVector::OneVector;

		// Each field is optional — only parse if present. A present-but-malformed field fails.
		if (Params->HasField(TEXT("location")) && !ParseVector3(Params, TEXT("location"), Location, OutError))
		{
			return false;
		}
		if (Params->HasField(TEXT("rotation")) && !ParseRotator(Params, TEXT("rotation"), Rotation, OutError))
		{
			return false;
		}
		if (Params->HasField(TEXT("scale")) && !ParseVector3(Params, TEXT("scale"), Scale, OutError))
		{
			return false;
		}

		OutTransform = FTransform(Rotation, Location, Scale);
		return true;
	}
}
