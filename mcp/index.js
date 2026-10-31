#!/usr/bin/env node
// Minimal MCP stdio server wrapping the NotesToGO local HTTP API.
// Newline-delimited JSON-RPC 2.0 over stdio.

const PORT = process.env.NOTESTODO_PORT || "17893";
const TOKEN = process.env.NOTESTODO_TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;

if (!TOKEN) {
  console.error("[notestodo-mcp] NOTESTODO_TOKEN env var is required. Set it in your MCP client config (must match the app's api_token setting).");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const TOOLS = [
  {
    name: "list_todos",
    description: "List all todos from NotesToGO",
    inputSchema: { type: "object", properties: {} },
    handler: () => api("GET", "/todos"),
  },
  {
    name: "add_todo",
    description: "Add a new todo",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Todo title" } },
      required: ["title"],
    },
    handler: ({ title }) => api("POST", "/todos", { title }),
  },
  {
    name: "complete_todo",
    description: "Mark a todo as completed",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Todo id" } },
      required: ["id"],
    },
    handler: ({ id }) => api("PATCH", `/todos/${encodeURIComponent(id)}`, { completed: true }),
  },
  {
    name: "delete_todo",
    description: "Delete a todo",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Todo id" } },
      required: ["id"],
    },
    handler: ({ id }) => api("DELETE", `/todos/${encodeURIComponent(id)}`),
  },
  {
    name: "list_notes",
    description: "List all notes from NotesToGO",
    inputSchema: { type: "object", properties: {} },
    handler: () => api("GET", "/notes"),
  },
  {
    name: "create_note",
    description: "Create a new note",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title" },
        body_md: { type: "string", description: "Note body in Markdown" },
      },
      required: ["title"],
    },
    handler: ({ title, body_md }) => api("POST", "/notes", body_md !== undefined ? { title, body_md } : { title }),
  },
  {
    name: "get_note",
    description: "Get a note by id",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Note id" } },
      required: ["id"],
    },
    handler: ({ id }) => api("GET", `/notes/${encodeURIComponent(id)}`),
  },
];

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "notestodo", version: "0.1.0" };

function ok(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function err(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
function textResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "initialized":
      return null; // notification, no response
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return ok(id, textResult(await tool.handler(params.arguments ?? {})));
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return null;
      return err(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resp = await handle(msg);
    if (resp !== null) process.stdout.write(resp + "\n");
  }
});
