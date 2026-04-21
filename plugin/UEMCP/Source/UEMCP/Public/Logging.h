// Copyright Optimum Athena. All Rights Reserved.
#pragma once

// LogUEMCP is declared in UEMCPModule.h. This header exists to provide
// lightweight UE_LOG wrappers for call-site readability.
#include "UEMCPModule.h"

#define UEMCP_LOG(Format, ...)     UE_LOG(LogUEMCP, Log,     TEXT(Format), ##__VA_ARGS__)
#define UEMCP_WARN(Format, ...)    UE_LOG(LogUEMCP, Warning, TEXT(Format), ##__VA_ARGS__)
#define UEMCP_ERROR(Format, ...)   UE_LOG(LogUEMCP, Error,   TEXT(Format), ##__VA_ARGS__)
#define UEMCP_VERBOSE(Format, ...) UE_LOG(LogUEMCP, Verbose, TEXT(Format), ##__VA_ARGS__)
