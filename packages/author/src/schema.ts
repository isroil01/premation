/**
 * The response shapes of the four author calls.
 *
 * These are HINTS, deliberately loose. The author calls ask for JSON in text
 * (so a long beat chunk can be salvaged when it is cut off — a structured
 * tool-use answer cut off is lost whole), and `coerce.ts` validates whatever
 * comes back. The prompt carries a sketch generated from these schemas
 * (`shapeHint`), so the shape the model is told and the shape coercion reads
 * cannot drift apart.
 */

import type { JsonSchema } from '@motion/ai-tools';

const KEYS: JsonSchema = {
  type: 'object',
  description: 'prop → [{ t, v, ease?, bezier? }], at least two keys per animated prop. t is beat-local seconds.',
};

export const LAYER_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'name'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    parent: { type: 'string' },
    role: { type: 'string', enum: ['hero', 'support', 'ui', 'ambient', 'background'] },
    stack: { type: 'string', enum: ['back', 'front'], description: 'globals only' },
    inSec: { type: 'number' },
    outSec: { type: 'number' },
    shape: { type: 'string' },
    text: { type: 'string' },
    typeStyle: { type: 'string' },
    props: { type: 'object', description: 'static props by name' },
    matte: { type: 'object' },
    keys: KEYS,
    expressions: { type: 'object' },
    effects: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, params: { type: 'object' }, keys: KEYS } } },
    textAnimators: { type: 'array', items: { type: 'object' } },
    trim: { type: 'object' },
    repeaters: { type: 'array', items: { type: 'object' } },
    pathOps: { type: 'array', items: { type: 'object' } },
    masks: { type: 'array', items: { type: 'object' } },
    light: { type: 'object' },
    gradient: { type: 'object' },
    image: { type: 'object' },
    svg: { type: 'object' },
    video: { type: 'object' },
  },
};

export const DESIGN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['title', 'intent', 'durationSec', 'background', 'palette', 'grid', 'type', 'globals', 'beats'],
  properties: {
    title: { type: 'string' },
    intent: { type: 'string' },
    durationSec: { type: 'number' },
    background: { type: 'string' },
    palette: { type: 'object', description: 'name → hex' },
    grid: {
      type: 'object',
      properties: { columns: { type: 'number' }, gutter: { type: 'number' }, margin: { type: 'number' }, baseline: { type: 'number' } },
    },
    type: { type: 'object', description: 'style name → { family, weight, size, tracking, leading }' },
    globals: { type: 'array', items: LAYER_SCHEMA },
    beats: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['name', 'purpose', 'startSec', 'endSec'],
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string' },
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          notes: { type: 'string' },
        },
      },
    },
  },
};

export const BEATS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['beats'],
  properties: {
    beats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'layers'],
        properties: { index: { type: 'integer' }, layers: { type: 'array', items: LAYER_SCHEMA } },
      },
    },
  },
};

export const CRITIQUE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['overall', 'beats'],
  properties: {
    overall: { type: 'string' },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'verdict', 'findings'],
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'revise'] },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['problem', 'fix'],
              properties: {
                problem: { type: 'string' },
                fix: { type: 'string' },
                layers: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

export const REVISE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['layers'],
  properties: {
    name: { type: 'string' },
    purpose: { type: 'string' },
    layers: { type: 'array', items: LAYER_SCHEMA },
  },
};

/** A compact sketch of a schema for a prompt, generated so it cannot go stale. */
export function shapeHint(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || depth > 4) return '…';
  if (schema.type === 'array') return `[${shapeHint(schema.items, depth + 1)}]`;
  if (schema.type === 'object' && schema.properties) {
    const req = schema.required ?? [];
    return `{ ${Object.entries(schema.properties)
      .map(([k, v]) => `"${k}"${req.includes(k) ? '' : '?'}: ${shapeHint(v, depth + 1)}`)
      .join(', ')} }`;
  }
  if (schema.type === 'object') return schema.description ? `{ /* ${schema.description} */ }` : '{…}';
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join('|');
  return String(schema.type ?? 'any');
}

// ── Critique coercion ─────────────────────────────────────────────────

export interface CritiqueFinding {
  problem: string;
  fix: string;
  layers?: string[];
}

export interface BeatCritique {
  index: number;
  verdict: 'keep' | 'revise';
  findings: CritiqueFinding[];
}

export interface Critique {
  overall: string;
  beats: BeatCritique[];
}

/**
 * A critique that is structurally valid whatever came back. A beat the
 * critic did not mention is kept; a "revise" with no finding is kept too —
 * a revision with nothing to fix would only re-roll the beat.
 */
export function coerceCritique(raw: unknown, beatCount: number): Critique {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const beats: BeatCritique[] = [];
  const seen = new Set<number>();
  for (const b of Array.isArray(o.beats) ? o.beats : []) {
    if (!b || typeof b !== 'object') continue;
    const r = b as Record<string, unknown>;
    const index = typeof r.index === 'number' ? Math.round(r.index) : -1;
    if (index < 0 || index >= beatCount || seen.has(index)) continue;
    seen.add(index);
    const findings = (Array.isArray(r.findings) ? r.findings : [])
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({
        problem: String(f.problem ?? '').trim(),
        fix: String(f.fix ?? '').trim(),
        ...(Array.isArray(f.layers) ? { layers: f.layers.map(String) } : {}),
      }))
      .filter((f) => f.problem);
    beats.push({ index, verdict: r.verdict === 'revise' && findings.length ? 'revise' : 'keep', findings });
  }
  for (let i = 0; i < beatCount; i++) if (!seen.has(i)) beats.push({ index: i, verdict: 'keep', findings: [] });
  beats.sort((a, b) => a.index - b.index);
  return { overall: typeof o.overall === 'string' ? o.overall.trim() : '', beats };
}
