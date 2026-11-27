// Copyright Noah Butcher. All Rights Reserved.
#include "GraphTraversalHandlers.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/PackageName.h"
#include "RigVMModel/RigVMClient.h"
#include "RigVMModel/RigVMGraph.h"
#include "RigVMModel/RigVMLink.h"
#include "RigVMModel/RigVMNode.h"
#include "RigVMModel/RigVMPin.h"
#if WITH_EDITORONLY_DATA && __has_include("RigVMRuntimeAsset.h")
#include "RigVMRuntimeAsset.h"
#endif
#include "SavedInspectionSource.h"

namespace UEMCP
{
	namespace
	{
		void InspectRigVMGraph(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString Package;
			if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Package) || !Package.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive) ||
				!FPackageName::IsValidLongPackageName(Package) || Package.Len() > 512)
			{
				BuildErrorResponse(OutResponse, TEXT("Supply a /Game package path to a RigVM model asset"), TEXT("INVALID_ASSET_PATH"));
				return;
			}
			const FString ObjectPath = Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package);
			UObject* Asset = LoadObject<UObject>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn);
			IRigVMClientHost* Host = Cast<IRigVMClientHost>(Asset);
			bool bRigAsset = Host != nullptr;
#if WITH_EDITORONLY_DATA && __has_include("RigVMRuntimeAsset.h")
			if (!Host)
			{
				if (IRigVMRuntimeAssetInterface* RuntimeAsset = Cast<IRigVMRuntimeAssetInterface>(Asset))
				{
					bRigAsset = true;
					UObject* EditorData = RuntimeAsset->GetEditorOnlyData();
					if (EditorData && EditorData->IsIn(Asset))
					{
						Host = Cast<IRigVMClientHost>(EditorData);
					}
				}
			}
#endif
			if (!bRigAsset || !Asset->GetPathName().Equals(ObjectPath, ESearchCase::CaseSensitive))
			{
				BuildErrorResponse(OutResponse, TEXT("Expected an existing RigVM model asset at the exact path"), TEXT("NOT_RIGVM_ASSET"));
				return;
			}
			const FRigVMClient* Client = Host ? Host->GetRigVMClient() : nullptr;
			const auto ModelUnavailable = [&OutResponse]()
			{
				BuildErrorResponse(OutResponse, TEXT("No live authoring model is available for this RigVM asset. Use read_package_inspection with kind rigvm to inspect supported saved data."), TEXT("RIGVM_EDITOR_MODEL_UNAVAILABLE"));
			};
			if (!Client) { ModelUnavailable(); return; }

			int32 MaxPins = 4096;
			if (Params->HasField(TEXT("max_pins")) && (!Params->TryGetNumberField(TEXT("max_pins"), MaxPins) || MaxPins < 1 || MaxPins > 4096))
			{
				BuildErrorResponse(OutResponse, TEXT("max_pins must be in [1,4096]"), TEXT("INVALID_ARGUMENT"));
				return;
			}
			auto TooLarge = [&OutResponse]()
			{
				BuildErrorResponse(OutResponse, TEXT("Rig exceeds the requested pin limit or the bounded graph, node, link or text budget"), TEXT("RIGVM_INSPECTION_LIMIT"));
			};
			int32 PinCount = 0, NodeCount = 0, LinkCount = 0;
			int64 TextUnits = 0;
			TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
			TArray<TSharedPtr<FJsonValue>> Graphs, Issues;
			const TArray<URigVMGraph*> AllModels = Client->GetAllModels(true, true);
			if (AllModels.IsEmpty()) { ModelUnavailable(); return; }
			if (AllModels.Num() > 128) { TooLarge(); return; }
			for (URigVMGraph* Graph : AllModels)
			{
				if (!Graph) { Issues.Add(MakeShared<FJsonValueString>(TEXT("Missing model"))); continue; }
				NodeCount += Graph->GetNodes().Num();
				LinkCount += Graph->GetLinks().Num();
				if (NodeCount > 1024 || LinkCount > 4096) { TooLarge(); return; }
				TSharedRef<FJsonObject> Model = MakeShared<FJsonObject>();
				Model->SetStringField(TEXT("path"), Graph->GetNodePath());
				TArray<TSharedPtr<FJsonValue>> Nodes, Links;
				for (const URigVMNode* Node : Graph->GetNodes())
				{
					if (!Node) { Issues.Add(MakeShared<FJsonValueString>(Graph->GetNodePath() + TEXT(": missing node"))); continue; }
					TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
					Entry->SetStringField(TEXT("name"), Node->GetName());
					Entry->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
					TArray<TSharedPtr<FJsonValue>> Pins;
					TArray<URigVMPin*> Pending;
					if (Node->GetPins().Num() > MaxPins - PinCount) { TooLarge(); return; }
					Pending.Append(Node->GetPins());
					for (int32 I = 0; I < Pending.Num(); ++I)
					{
						const URigVMPin* Pin = Pending[I];
						if (!Pin) { Issues.Add(MakeShared<FJsonValueString>(Node->GetNodePath(true) + TEXT(": missing pin"))); continue; }
						if (Pending.Num() + Pin->GetSubPins().Num() > MaxPins - PinCount) { TooLarge(); return; }
						Pending.Append(Pin->GetSubPins());
						const FString PinPath = Pin->GetPinPath(), Type = Pin->GetCPPType(), Default = Pin->GetDefaultValue();
						TextUnits += static_cast<int64>(PinPath.Len()) + Type.Len() + Default.Len();
						if (TextUnits > 256 * 1024) { TooLarge(); return; }
						TSharedRef<FJsonObject> Value = MakeShared<FJsonObject>();
						Value->SetStringField(TEXT("path"), PinPath);
						Value->SetStringField(TEXT("type"), Type);
						Value->SetStringField(TEXT("direction"), StaticEnum<ERigVMPinDirection>()->GetNameStringByValue(static_cast<int64>(Pin->GetDirection())));
						Value->SetStringField(TEXT("default"), Default);
						Pins.Add(MakeShared<FJsonValueObject>(Value));
					}
					PinCount += Pending.Num();
					if (Node->HasOrphanedPins()) Issues.Add(MakeShared<FJsonValueString>(Node->GetNodePath(true) + TEXT(": orphaned pins omitted")));
					Entry->SetArrayField(TEXT("pins"), Pins);
					Nodes.Add(MakeShared<FJsonValueObject>(Entry));
				}
				for (const URigVMLink* Link : Graph->GetLinks())
				{
					if (!Link || !Link->GetSourcePin() || !Link->GetTargetPin())
					{
						Issues.Add(MakeShared<FJsonValueString>(Graph->GetNodePath() + TEXT(": unresolved link")));
						continue;
					}
					TSharedRef<FJsonObject> Edge = MakeShared<FJsonObject>();
					const FString Source = Link->GetSourcePin()->GetPinPath(), Target = Link->GetTargetPin()->GetPinPath();
					TextUnits += static_cast<int64>(Source.Len()) + Target.Len();
					if (TextUnits > 256 * 1024) { TooLarge(); return; }
					Edge->SetStringField(TEXT("source"), Source);
					Edge->SetStringField(TEXT("target"), Target);
					Links.Add(MakeShared<FJsonValueObject>(Edge));
				}
				Model->SetArrayField(TEXT("nodes"), Nodes);
				Model->SetArrayField(TEXT("links"), Links);
				Graphs.Add(MakeShared<FJsonValueObject>(Model));
			}
			Result->SetStringField(TEXT("asset_path"), Package);
			Result->SetNumberField(TEXT("schema_version"), 1);
			Result->SetBoolField(TEXT("complete"), Issues.IsEmpty());
			Result->SetArrayField(TEXT("issues"), Issues);
			Result->SetArrayField(TEXT("graphs"), Graphs);
			AddInspectionSource(*Result, *Asset, Params);
			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterRigVMHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_rigvm_graph"), &InspectRigVMGraph);
	}
}
