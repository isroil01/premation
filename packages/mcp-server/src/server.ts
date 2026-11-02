/**
 * premation-mcp — the MCP server Claude Desktop and Claude Code launch.
 *
 * docs/MCP_PLAN.md §3.1. A thin adapter with no editing logic:
 *
 *   tools/list   the tool surface from `@motion/ai-tools` (the same vocabulary
 *                the in-app assistant uses, filtered by `mcpToolDefs`). Static,
 *                so Claude sees every tool even when Premation is closed.
 *   tools/call   forwarded over the local pipe to the running app, whose editor
 *                page runs it through the engine; the answer comes back as is.
 *
 * It runs as Node inside the installed app's own binary
 * (`ELECTRON_RUN_AS_NODE=1 Premation.exe premation-mcp.cjs`), so a user needs
 * no Node.js. `PREMATION_MCP_DIR` points at `<userData>/mcp`, where the app
 * keeps the pipe address and the token.
 *
 * stdout is the MCP channel and nothing else may write to it; diagnostics go
 * to stderr (Claude keeps them in its MCP log) and to `server.log` beside the
 * token — the tool names and outcomes, never arguments or project content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_SERVER_INSTRUCTIONS } from '@motion/ai-tools';
import { listTools } from './tools';
import { PipeClient, PremationUnavailable, NOT_SET_UP, type McpToolResult } from './pipeClient';
import { PREMATION_PROMPTS, findPrompt } from './prompts';

declare const __PREMATION_VERSION__: string;
const VERSION = typeof __PREMATION_VERSION__ === 'string' ? __PREMATION_VERSION__ : '0.0.0-dev';

const LOG_LIMIT = 1024 * 1024;

function makeLogger(dir: string | undefined): (line: string) => void {
  const file = dir ? path.join(dir, 'server.log') : null;
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`[premation-mcp] ${stamped}\n`);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${stamped}\n`);
    } catch { /* logging is best effort */ }
  };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const ASSET_URI = 'premation://asset/';

/** The asset id a resource uri names, or null. */
export function assetIdOf(uri: string): string | null {
  if (!uri.startsWith(ASSET_URI)) return null;
  const id = uri.slice(ASSET_URI.length).split('/')[0] ?? '';
  return id ? decodeURIComponent(id) : null;
}

/** list_assets' result as MCP resources (its `data.assets` rows ride in the text after the prose). */
export function assetResources(r: McpToolResult): Array<{ uri: string; name: string; description?: string; mimeType?: string }> {
  if (r.isError) return [];
  const text = r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
  // The data block follows the prose (which itself mentions `create_media { assetId }`): the object holding "assets".
  const key = text.indexOf('"assets"');
  const start = key < 0 ? -1 : text.lastIndexOf('{', key);
  if (start < 0) return [];
  let parsed: { assets?: Array<{ id?: unknown; name?: unknown; type?: unknown; width?: unknown; height?: unknown; duration?: unknown }> };
  try {
    parsed = JSON.parse(text.slice(start)) as typeof parsed;
  } catch {
    return [];
  }
  const mime = (type: unknown): string => (type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : 'image/*');
  return (parsed.assets ?? [])
    .filter((a) => typeof a.id === 'string' && a.id !== '')
    .map((a) => {
      const dim = typeof a.width === 'number' && typeof a.height === 'number' ? ` ${a.width}×${a.height}` : '';
      const dur = typeof a.duration === 'number' ? ` ${a.duration.toFixed(1)}s` : '';
      return {
        uri: `${ASSET_URI}${encodeURIComponent(String(a.id))}`,
        name: typeof a.name === 'string' ? a.name : String(a.id),
        description: `${String(a.type ?? 'media')}${dim}${dur} — read for its metadata and contact sheet; place with create_media.`,
        mimeType: mime(a.type),
      };
    });
}

export async function main(): Promise<void> {
  const dir = process.env.PREMATION_MCP_DIR;
  const log = makeLogger(dir);
  const known = new Set(listTools().tools.map((t) => t.name));

  const server = new Server(
    { name: 'premation', title: 'Premation', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const pipe = dir ? new PipeClient({ dir, client: () => server.getClientVersion(), log }) : null;

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());

  // The open project's imported media as read-only resources (premation://asset/<id>):
  // the list and each description come from the app's own tools over the pipe,
  // so a client that browses resources sees exactly what list_assets / describe_asset say.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if (!pipe) return { resources: [] };
    try {
      const r = await pipe.call('list_assets', {});
      return { resources: assetResources(r) };
    } catch {
      return { resources: [] };
    }
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const id = assetIdOf(req.params.uri);
    if (!id) throw new Error(`Unknown resource '${req.params.uri}'. Premation lists its assets as premation://asset/<id>.`);
    if (!pipe) throw new Error(NOT_SET_UP);
    const r = await pipe.call('describe_asset', { assetId: id, cells: 6 });
    const text = r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text || `Premation could not describe asset ${id}.`);
    const image = r.content.find((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image');
    return {
      contents: [
        { uri: req.params.uri, mimeType: 'text/plain', text },
        ...(image ? [{ uri: `${req.params.uri}/sheet.png`, mimeType: image.mimeType, blob: image.data }] : []),
      ],
    };
  });

  // Ready-made workflows (prompts.ts): Claude Desktop lists them in its + menu.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PREMATION_PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = findPrompt(req.params.name);
    if (!p) throw new Error(`Unknown prompt '${req.params.name}'.`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    return { description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.build(args) } }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!known.has(name)) return errorResult(`Unknown tool '${name}'. Call tools/list for the tools Premation offers.`);
    if (!pipe) return errorResult(NOT_SET_UP);
    const started = Date.now();
    try {
      const result = await pipe.call(name, args ?? {});
      log(`${name} ${result.isError ? 'failed' : 'ok'} ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      const message = err instanceof PremationUnavailable ? err.message : `Premation could not run ${name}: ${err instanceof Error ? err.message : String(err)}`;
      log(`${name} unavailable: ${message}`);
      return errorResult(message);
    }
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => pipe?.close();
  await server.connect(transport);
  log(`started ${VERSION}${dir ? '' : ' (no PREMATION_MCP_DIR — not configured by Premation)'}`);
}

export { listTools };

// Always start, except when the build script imports the bundle for listTools.
// Not `require.main === module`: Claude Desktop's built-in Node loads the
// extension entry through its own wrapper, where that is false and the server
// would never answer `initialize`.
if (process.env.PREMATION_MCP_NO_MAIN !== '1') {
  main().catch((err: unknown) => {
    process.stderr.write(`[premation-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
