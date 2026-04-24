# Configuration & Connection Manager

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)

## Configuration Design

### Claude Code (.mcp.json)

**Project A** (primary target — shorter timeout):
```json
{
  "unreal": {
    "command": "node",
    "args": ["D:/DevTools/UEMCP/server/server.mjs"],
    "env": {
      "UNREAL_PROJECT_ROOT": "path/to/YourProject",
      "UNREAL_PROJECT_NAME": "YourProject",
      "UNREAL_TCP_PORT_EXISTING": "55557",
      "UNREAL_TCP_PORT_CUSTOM": "55558",
      "UNREAL_TCP_TIMEOUT_MS": "5000",
      "UNREAL_RC_PORT": "30010",
      "UNREAL_AUTO_DETECT": "true"
    }
  }
}
```

**Project B** (secondary target — longer timeout for heavier asset loads):
```json
{
  "unreal": {
    "command": "node",
    "args": ["D:/DevTools/UEMCP/server/server.mjs"],
    "env": {
      "UNREAL_PROJECT_ROOT": "path/to/OtherProject",
      "UNREAL_PROJECT_NAME": "OtherProject",
      "UNREAL_TCP_PORT_EXISTING": "55557",
      "UNREAL_TCP_PORT_CUSTOM": "55558",
      "UNREAL_TCP_TIMEOUT_MS": "30000",
      "UNREAL_RC_PORT": "30010",
      "UNREAL_AUTO_DETECT": "true"
    }
  }
}
```

### Cowork (claude_desktop_config.json)

Same structure as above but with per-project prefixed keys (e.g. `unreal-<project>`).

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `UNREAL_PROJECT_ROOT` | (required) | Absolute path to project directory (contains .uproject) |
| `UNREAL_PROJECT_NAME` | (from .uproject) | Human-readable project name for auto-detection matching |
| `UNREAL_TCP_PORT_EXISTING` | `55557` | Port for existing UnrealMCP plugin |
| `UNREAL_TCP_PORT_CUSTOM` | `55558` | Port for new UEMCP plugin |
| `UNREAL_TCP_TIMEOUT_MS` | `5000` | TCP socket timeout per command |
| `UNREAL_RC_PORT` | `30010` | Remote Control API HTTP port |
| `UNREAL_AUTO_DETECT` | `true` | Enable process-based auto-detection |

---

## Connection Manager Design

```javascript
class ConnectionManager {
  constructor(config) {
    this.projectRoot = config.projectRoot;
    this.projectName = config.projectName;
    this.existingTcpPort = config.existingTcpPort || 55557;
    this.customTcpPort = config.customTcpPort || 55558;
    this.rcPort = config.rcPort || 30010;
    this.tcpTimeout = config.tcpTimeoutMs || 5000;
    this.autoDetect = config.autoDetect !== false;

    // Lazy state — null means "never tried"
    this.existingTcpStatus = null;  // null | "connected" | "unavailable"
    this.customTcpStatus = null;
    this.rcStatus = null;
    this.detectedProject = null;

    // Debounce
    this.lastExistingTcpAttempt = 0;
    this.lastCustomTcpAttempt = 0;
    this.lastRcAttempt = 0;
    this.lastDetection = 0;
    this.RETRY_INTERVAL = 10_000;     // 10 seconds between retries
    this.DETECTION_TTL = 30_000;      // 30 seconds detection cache
  }

  async detectProject() { /* PowerShell → WMIC → null */ }
  async ensureExistingTcp() { /* lazy connect to 55557 */ }
  async ensureCustomTcp() { /* lazy connect to 55558 */ }
  async ensureRc() { /* lazy connect to 30010 */ }
  async sendExistingTcpCommand(type, params) { /* existing plugin */ }
  async sendCustomTcpCommand(type, params) { /* new plugin */ }
  async sendRcRequest(method, path, body) { /* HTTP to RC API */ }
}
```

### Error Behavior

| Scenario | Tool Response |
|----------|---------------|
| Editor not running | "Editor not connected. Start Unreal Editor with [project] to use this tool. Offline tools are available." |
| Existing plugin not loaded | "UnrealMCP plugin not responding on port 55557. Ensure the plugin is enabled in your project." |
| Custom plugin not loaded | "UEMCP plugin not responding on port 55558. Ensure the plugin is enabled in your project." |
| RC API not enabled | "Remote Control API not available on port 30010. Enable the plugin in Edit > Plugins." |
| Wrong project detected | "Detected [OtherProject] but expected [ThisProject]. Is the correct editor open?" |
| Both editors running | Uses UNREAL_PROJECT_ROOT to filter process list to the correct one. |

---

