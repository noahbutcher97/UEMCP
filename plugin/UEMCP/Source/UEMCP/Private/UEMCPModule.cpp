// Copyright Optimum Athena. All Rights Reserved.
#include "UEMCPModule.h"
#include "Misc/App.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY(LogUEMCP);

void FUEMCPModule::StartupModule()
{
	// D57 gate: commandlet processes (e.g., M-new Oracle-A DumpBPGraphCommandlet)
	// load the module to access UEMCP types but must NOT bind TCP:55558 — otherwise
	// concurrent interactive-editor + commandlet runs contend for the port.
	if (FApp::IsRunningCommandlet())
	{
		UE_LOG(LogUEMCP, Log, TEXT("UEMCP: commandlet detected — TCP server suppressed (D57 gate)"));
		return;
	}

	UE_LOG(LogUEMCP, Log, TEXT("UEMCP: module started (TCP runnable wires in via subsequent M1 commits)"));
}

void FUEMCPModule::ShutdownModule()
{
	UE_LOG(LogUEMCP, Log, TEXT("UEMCP: module shutdown"));
}

IMPLEMENT_MODULE(FUEMCPModule, UEMCP)
