// Hive's extension for Pi, loaded per run with `-e`; nothing global changes.
//
// - Access modes: Pi runs every tool unasked, leaving permissions to
//   extensions. A `tool_call` the run's mode (HIVE_PI_ACCESS) doesn't cover is
//   put to Hive as a `confirm` dialog titled APPROVAL, its message the call as
//   JSON; Hive asks the user and answers. Declined, the call is blocked.
// - Hive's MCP server (HIVE_PI_MCP: { name, command, args, env, timeoutMs }):
//   launched over stdio, its tools registered as `mcp__<name>__<tool>`.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APPROVAL = "hive:approval";
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const EDITS = new Set(["edit", "write"]);

function json(name) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : undefined;
  } catch {
    return undefined;
  }
}

export default async function hive(pi) {
  const access = process.env.HIVE_PI_ACCESS || "full-access";
  const mcp = json("HIVE_PI_MCP");
  const prefix = mcp ? `mcp__${mcp.name}__` : undefined;

  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    if (access === "full-access" || READ_ONLY.has(tool)) return;
    if (prefix && tool.startsWith(prefix)) return;
    if (access === "auto-accept-edits" && EDITS.has(tool)) return;
    const approved = await ctx.ui.confirm(
      APPROVAL,
      JSON.stringify({ tool, input: event.input ?? {} }),
      { signal: ctx.signal },
    );
    if (!approved) return { block: true, reason: "The user did not allow this." };
  });

  if (!mcp) return;

  let child;
  let nextId = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const request of [...pending.values()]) request.reject(error);
  };
  const close = () => {
    fail(new Error("Hive's MCP server closed"));
    child?.kill();
    child = undefined;
  };
  const write = (message) => child?.stdin.write(JSON.stringify(message) + "\n");

  function rpc(method, params, signal, timeoutMs = 15_000) {
    if (!child?.stdin.writable) return Promise.reject(new Error("Hive's MCP server isn't running"));
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
      };
      const abort = () => {
        write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
        done();
        reject(new Error("Cancelled"));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Hive's ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { done(); resolve(value); },
        reject: (error) => { done(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  function start() {
    close();
    child = spawn(mcp.command, mcp.args ?? [], {
      env: { ...process.env, ...(mcp.env ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const owned = child;
    const failed = (error) => { if (child === owned) fail(error); };
    child.on("error", failed);
    child.on("exit", () => failed(new Error("Hive's MCP server exited")));
    child.stdin.on("error", failed);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(message.error.message ?? "MCP error"));
      else request.resolve(message.result);
    });
  }

  async function connect() {
    if (child?.stdin.writable) return;
    start();
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hive-pi", version: "1" },
    });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  let tools = [];
  try {
    await connect();
    tools = (await rpc("tools/list", {}))?.tools ?? [];
  } catch {
    close();
  }
  for (const tool of tools) {
    const schema = tool.inputSchema ?? { type: "object" };
    pi.registerTool({
      name: prefix + tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: { ...schema, type: schema.type ?? "object", properties: schema.properties ?? {} },
      async execute(_id, args, signal) {
        await connect();
        const result = await rpc("tools/call", { name: tool.name, arguments: args ?? {} }, signal, mcp.timeoutMs);
        const content = [];
        for (const part of result?.content ?? []) {
          if (part?.type === "text") content.push({ type: "text", text: part.text });
          else if (part?.type === "image") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
        }
        if (content.length === 0) content.push({ type: "text", text: JSON.stringify(result?.structuredContent ?? result ?? null) });
        if (result?.isError) {
          throw new Error(content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || `${tool.name} failed`);
        }
        return { content, details: result?.structuredContent ?? {} };
      },
    });
  }
  pi.on("session_shutdown", close);
  process.once("exit", close);
}
