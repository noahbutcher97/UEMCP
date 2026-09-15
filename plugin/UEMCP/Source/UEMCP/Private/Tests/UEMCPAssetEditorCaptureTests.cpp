// Copyright Noah Butcher. All Rights Reserved.
//
// EN-24/EN-25 native tests. Each test dispatches a real command through
// FMCPCommandRegistry — RegisterAssetEditorCaptureHandlers runs at module
// startup from MCPCommandRegistry.cpp, so the registry reaches the handlers in
// any editor with the plugin loaded.
//
// These prove addressing and error handling, not pixels. The runner passes
// -nullrhi, so FApp::CanEverRender() is false and any capture that gets as far
// as the renderer returns CAPTURE_UNSUPPORTED. That is asserted rather than
// worked around; the live smoke is the only proof of pixels.
//
// Three tests need an open asset editor. UAssetEditorSubsystem::OpenEditorForAsset
// may refuse under -nullrhi -unattended; those tests record AddInfo and return
// true rather than failing, and the four unconditional ones carry the coverage
// that must not depend on it.
//
// The fixture Blueprint lives in an unsaved in-memory package under
// /Game/__UEMCPTests/. Its object name MUST equal its package leaf: LoadObject
// resolves a dot-less path by retrying it as "<path>.<short name>" (engine
// StaticLoadObjectInternal), and that retry is the only reason
// ResolveAssetEditorTarget finds an unsaved object. Nothing is ever saved.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/Base64.h"
#include "Misc/Guid.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Toolkits/AssetEditorToolkit.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "Widgets/SNullWidget.h"

#include "AssetEditorCapture.h"
#include "MCPCommandRegistry.h"

namespace UEMCP::AssetEditorCapture::Tests
{
	/** Package root for fixture Blueprints. Never saved; unique leaf per call. */
	static const TCHAR* FixtureRoot = TEXT("/Game/__UEMCPTests");

	struct FFixtureAsset
	{
		UBlueprint* Blueprint = nullptr;
		UPackage* Package = nullptr;
		/** What asset_path receives. */
		FString PackagePath;
	};

	/**
	 * Actor-parented Blueprint in a fresh in-memory package. The object name
	 * equals the package leaf — see the file header for why that is
	 * load-bearing.
	 */
	FFixtureAsset CreateFixtureAsset()
	{
		FFixtureAsset Fixture;
		const FString Leaf = FString::Printf(TEXT("BP_UEMCPCapture_%s"),
			*FGuid::NewGuid().ToString(EGuidFormats::Short));
		Fixture.PackagePath = FString::Printf(TEXT("%s/%s"), FixtureRoot, *Leaf);
		Fixture.Package = CreatePackage(*Fixture.PackagePath);
		if (!Fixture.Package)
		{
			return Fixture;
		}
		Fixture.Blueprint = FKismetEditorUtilities::CreateBlueprint(
			AActor::StaticClass(),
			Fixture.Package,
			FName(*Leaf),
			BPTYPE_Normal,
			UBlueprint::StaticClass(),
			UBlueprintGeneratedClass::StaticClass());
		if (Fixture.Blueprint)
		{
			FAssetRegistryModule::AssetCreated(Fixture.Blueprint);
		}
		return Fixture;
	}

	/**
	 * Best-effort teardown. Isolation comes from the unique package leaf, not
	 * from collection, so no test asserts the object is gone.
	 */
	void DestroyFixtureAsset(FFixtureAsset& Fixture)
	{
		if (Fixture.Blueprint)
		{
			// OpenEditorForAsset's default EToolkitMode::Standalone opens a real
			// top-level OS window. Under -nullrhi -unattended that window is
			// backed by the generic/null platform implementation, and a graceful
			// close asks it to save its restored (non-maximized) dimensions —
			// FGenericWindow::GetRestoredDimensions() treats that as fatal on
			// this platform. CanCaptureSlate() is the same renderer gate the
			// handler uses, so this only skips the close where the open itself
			// was never going to be safe either; the fixture package still gets
			// marked garbage below regardless.
			if (GEditor && UEMCP::CanCaptureSlate())
			{
				if (UAssetEditorSubsystem* Subsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
				{
					Subsystem->CloseAllEditorsForAsset(Fixture.Blueprint);
				}
			}
			FAssetRegistryModule::AssetDeleted(Fixture.Blueprint);
			Fixture.Blueprint->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Blueprint->MarkAsGarbage();
			Fixture.Blueprint = nullptr;
		}
		if (Fixture.Package)
		{
			Fixture.Package->SetDirtyFlag(false);
			Fixture.Package->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Package->MarkAsGarbage();
			Fixture.Package = nullptr;
		}
		CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
	}

	/** One command through the registry the plugin populates at startup. */
	TSharedPtr<FJsonObject> Dispatch(const FString& Command, const TSharedPtr<FJsonObject>& Params)
	{
		TSharedPtr<FJsonObject> Response;
		FMCPCommandRegistry::Get().Dispatch(Command, Params, Response);
		return Response;
	}

	/** Error code from a response, or "SUCCESS", or "NO_RESPONSE". */
	FString CodeOf(const TSharedPtr<FJsonObject>& Response)
	{
		if (!Response.IsValid())
		{
			return TEXT("NO_RESPONSE");
		}
		FString Status;
		Response->TryGetStringField(TEXT("status"), Status);
		if (Status == TEXT("success"))
		{
			return TEXT("SUCCESS");
		}
		FString Code;
		Response->TryGetStringField(TEXT("code"), Code);
		return Code.IsEmpty() ? TEXT("ERROR") : Code;
	}

	/**
	 * Log-silent string read. FJsonObject::GetStringField logs a LogJson Error
	 * on an absent field and the automation framework counts an Error-level log
	 * as a failure, so a missing optional field would be reported as a JSON
	 * type error rather than as the assertion that actually failed.
	 */
	FString StringFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field)
	{
		FString Value;
		if (Obj.IsValid())
		{
			Obj->TryGetStringField(Field, Value);
		}
		return Value;
	}

	TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>& Response)
	{
		const TSharedPtr<FJsonObject>* Result = nullptr;
		if (Response.IsValid() && Response->TryGetObjectField(TEXT("result"), Result) && Result)
		{
			return *Result;
		}
		return MakeShared<FJsonObject>();
	}

	TSharedPtr<FJsonObject> AssetParams(const FString& AssetPath)
	{
		TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
		Params->SetStringField(TEXT("asset_path"), AssetPath);
		return Params;
	}

	/**
	 * Opens the fixture's editor. Returns null when the subsystem refuses
	 * (headless -nullrhi is allowed to), which callers report as a skip.
	 *
	 * OpenEditorForAsset's default EToolkitMode::Standalone opens a real
	 * top-level OS window and initializes an FAssetEditorToolkit against it.
	 * On this engine build that path is empirically unsafe under
	 * -nullrhi -unattended: live-fire runs hit two distinct crashes from the
	 * same call — a fatal FGenericWindow::GetRestoredDimensions() on window
	 * close, and a separate `EditingObjects.Num() > 0` assertion
	 * (AssetEditorToolkit.cpp:562) inside the open itself. The second was
	 * re-verified on a clean Saved/Config/WindowsEditor (with this guard
	 * temporarily removed) to rule out corrupted layout state left by the
	 * first crash as a confound — it reproduced identically, so this is a
	 * real engine condition, not flakiness or leftover state. This declines
	 * before ever calling OpenEditorForAsset rather than trying to catch
	 * either failure after the fact. CanCaptureSlate() is the same renderer
	 * gate the production handler uses for the analogous reason.
	 */
	IAssetEditorInstance* OpenFixtureEditor(const FFixtureAsset& Fixture)
	{
		if (!GEditor || !Fixture.Blueprint || !UEMCP::CanCaptureSlate())
		{
			return nullptr;
		}
		UAssetEditorSubsystem* Subsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
		if (!Subsystem)
		{
			return nullptr;
		}
		Subsystem->OpenEditorForAsset(Fixture.Blueprint);
		return Subsystem->FindEditorForAsset(Fixture.Blueprint, /*bFocusIfOpen*/ false);
	}
}

// =====================================================================================
// Unconditional: an unresolvable asset path, and a missing one, never reach the
// renderer gate. This is the test that pins the validation order — if the gate
// moved first, both of these would come back CAPTURE_UNSUPPORTED under -nullrhi.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureAssetNotFoundTest,
	"UEMCP.AssetEditorCapture.AssetNotFound",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureAssetNotFoundTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	const FString Missing = TEXT("/Game/__UEMCPTests/BP_DoesNotExist");
	TestEqual(TEXT("capture_asset_editor on an unloadable path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Missing))), FString(TEXT("ASSET_NOT_FOUND")));
	TestEqual(TEXT("list_asset_editor_tabs on an unloadable path"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Missing))), FString(TEXT("ASSET_NOT_FOUND")));

	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("capture_asset_editor with no asset_path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), Empty)), FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("list_asset_editor_tabs with no asset_path"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), Empty)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> BlankPath = AssetParams(TEXT(""));
	TestEqual(TEXT("capture_asset_editor with an empty asset_path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), BlankPath)), FString(TEXT("MISSING_PARAMS")));
	return true;
}

// =====================================================================================
// Unconditional: a real, loadable asset with no editor open. Separates
// "cannot find the asset" from "found it, nobody is editing it".
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureEditorNotOpenTest,
	"UEMCP.AssetEditorCapture.EditorNotOpen",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureEditorNotOpenTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}

	TestEqual(TEXT("list_asset_editor_tabs with no editor open"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("EDITOR_NOT_OPEN")));
	TestEqual(TEXT("capture_asset_editor with no editor open"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("EDITOR_NOT_OPEN")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: tab listing and an unknown tab id.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureOpenEditorTabsTest,
	"UEMCP.AssetEditorCapture.OpenEditorTabs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureOpenEditorTabsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	const TSharedPtr<FJsonObject> Listed = Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath));
	TestEqual(TEXT("list_asset_editor_tabs succeeds for an open editor"),
		CodeOf(Listed), FString(TEXT("SUCCESS")));
	const TSharedPtr<FJsonObject> Result = ResultOf(Listed);
	TestTrue(TEXT("editor_class is reported"), !StringFieldOr(Result, TEXT("editor_class")).IsEmpty());
	const TArray<TSharedPtr<FJsonValue>>* Tabs = nullptr;
	TestTrue(TEXT("tabs array is present"), Result->TryGetArrayField(TEXT("tabs"), Tabs));

	TSharedPtr<FJsonObject> BadTab = AssetParams(Fixture.PackagePath);
	BadTab->SetStringField(TEXT("tab_id"), TEXT("NoSuchTabId"));
	TestEqual(TEXT("capture_asset_editor with an unknown tab_id"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), BadTab)), FString(TEXT("TAB_NOT_FOUND")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: the renderer gate. Under -nullrhi TakeScreenshot returns an
// empty buffer instead of failing, so the handler must refuse rather than write
// a blank PNG. With a renderer this assertion does not apply and is skipped.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureUnsupportedTest,
	"UEMCP.AssetEditorCapture.CaptureUnsupportedHeadless",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureUnsupportedTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	if (FApp::CanEverRender())
	{
		AddInfo(TEXT("skipped: a renderer is present, so CAPTURE_UNSUPPORTED is not the expected outcome"));
		return true;
	}
	TestFalse(TEXT("CanCaptureSlate is false without a renderer"), UEMCP::CanCaptureSlate());

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		// The helper-level path is asserted by CaptureUnsupportedHelper; this handler path stays a labelled skip headless.
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	TestEqual(TEXT("capture_asset_editor refuses without a renderer"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("CAPTURE_UNSUPPORTED")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Unconditional: PIE is not running in a headless automation pass, so the
// refusal is the assertion. GEditor->PlayWorld is checked before the renderer
// gate, which is why this reports PIE_NOT_RUNNING rather than
// CAPTURE_UNSUPPORTED under -nullrhi.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCapturePieNotRunningTest,
	"UEMCP.AssetEditorCapture.PieNotRunning",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCapturePieNotRunningTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	if (GEditor && GEditor->PlayWorld)
	{
		AddInfo(TEXT("skipped: a PIE session is active, so PIE_NOT_RUNNING is not the expected outcome"));
		return true;
	}
	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("capture_pie_viewport with no PIE session"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), Empty)), FString(TEXT("PIE_NOT_RUNNING")));
	// Null params is a legal wire shape for a parameter-less command; the
	// handler must reach the same refusal rather than dereferencing them.
	TestEqual(TEXT("capture_pie_viewport tolerates null params"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), nullptr)), FString(TEXT("PIE_NOT_RUNNING")));
	return true;
}

// =====================================================================================
// Unconditional: the details handlers' parameter and resolution errors, none of
// which needs an open editor.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureDetailsParamsTest,
	"UEMCP.AssetEditorCapture.DetailsPanelParams",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureDetailsParamsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("details_panel_expand_all with no params"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), Empty)), FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("details_panel_scroll with no params"),
		CodeOf(Dispatch(TEXT("details_panel_scroll"), Empty)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> NoTab = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	TestEqual(TEXT("details_panel_expand_all with no tab_id"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), NoTab)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> NegativeOffset = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	NegativeOffset->SetStringField(TEXT("tab_id"), TEXT("Details"));
	NegativeOffset->SetNumberField(TEXT("row_offset"), -1);
	TestEqual(TEXT("details_panel_scroll with a negative row_offset"),
		CodeOf(Dispatch(TEXT("details_panel_scroll"), NegativeOffset)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> MissingAsset = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	MissingAsset->SetStringField(TEXT("tab_id"), TEXT("Details"));
	TestEqual(TEXT("details_panel_expand_all on an unloadable path"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), MissingAsset)), FString(TEXT("ASSET_NOT_FOUND")));

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	TSharedPtr<FJsonObject> ClosedEditor = AssetParams(Fixture.PackagePath);
	ClosedEditor->SetStringField(TEXT("tab_id"), TEXT("Details"));
	TestEqual(TEXT("details_panel_expand_all with no editor open"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), ClosedEditor)), FString(TEXT("EDITOR_NOT_OPEN")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: an unknown tab id, and a live tab that holds no details view.
// Both TAB_NOT_FOUND and NOT_A_DETAILS_PANEL on these two tools only run here
// when OpenFixtureEditor succeeds; on this engine build that is unreliable
// headless, so both assertions are effectively live-smoke-only in practice —
// they are still asserted by value whenever the fixture editor does open.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureDetailsTabTest,
	"UEMCP.AssetEditorCapture.DetailsPanelTab",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureDetailsTabTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	TSharedPtr<FJsonObject> BadTab = AssetParams(Fixture.PackagePath);
	BadTab->SetStringField(TEXT("tab_id"), TEXT("NoSuchTabId"));
	TestEqual(TEXT("details_panel_expand_all with an unknown tab_id"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), BadTab)), FString(TEXT("TAB_NOT_FOUND")));

	// A tab that exists but holds no SDetailsView must say so rather than
	// reporting success on nothing. Which tabs a Blueprint editor exposes is
	// not guaranteed, so a tab without a details view is searched for and its
	// absence is a skip, not a failure.
	const TSharedPtr<FJsonObject> Listed = ResultOf(
		Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath)));
	const TArray<TSharedPtr<FJsonValue>>* Tabs = nullptr;
	FString NonDetailsTabId;
	if (Listed->TryGetArrayField(TEXT("tabs"), Tabs) && Tabs)
	{
		for (const TSharedPtr<FJsonValue>& Entry : *Tabs)
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			if (!Entry.IsValid() || !Entry->TryGetObject(Obj) || !Obj)
			{
				continue;
			}
			const FString CandidateId = StringFieldOr(*Obj, TEXT("tab_id"));
			TSharedPtr<FJsonObject> Probe = AssetParams(Fixture.PackagePath);
			Probe->SetStringField(TEXT("tab_id"), CandidateId);
			if (CodeOf(Dispatch(TEXT("details_panel_expand_all"), Probe)) == TEXT("NOT_A_DETAILS_PANEL"))
			{
				NonDetailsTabId = CandidateId;
				break;
			}
		}
	}
	if (NonDetailsTabId.IsEmpty())
	{
		AddInfo(TEXT("skipped: this editor exposes no live tab without a details view"));
	}
	else
	{
		TSharedPtr<FJsonObject> Scroll = AssetParams(Fixture.PackagePath);
		Scroll->SetStringField(TEXT("tab_id"), NonDetailsTabId);
		Scroll->SetNumberField(TEXT("row_offset"), 0);
		TestEqual(TEXT("details_panel_scroll on a tab with no details view"),
			CodeOf(Dispatch(TEXT("details_panel_scroll"), Scroll)), FString(TEXT("NOT_A_DETAILS_PANEL")));
	}

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// ResolveCaptureOutputPath confines every capture tool's output to the project.
// The three dispatch assertions prove the rejection is checked before any editor
// or viewport lookup, so it is reachable headless and wins over ASSET_NOT_FOUND,
// PIE_NOT_RUNNING and NO_VIEWPORT.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureOutputPathTest,
	"UEMCP.AssetEditorCapture.OutputPathConfinement",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureOutputPathTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FString Abs;
	FString Err;
	TestTrue(TEXT("empty request resolves"), UEMCP::ResolveCaptureOutputPath(TEXT(""), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("empty request lands under Saved/UEMCP/Captures"), Abs.Contains(TEXT("/UEMCP/Captures/")) && Abs.EndsWith(TEXT(".png")));
	TestTrue(TEXT("relative request resolves"), UEMCP::ResolveCaptureOutputPath(TEXT("review/shot"), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("relative request lands under Captures and gains .png"), Abs.EndsWith(TEXT("/UEMCP/Captures/review/shot.png")));
	TestFalse(TEXT("an escaping relative request is rejected"), UEMCP::ResolveCaptureOutputPath(TEXT("../../../../escape"), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("the rejection names the path"), Err.Contains(TEXT("escape")));
	const FString EngineSide = FPaths::ConvertRelativePathToFull(FPaths::EngineDir()) / TEXT("outside.png");
	TestFalse(TEXT("an absolute path outside the project is rejected"), UEMCP::ResolveCaptureOutputPath(EngineSide, TEXT("Stem"), Abs, Err));
	const FString Inside = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir()) / TEXT("UEMCP/ok.PNG");
	TestTrue(TEXT("an absolute path inside Saved is accepted"), UEMCP::ResolveCaptureOutputPath(Inside, TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("an upper-case .PNG is kept as given"), Abs.EndsWith(TEXT("ok.PNG")));

	// Handlers check the path before any editor or viewport lookup, so the
	// rejection is reachable headless and wins over ASSET_NOT_FOUND, PIE_NOT_RUNNING
	// and NO_VIEWPORT.
	TSharedPtr<FJsonObject> Escaping = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	Escaping->SetStringField(TEXT("out_png"), TEXT("../../../../escape"));
	TestEqual(TEXT("capture_asset_editor refuses an escaping out_png first"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), Escaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	TSharedPtr<FJsonObject> PieEscaping = MakeShared<FJsonObject>();
	PieEscaping->SetStringField(TEXT("out_png"), TEXT("../../../../escape"));
	TestEqual(TEXT("capture_pie_viewport refuses an escaping out_png first"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), PieEscaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	TSharedPtr<FJsonObject> ViewportEscaping = MakeShared<FJsonObject>();
	ViewportEscaping->SetStringField(TEXT("output_path"), TEXT("../../../../escape"));
	TestEqual(TEXT("get_viewport_screenshot refuses an escaping output_path first"),
		CodeOf(Dispatch(TEXT("get_viewport_screenshot"), ViewportEscaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	return true;
}

// =====================================================================================
// AppendInlinePng's over-cap branch has only ever run against a multi-MiB real
// capture, so it has never been proved directly. A fabricated 32-byte buffer
// exercises both branches of the cap without needing a renderer at all.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureInlinePngCapTest,
	"UEMCP.AssetEditorCapture.InlinePngCap",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureInlinePngCapTest::RunTest(const FString& Parameters)
{
	TArray64<uint8> Buffer;
	Buffer.SetNumUninitialized(32);
	for (int32 Index = 0; Index < 32; ++Index)
	{
		Buffer[Index] = static_cast<uint8>(Index * 7);
	}
	// 32 bytes encode to 44 base64 characters: a cap of 16 is over, 64 is under.
	TSharedRef<FJsonObject> Over = MakeShared<FJsonObject>();
	UEMCP::AppendInlinePng(Over, Buffer, 16);
	TestEqual(TEXT("over the cap reports inline_omitted"), Over->GetStringField(TEXT("inline_omitted")), FString(TEXT("too_large")));
	TestFalse(TEXT("over the cap carries no png_base64"), Over->HasField(TEXT("png_base64")));

	TSharedRef<FJsonObject> Under = MakeShared<FJsonObject>();
	UEMCP::AppendInlinePng(Under, Buffer, 64);
	TestFalse(TEXT("under the cap carries no inline_omitted"), Under->HasField(TEXT("inline_omitted")));
	TArray<uint8> Decoded;
	TestTrue(TEXT("png_base64 decodes"), FBase64::Decode(Under->GetStringField(TEXT("png_base64")), Decoded));
	TestEqual(TEXT("decoded length matches"), Decoded.Num(), 32);
	TestTrue(TEXT("decoded bytes match"), Decoded.Num() == 32 && FMemory::Memcmp(Decoded.GetData(), Buffer.GetData(), 32) == 0);
	return true;
}

// =====================================================================================
// CaptureWidgetToPng's CAPTURE_UNSUPPORTED refusal is otherwise only reachable
// through an open asset editor, which the headless runner may decline to open
// (see CaptureUnsupportedHeadless above). SNullWidget::NullWidget lets this
// assert the refusal directly against the helper, unconditionally.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureUnsupportedHelperTest,
	"UEMCP.AssetEditorCapture.CaptureUnsupportedHelper",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureUnsupportedHelperTest::RunTest(const FString& Parameters)
{
	if (FApp::CanEverRender())
	{
		AddInfo(TEXT("skipped: a renderer is present, so CAPTURE_UNSUPPORTED is not the expected outcome"));
		return true;
	}
	TArray64<uint8> Png;
	FIntPoint Size(0, 0);
	FString Code;
	FString Message;
	TestFalse(TEXT("CaptureWidgetToPng refuses without a renderer"),
		UEMCP::CaptureWidgetToPng(SNullWidget::NullWidget, Png, Size, Code, Message));
	TestEqual(TEXT("the helper reports CAPTURE_UNSUPPORTED"), Code, FString(TEXT("CAPTURE_UNSUPPORTED")));
	TestEqual(TEXT("no bytes are produced"), (int64)Png.Num(), (int64)0);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
