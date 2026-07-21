/**
 * The tool registry — the single source of truth for what the AI can do.
 *
 * Definitions (schema + description) live in `tools/`; the host binds handlers
 * at boot via `register`. Nothing else in the codebase may describe a tool, so
 * the schema cannot drift between providers, the editor, and the backend.
 */

import type { AiTool, AiToolDef, ToolContext, ToolKind, ToolResult } from './types';
import { validate } from './schema';

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
    try {
      return await tool.handler(coerced.input as never, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `${name} failed: ${message}` };
    }
  }
}
