// MCP permission-prompt server for CLI seats (claude CLI headless mode).
//
// Claude Code in -p print mode has no terminal to ask "allow this file
// write?" on. Its documented escape hatch is --permission-prompt-tool: every
// permission request is sent to a named MCP tool, whose JSON answer allows or
// denies the action. This file IS that tool. Roundtable's provider layer
// (electron/providers.js callCli) writes a temp --mcp-config that spawns this
// script with Electron-as-Node, and the script forwards each request to the
// approval broker in Roundtable's main process over localhost HTTP — which
// pops the in-app approval modal and returns the user's decision.
//
//   claude CLI ──MCP stdio──▶ this script ──HTTP──▶ main.js broker ──IPC──▶ modal
//
// SECURITY: fail CLOSED. Any error (broker unreachable, bad token, timeout,
// malformed anything) returns behavior:"deny" — a write must never slip
// through because plumbing broke. stdout is the MCP protocol channel; never
// write logs to it (stderr is fine and lands in the CLI's stderr capture).
//
// Env (set per spawn by providers.js): RT_APPROVAL_URL, RT_APPROVAL_TOKEN,
// RT_AGENT_NAME.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const URL_ = process.env.RT_APPROVAL_URL || '';
const TOKEN = process.env.RT_APPROVAL_TOKEN || '';
const AGENT = process.env.RT_AGENT_NAME || 'CLI seat';

const deny = (message) => ({ behavior: 'deny', message });

async function askRoundtable(toolName, input) {
  if (!URL_ || !TOKEN) return deny('Roundtable approval broker not configured.');
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rt-token': TOKEN },
      body: JSON.stringify({ tool_name: toolName, input, agentName: AGENT }),
      // The broker itself auto-denies after 90s; this is a safety margin.
      signal: AbortSignal.timeout(100000),
    });
    if (!res.ok) return deny(`Roundtable approval broker refused (HTTP ${res.status}).`);
    const decision = await res.json();
    if (decision && decision.behavior === 'allow') {
      // updatedInput is REQUIRED on allow per the permission-prompt contract;
      // we always pass the original input through unmodified.
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input ?? {} };
    }
    return deny(decision?.message || 'Declined in Roundtable.');
  } catch (e) {
    return deny(`Could not reach Roundtable for approval: ${e.message}`);
  }
}

async function main() {
  const server = new McpServer({ name: 'rtapproval', version: '1.0.0' });
  server.tool(
    'approve',
    'Forwards a Claude Code permission request to the Roundtable user for an in-app allow/deny decision.',
    {
      tool_name: z.string(),
      input: z.record(z.any()).optional(),
      tool_use_id: z.string().optional(),
    },
    async ({ tool_name, input }) => {
      const decision = await askRoundtable(tool_name, input || {});
      return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
    },
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`rtapproval fatal: ${e.message}\n`);
  process.exit(1);
});
