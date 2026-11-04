#include "UEMCPEditorIdentity.h"
#include "HAL/PlatformProcess.h"
#include "Misc/Paths.h"

void UUEMCPEditorIdentity::Publish(int32 TcpPort)
{
	UUEMCPEditorIdentity* Object = GetMutableDefault<UUEMCPEditorIdentity>();
	Object->Identity.ProjectFile = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
	Object->Identity.ProcessId = FPlatformProcess::GetCurrentProcessId();
	Object->Identity.TcpPort = TcpPort;
}
