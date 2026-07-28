/**
 * DirectorRunner — bridges motion-back's multi-director pipeline (/ai/director/run)
 * to the editor's live document execution engine.
 */

import { ToolRegistry, type ToolContext } from '@motion/ai-tools';
import { apiBaseUrl, getToken, type GatewayProviderId } from '@core/api/client';
import { AiError } from './AgentLoop';
import type { AgentEvents } from './AgentLoop';

export interface DirectorRunOptions {
  provider: GatewayProviderId;
  model: string;
  prompt: string;
  projectId?: string;
  conversationId?: string;
  signal: AbortSignal;
  events?: AgentEvents;
}

export interface DirectorRunResult {
  ok: boolean;
  toolCallCount: number;
  changes: string[];
}

/**
 * A tool's schema with nested prose removed — everything the validator actually
 * enforces, nothing it doesn't.
 *
 * The full catalogue is ~10.7k tokens and the planner sends it once per chunk,
 * which on a modest per-minute token limit is enough to 429 the run on its own.
 * Dropping per-property `description` strings takes it to ~7k while keeping
 * property names, `type`, `enum`, `required`, `additionalProperties`, and the
 * numeric bounds — i.e. every rule a call can be rejected for. The tool's own
 * top-level description stays, since that is what drives tool *selection*.
 */
function enforceableSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'description') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, enforceableSchema(v)]),
      );
    } else if (key === 'items') {
      out[key] = enforceableSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function runBackendDirector(
  opts: DirectorRunOptions,
  ctx: ToolContext,
  registry: ToolRegistry,
  writeNames: Set<string>,
  /**
   * Classify each executed call for the run's compose-ratio tally. Passed in
   * rather than computed here so a director run and a direct-loop run land in
   * the same counter — the whole point of the metric is comparing them.
   */
  tally?: (toolName: string) => void,
): Promise<DirectorRunResult> {
  const token = getToken();
  if (!token) throw new AiError('auth', 'Sign in to run the AI director pipeline.');

  const comp = ctx.comp.get();
  const layers = ctx.scene.all().map((n: any) => ({
    id: n.id,
    name: n.name,
    type: n.kind,
    visible: n.visible !== false,
    locked: n.locked === true,
    timeRange: { startMs: 0, endMs: Math.round(comp.durationSeconds * 1000) },
    bounds: { x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.width ?? 100), height: Math.round(n.height ?? 100) },
    ...(n.text !== undefined ? { content: n.text } : {}),
  }));

  const payload = {
    provider: opts.provider,
    model: opts.model,
    prompt: opts.prompt,
    projectId: opts.projectId,
    conversationId: opts.conversationId,
    // The backend's ToolPlanner needs to know what this editor can actually
    // run. It used to carry its own hardcoded copy of that list, which had
    // drifted to eleven camelCase names against a registry of forty-five
    // snake_case ones — so every plan it wrote was unexecutable. Sending the
    // live registry deletes the copy that can drift.
    // `inputSchema` is NOT optional in practice. Sending names alone was
    // measured live: the planner emitted 45 correctly-named calls and 39 were
    // rejected, because it had to invent argument names and every tool sets
    // `additionalProperties: false`. Names tell it what exists; schemas tell it
    // how to call them, and only the second is enforceable.
    toolCatalog: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: enforceableSchema(t.inputSchema),
    })),
    sceneSnapshot: {
      durationMs: Math.round(comp.durationSeconds * 1000),
      resolution: { x: comp.width, y: comp.height },
      fps: comp.fps,
      layers,
      playheadMs: Math.round(ctx.comp.playhead() * 1000),
    },
  };

  const res = await fetch(`${apiBaseUrl()}/ai/director/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new AiError('backend_unavailable', `Director backend returned ${res.status}`);
  }

  if (!res.body) {
    throw new AiError('bad_response', 'Empty body from director endpoint.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallCount = 0;
  const changes: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';

      for (const block of lines) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        let ev: any;
        try {
          ev = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        switch (ev.type) {
          case 'intent_resolved':
            opts.events?.onActivity?.('Analyzing intent…');
            break;
          case 'director_start':
            opts.events?.onActivity?.(`Directing ${ev.director} visual style…`);
            break;
          case 'scene_composed':
            opts.events?.onActivity?.('Composing multi-scene layout…');
            break;
          case 'animation_composed':
            opts.events?.onActivity?.('Planning cameras & motion physics…');
            break;
          case 'planning':
            // The plan is now translated in chunks, so there is real progress
            // to show. Previously this stage was several silent minutes with a
            // spinner, next to a fallback path that streamed its tool calls.
            opts.events?.onActivity?.(`Writing production steps… (${ev.done}/${ev.total})`);
            break;
          case 'improving':
            opts.events?.onActivity?.(`Critique quality review (Iter ${ev.iteration})…`);
            break;
          case 'tool_calls': {
            const calls = ev.data ?? [];
            opts.events?.onActivity?.(`Executing ${calls.length} production steps…`);
            // The backend's ToolCall names the tool in `tool`; this read `name`,
            // which is always undefined on that payload. Every director call
            // would have executed as `undefined` — a second, independent reason
            // no director-authored frame has ever rendered, hidden behind the
            // truncation bug that stopped plans arriving at all. Accept both:
            // `tool` is the wire contract, `name` keeps any other producer working.
            for (const call of calls) {
              if (opts.signal.aborted) throw new AiError('cancelled', 'Cancelled.');
              const toolName: string | undefined = call.tool ?? call.name;
              const id = call.id ?? `dir_${toolCallCount}`;
              if (!toolName) {
                // Skip rather than execute `undefined` — one malformed entry
                // should not abort a plan the directors spent minutes building.
                // eslint-disable-next-line no-console
                console.warn('[ai] director emitted a tool call with no tool name:', call);
                continue;
              }
              opts.events?.onToolStart?.({ id, name: toolName, args: call.args });
              toolCallCount++;
              tally?.(toolName);
              const result = await registry.execute(toolName, call.args, ctx);
              opts.events?.onToolEnd?.({ id, name: toolName, args: call.args }, result.ok, result.content);
              if (result.ok && writeNames.has(toolName)) {
                changes.push(result.content);
              }
            }
            break;
          }
          case 'finish':
            opts.events?.onActivity?.('Finalizing production sequence…');
            break;
          case 'error':
            throw new AiError(ev.code ?? 'unknown', ev.message ?? 'Director run error');
        }
      }
    }
  } catch (err) {
    if (opts.signal.aborted) throw new AiError('cancelled', 'Cancelled.');
    throw err;
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  return { ok: true, toolCallCount, changes };
}
