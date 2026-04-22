// Copyright Optimum Athena. All Rights Reserved.
#include "EdgeOnlyBPSerializer.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "Misc/EngineVersion.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace UEMCP
{
namespace
{
	const TCHAR* DirectionToString(EEdGraphPinDirection Dir)
	{
		switch (Dir)
		{
		case EGPD_Input:  return TEXT("EGPD_Input");
		case EGPD_Output: return TEXT("EGPD_Output");
		default:          return TEXT("EGPD_Unknown");
		}
	}

	// Recursively serialize one graph plus any SubGraphs (K2Node_Composite / collapsed
	// nodes nest child graphs under UEdGraph::SubGraphs). Each graph gets a unique
	// dotted name path so collisions between identically-named sub-graphs don't lose data.
	void SerializeGraph(UEdGraph* Graph, const FString& GraphKey, const TSharedRef<FJsonObject>& GraphsObj)
	{
		if (!Graph)
		{
			return;
		}

		TSharedRef<FJsonObject> GraphObj = MakeShared<FJsonObject>();
		TSharedRef<FJsonObject> NodesObj = MakeShared<FJsonObject>();

		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (!Node)
			{
				continue;
			}

			TSharedRef<FJsonObject> NodeObj = MakeShared<FJsonObject>();
			NodeObj->SetStringField(TEXT("class_name"), Node->GetClass()->GetName());

			TSharedRef<FJsonObject> PinsObj = MakeShared<FJsonObject>();
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin)
				{
					continue;
				}

				TSharedRef<FJsonObject> PinObj = MakeShared<FJsonObject>();
				// Pin name is declared by the node type (e.g. "then", "Target", "ReturnValue") and
				// is stable across the post-load deterministic-ID divergence that affects
				// K2Node_EditablePinBase subclasses + K2Node_PromotableOperator (D68). S-B-base's
				// differential harness uses it as a fallback matcher when pin_id doesn't match.
				PinObj->SetStringField(TEXT("name"),      Pin->PinName.ToString());
				PinObj->SetStringField(TEXT("direction"), DirectionToString(Pin->Direction));

				TArray<TSharedPtr<FJsonValue>> LinkedArr;
				LinkedArr.Reserve(Pin->LinkedTo.Num());
				for (UEdGraphPin* Linked : Pin->LinkedTo)
				{
					if (!Linked || !Linked->GetOwningNodeUnchecked())
					{
						continue;
					}
					TSharedRef<FJsonObject> LinkObj = MakeShared<FJsonObject>();
					LinkObj->SetStringField(TEXT("node_guid"), Linked->GetOwningNodeUnchecked()->NodeGuid.ToString());
					LinkObj->SetStringField(TEXT("pin_id"),    Linked->PinId.ToString());
					LinkedArr.Add(MakeShared<FJsonValueObject>(LinkObj));
				}
				PinObj->SetArrayField(TEXT("linked_to"), LinkedArr);

				PinsObj->SetObjectField(Pin->PinId.ToString(), PinObj);
			}
			NodeObj->SetObjectField(TEXT("pins"), PinsObj);

			NodesObj->SetObjectField(Node->NodeGuid.ToString(), NodeObj);
		}

		GraphObj->SetObjectField(TEXT("nodes"), NodesObj);
		GraphsObj->SetObjectField(GraphKey, GraphObj);

		// Recurse into sub-graphs (collapsed nodes / composite nodes).
		for (UEdGraph* Sub : Graph->SubGraphs)
		{
			if (Sub)
			{
				const FString ChildKey = FString::Printf(TEXT("%s.%s"), *GraphKey, *Sub->GetName());
				SerializeGraph(Sub, ChildKey, GraphsObj);
			}
		}
	}
}

bool SerializeBlueprintEdges(UBlueprint* Blueprint, const FString& AssetPath, bool bPretty, FString& OutJson)
{
	OutJson.Reset();
	if (!Blueprint)
	{
		return false;
	}

	TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("schema_version"), TEXT("oracle-a-v2"));
	Root->SetStringField(TEXT("engine_version"), FEngineVersion::Current().ToString());
	Root->SetStringField(TEXT("asset_path"),     AssetPath);

	TSharedRef<FJsonObject> GraphsObj = MakeShared<FJsonObject>();

	auto WalkArray = [&GraphsObj](const TArray<TObjectPtr<UEdGraph>>& Arr)
	{
		for (UEdGraph* G : Arr)
		{
			if (G)
			{
				SerializeGraph(G, G->GetName(), GraphsObj);
			}
		}
	};

	WalkArray(Blueprint->UbergraphPages);
	WalkArray(Blueprint->FunctionGraphs);       // Includes the "UserConstructionScript" function graph.
	WalkArray(Blueprint->MacroGraphs);
	WalkArray(Blueprint->DelegateSignatureGraphs);

	Root->SetObjectField(TEXT("graphs"), GraphsObj);

	if (bPretty)
	{
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&OutJson);
		return FJsonSerializer::Serialize(Root, Writer);
	}
	else
	{
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&OutJson);
		return FJsonSerializer::Serialize(Root, Writer);
	}
}
}
