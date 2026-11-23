// Copyright Noah Butcher. All Rights Reserved.
#pragma once

namespace UEMCP
{
	class FMCPCommandRegistry;
	namespace GraphActionAuthoring
	{
		void Register(FMCPCommandRegistry& Registry);
		void Shutdown();
	}
}
