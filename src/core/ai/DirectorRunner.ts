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

export async function runBackendDirector(
  opts: DirectorRunOptions,
  ctx: ToolContext,
  registry: ToolRegistry,
  writeNames: Set<string>,
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
          case 'improving':
            opts.events?.onActivity?.(`Critique quality review (Iter ${ev.iteration})…`);
            break;
          case 'tool_calls': {
            const calls = ev.data ?? [];
            opts.events?.onActivity?.(`Executing ${calls.length} production steps…`);
            for (const call of calls) {
              if (opts.signal.aborted) throw new AiError('cancelled', 'Cancelled.');
              opts.events?.onToolStart?.({ id: call.id ?? `dir_${toolCallCount}`, name: call.name, args: call.args });
              toolCallCount++;
              const result = await registry.execute(call.name, call.args, ctx);
              opts.events?.onToolEnd?.({ id: call.id ?? `dir_${toolCallCount}`, name: call.name, args: call.args }, result.ok, result.content);
              if (result.ok && writeNames.has(call.name)) {
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
