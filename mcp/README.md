# NotesToGO MCP Server

Zero-dependency MCP stdio server (Node 18+, pure ESM) that wraps the NotesToGO local HTTP API as MCP tools, for clients like Claude Desktop and Raycast.

## Tools

| Tool | Description |
|---|---|
| `list_todos` | List all todos |
| `add_todo(title)` | Add a todo |
| `complete_todo(id)` | Mark a todo completed |
| `delete_todo(id)` | Delete a todo |
| `list_notes` | List all notes |
| `create_note(title, body_md?)` | Create a note |
| `get_note(id)` | Get a note by id |

## Prerequisites

- The NotesToGO app running with its local HTTP API enabled (`settings.api_enabled`), default port `17893`.
- The API token (`settings.api_token` in the app).
- Node.js 18 or later.

## Environment variables

- `NOTESTODO_TOKEN` (required): Bearer token, must match the app's `api_token`.
- `NOTESTODO_PORT` (optional): API port, default `17893`.

## Claude Desktop configuration

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "notestodo": {
      "command": "node",
      "args": ["/Users/fangchen/Baidu/GitHub/Notes&ToDo/mcp/index.js"],
      "env": {
        "NOTESTODO_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

If the app runs on a non-default port, add `"NOTESTODO_PORT": "<port>"` to `env`.

Restart Claude Desktop after saving. The 7 tools above will be available to the assistant.
