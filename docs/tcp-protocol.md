# TCP Protocol Reference — Existing UnrealMCP Plugin (port 55557)

> Reverse-engineered from `UnrealMCP/Source/UnrealMCP/Private/MCPServerRunnable.cpp` and `unreal-mcp-main/Python/unreal_mcp_server.py`. This documents the **existing** plugin's protocol that UEMCP Phase 2 must match exactly.

## Connection Model

**One connection per command.** The Python server reconnects for every command (line 128: "Unreal closes the connection after each command"). The plugin's `Run()` method handles the initial connection path — it accepts a client, processes one recv buffer, sends a response, then loops back to waiting for a new connection.

There is a second code path (`HandleClientConnection` → `ProcessMessage`) that supports persistent connections with newline-delimited framing and message buffering. The Python server does **not** use this path — it sends without a newline terminator (line 149: "Send without newline, exactly like Unity") and reads until it has valid JSON, not until a newline.

**For UEMCP Phase 2**: Match the Python server's behavior — connect, send, receive, close. One connection per command. This is the path that's been tested in production.

## Request Format

```json
{"type": "command_name", "params": {"key": "value"}}
```

- **Field name is `type`**, not `command`. The `Run()` code path checks `TryGetStringField(TEXT("type"), CommandType)` (line 84). The `ProcessMessage` path checks `"command"` but that path isn't used.
- **`params` is required** but can be `{}`. The `Run()` path calls `GetObjectField(TEXT("params"))` without a null check (line 87) — if params is missing, it will crash or return null.
- **No newline terminator** on the request. The Python server sends raw JSON via `socket.sendall(json.dumps(command_obj).encode('utf-8'))` with no trailing `\n`.
- **Encoding**: UTF-8.

## Response Format

The response is a JSON object. No newline terminator. Format varies by command but follows two patterns:

**Success**:
```json
{"status": "success", ...command-specific fields...}
```

**Error (format 1)**:
```json
{"status": "error", "error": "description", "message": "description"}
```

**Error (format 2)**:
```json
{"success": false, "error": "description"}
```

Both error formats exist across different command handlers. The Python server normalizes both (lines 162–176).

## Framing

There is **no framing protocol**. No length prefix, no delimiter. The Python server determines response completeness by attempting `json.loads()` on accumulated data after each `recv()` call (line 99). If the JSON parses, the response is complete. If not, keep reading.

This works because:
1. One command per connection — no message boundary ambiguity
2. Responses are typically small (< 8KB, fits in one TCP segment)
3. 5-second `socket.timeout` as safety net

## Buffer Sizes

- Plugin receive buffer: **8192 bytes** (`MCPRecvBufferSize`, line 15)
- Plugin send/receive socket buffer: **65536 bytes** (64KB, line 56)
- Python receive buffer: **4096 bytes** per `recv()` call

## Connection Sequence

```
Node.js client                          UnrealMCP Plugin (port 55557)
     |                                           |
     |--- TCP connect --------------------------->|
     |                                           | Accept, set NoDelay, 64KB buffers
     |--- {"type":"...", "params":{...}} -------->|
     |                                           | Recv into 8KB buffer
     |                                           | Parse JSON, extract type + params
     |                                           | Dispatch to Bridge->ExecuteCommand
     |                                           | (executes on game thread via AsyncTask)
     |<-- {"status":"success", ...} --------------|
     |--- close --------------------------------->|
     |                                           | Detect zero-byte read, loop to accept
```

## Timeout Behavior

- Python server: 5-second `socket.timeout` on receive
- UEMCP plan: configurable via `UNREAL_TCP_TIMEOUT_MS` (default 5000ms for ProjectA, 30000ms for ProjectB)
- If timeout fires while chunks exist, Python tries `json.loads()` on partial data as last resort

## Known Quirks

1. **`Run()` path doesn't handle TCP fragmentation.** It does a single `Recv()` into 8KB buffer and tries to parse immediately. If a request exceeds 8KB or arrives in multiple segments, it fails silently. In practice this hasn't been a problem because requests are small JSON.

2. **No request ID.** Responses don't echo back any identifier. Since it's one-connection-per-command, there's no ambiguity about which request a response belongs to.

3. **Game thread dispatch is async.** `ExecuteCommand` uses `AsyncTask(ENamedThreads::GameThread, ...)` — the TCP thread blocks on a `TPromise` until the game thread completes the command. This means commands are naturally serialized per connection, but the game thread could stall the TCP thread if a command takes a long time.

4. **No ping/pong.** There's a `ping` command (line 221 of `UnrealMCPBridge.cpp`) but no heartbeat mechanism. Connection health is only discovered when a command fails.

5. **Error responses don't always have `error` field.** Some handlers return `{"success": false, "message": "..."}` without an `error` field. The Python server patches this (line 166).

## Commands Available on Port 55557

Grouped by handler class (from `UnrealMCPBridge::ExecuteCommand`):

**EditorCommands**: `get_actors_in_level`, `find_actors_by_name`, `spawn_actor`, `create_actor`, `delete_actor`, `set_actor_transform`, `get_actor_properties`, `set_actor_property`, `spawn_blueprint_actor`, `focus_viewport`, `take_screenshot`

**BlueprintCommands**: `create_blueprint`, `add_component_to_blueprint`, `set_component_property`, `set_physics_properties`, `compile_blueprint`, `set_blueprint_property`, `set_static_mesh_properties`, `set_pawn_properties`

**BlueprintNodeCommands**: `connect_blueprint_nodes`, `add_blueprint_get_self_component_reference`, `add_blueprint_self_reference`, `find_blueprint_nodes`, `add_blueprint_event_node`, `add_blueprint_input_action_node`, `add_blueprint_function_node`, `add_blueprint_get_component_node`, `add_blueprint_variable`

**ProjectCommands**: `create_input_mapping`

**UMGWidgetCommands**: `create_umg_widget_blueprint`, `add_text_block_to_widget`, `add_button_to_widget`, `bind_widget_event`, `set_text_binding`, `add_widget_to_viewport`

**Utility**: `ping`
