/**
 * The tool registry — the single source of truth for what the AI can do.
 *
 * Definitions (schema + description) live in `tools/`; the host binds handlers
 * at boot via `register`. Nothing else in the codebase may describe a tool, so
 * the schema cannot drift between providers, the editor, and the backend.
 */

import type { AiTool, AiToolDef, ToolContext, ToolKind, ToolResult } from './types';
import { validate } from './schema';

/**
 * Argument fields that name a layer, and therefore may carry an alias.
 *
 * Resolution happens HERE, once, rather than in each handler. A handler that
 * forgot to resolve would fail only for library-emitted batches and only
 * sometimes — the worst possible failure shape. The list is explicit rather than
 * "any field ending in Id" so a genuine string id (an `effectId`, an `assetId`)
 * is never accidentally rewritten.
 */
const NODE_REF_FIELDS = [
  'nodeId', 'parentId', 'parent', 'layerId', 'sourceId', 'pathNodeId', 'matteNodeId', 'cameraId',
] as const;
const NODE_REF_ARRAY_FIELDS = ['nodeIds', 'layerIds'] as const;

/** Rewrite alias handles to real engine ids, recursively through arrays of objects. */
function resolveAliases(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveAliases(v, aliases));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of NODE_REF_FIELDS) {
    const v = out[field];
    if (typeof v === 'string') out[field] = aliases.get(v) ?? v;
  }
  for (const field of NODE_REF_ARRAY_FIELDS) {
    const v = out[field];
    if (Array.isArray(v)) out[field] = v.map((id) => (typeof id === 'string' ? aliases.get(id) ?? id : id));
  }
  // Nested batches — `set_keyframes.keyframes[]`, `set_easing.targets[]` — each
  // carry their own nodeId, so the walk has to go down.
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) out[k] = resolveAliases(v, aliases);
  }
  return out;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AiTool<never>>();

  register<I>(tool: AiTool<I>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate AI tool '${tool.name}'`);
    }
    this.tools.set(tool.name, tool as unknown as AiTool<never>);
  }

  /** Wire-facing definitions, for the provider emitters. */
  list(filter?: { kind?: ToolKind }): AiToolDef[] {
    const out: AiToolDef[] = [];
    for (const t of this.tools.values()) {
      if (filter?.kind && t.kind !== filter.kind) continue;
      out.push({ name: t.name, description: t.description, kind: t.kind, inputSchema: t.inputSchema });
    }
    return out;
  }

  get(name: string): AiToolDef | undefined {
    const t = this.tools.get(name);
    return t && { name: t.name, description: t.description, kind: t.kind, inputSchema: t.inputSchema };
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Validate + fill defaults without running anything. */
  coerce(name: string, raw: unknown): { ok: true; input: unknown } | { ok: false; errors: string[] } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, errors: [`Unknown tool '${name}'. Available: ${[...this.tools.keys()].join(', ')}`] };
    }
    const r = validate(tool.inputSchema, raw ?? {});
    return r.ok ? { ok: true, input: r.value } : { ok: false, errors: r.errors };
  }

  /**
   * Run a tool. **Never throws** — a thrown handler would abort the agent loop,
   * when what we want is to hand the model the failure and let it try again.
   */
  async execute(name: string, raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `Unknown tool '${name}'. Available: ${[...this.tools.keys()].join(', ')}` };
    }
    const coerced = this.coerce(name, raw);
    if (!coerced.ok) {
      return { ok: false, content: `Invalid arguments for ${name}:\n- ${coerced.errors.join('\n- ')}` };
    }
    // Alias → real id, after validation (so the schema still sees the handle the
    // caller wrote) and before the handler (so no handler ever sees a handle).
    //
    // Optional-chained deliberately. `aliases` is part of the ToolContext
    // contract, but contexts are built by HOSTS — the renderer, the Electron
    // main process, the backend, and every test fixture. A hard read here turns
    // "this host has not adopted aliases yet" into a crash inside the agent
    // loop, which is precisely the failure mode `execute` promises never to have.
    const aliases = ctx.aliases;
    const input = aliases?.size ? resolveAliases(coerced.input, aliases) : coerced.input;
    try {
      return await tool.handler(input as never, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `${name} failed: ${message}` };
    }
  }
}
