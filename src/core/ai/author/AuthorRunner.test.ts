/**
 * A whole author run against a scripted model.
 *
 * The transport is scripted (`setTransportOverride`); everything above it is
 * real: the Anthropic stream parser, `askJson`'s truncation handling, the
 * package's coercion and compiler, the registry's schema validation. The
 * scene is a recording registry rather than the engine (the engine-backed
 * run is the eval harness's job), so what is asserted is the RUN: which calls
 * were made, in what order, and what a revision sends.
 */

import { ALL_TOOL_DEFS, ToolRegistry, type AiImage, type ToolContext } from '@motion/ai-tools';
import { installScriptedTransport, type ScriptedAnswer, type SeenRequest } from '../__testHelpers__/scriptedTransport';
import { AUTHOR_STAGE_LABELS, runAuthorPipeline, type AuthorHost } from './AuthorRunner';

const COMP = { width: 1920, height: 1080, fps: 30, durationSeconds: 8, background: '#000000' };

interface Executed { name: string; args: Record<string, unknown> }

function harness(): { registry: ToolRegistry; executed: Executed[]; ctx: ToolContext } {
  const executed: Executed[] = [];
  const registry = new ToolRegistry();
  for (const d of ALL_TOOL_DEFS) {
    registry.register({ ...d, handler: (input: unknown) => { executed.push({ name: d.name, args: input as Record<string, unknown> }); return { ok: true, content: `${d.name} ok` }; } });
  }
  const ctx = { aliases: new Map<string, string>(), comp: { get: async () => COMP } } as unknown as ToolContext;
  return { registry, executed, ctx };
}

const IMG: AiImage = { mediaType: 'image/png', dataBase64: 'AAAA' };
const host = (images = 1): Partial<AuthorHost> => ({
  verify: async () => null,
  evidence: async (_ctx, beats) => ({ images: Array.from({ length: images }, () => IMG), notes: beats.map((b) => `beat ${b.name}`) }),
});

const DESIGN = {
  title: 'Test piece', intent: 'A test.', durationSec: 8, background: '$bg',
  palette: { bg: '#0b0b10', ink: '#f5f5f5', hot: '#ff3366' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { h1: { family: 'Inter', weight: 700, size: 120, tracking: -3, leading: 0.95 } },
  globals: [],
  beats: [
    { name: 'One', purpose: 'open', startSec: 0, endSec: 2 },
    { name: 'Two', purpose: 'build', startSec: 2, endSec: 4 },
    { name: 'Three', purpose: 'turn', startSec: 4, endSec: 6 },
    { name: 'Four', purpose: 'close', startSec: 6, endSec: 8 },
  ],
};

const beatJson = (index: number, label = `B${index}`) => ({
  index,
  layers: [{
    id: `t${index}_${label}`, kind: 'text', name: label, text: label, typeStyle: 'h1',
    props: { x: 960, y: 540, fill: '$ink' },
    keys: { opacity: [{ t: 0.1, v: 0, ease: 'easeOut' }, { t: 0.5, v: 100 }] },
  }],
});

/** Which author call a request is. */
function kind(r: SeenRequest): 'design' | 'beats' | 'critique' | 'revise' | 'other' {
  if (r.system.startsWith('You are a creative director')) return 'critique';
  if (r.user.includes('Design the piece.')) return 'design';
  if (r.user.includes('WHAT THE REVIEW FOUND')) return 'revise';
  if (r.user.includes('Write the complete layers for beat')) return 'beats';
  return 'other';
}

const asked = (r: SeenRequest): number[] => {
  const m = /Write the complete layers for beats? ([\d, ]+)\./.exec(r.user);
  return m ? m[1]!.split(',').map((s) => Number(s.trim())) : [];
};

beforeEach(() => {
  // Path failures are recorded with console.warn by design; they are asserted on, not printed.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  // A leftover override would answer every later suite's model calls.
  installScriptedTransport(() => ({ text: '' })).remove();
});

describe('runAuthorPipeline', () => {
  it('designs, writes beats in chunks of three, resumes a cut-off chunk, critiques, revises one beat and rebuilds only it', async () => {
    let critiques = 0;
    const t = installScriptedTransport((r): ScriptedAnswer => {
      switch (kind(r)) {
        case 'design':
          return { text: `Here is the plan:\n\`\`\`json\n${JSON.stringify(DESIGN)}\n\`\`\`` };
        case 'beats': {
          const want = asked(r);
          if (want.join() === '0,1,2') {
            // Cut off in the middle of beat 2: beats 0 and 1 are complete.
            const full = JSON.stringify({ beats: [beatJson(0), beatJson(1), beatJson(2)] });
            return { text: full.slice(0, full.indexOf('"index":2') + 20), stop: 'max_tokens' };
          }
          return { text: JSON.stringify({ beats: want.map((i) => beatJson(i)) }) };
        }
        case 'critique':
          critiques++;
          return critiques === 1
            ? { text: JSON.stringify({ overall: 'Beat 1 is weak.', beats: [{ index: 1, verdict: 'revise', findings: [{ problem: 'title too small', fix: 'make it 160px', layers: ['t1_B1'] }] }] }) }
            : { text: JSON.stringify({ overall: 'Good now.', beats: [] }) };
        case 'revise':
          return { text: JSON.stringify({ layers: beatJson(1, 'Bigger').layers.map((l) => ({ ...l, props: { ...l.props, fontSize: 160 } })) }) };
        default:
          return { text: '{}' };
      }
    });

    const h = harness();
    const activity: string[] = [];
    const res = await runAuthorPipeline(
      { provider: 'anthropic', dialect: 'anthropic', model: 'claude-opus-5', prompt: 'a launch film', signal: new AbortController().signal, events: { onActivity: (l) => activity.push(l) }, host: host() },
      h.ctx, h.registry, new Set(ALL_TOOL_DEFS.map((d) => d.name)),
    );
    t.remove();

    expect(res.ok).toBe(true);
    expect(res.rounds).toBe(1);
    expect(res.revised).toEqual([[1]]);
    expect(res.critique).toBe('Good now.');

    // design, beats [0,1,2] (cut off), beats [2] (resume), beats [3], critique, revise, critique.
    expect(t.requests.map((r) => `${kind(r)}${kind(r) === 'beats' ? asked(r).join('') : ''}`)).toEqual([
      'design', 'beats012', 'beats2', 'beats3', 'critique', 'revise', 'critique',
    ]);
    // The resume told the model which ids are already taken.
    expect(t.requests[2]!.user).toContain('t0_B0');
    // The critic saw the evidence.
    expect(t.requests[4]!.images).toBe(1);

    // Every beat was built: four roots.
    const created = h.executed.filter((c) => c.name === 'create_layer').map((c) => c.args.id);
    expect(created.filter((id) => String(id).startsWith('beat_'))).toEqual(['beat_0', 'beat_1', 'beat_2', 'beat_3', 'beat_1']);
    // The revision wiped beat 1 alone and rebuilt it with the new layer.
    const wipe = h.executed.findIndex((c) => c.name === 'delete_layer');
    expect(h.executed[wipe]!.args).toEqual({ nodeIds: ['beat_1'] });
    expect(h.executed.slice(wipe).filter((c) => c.name === 'create_layer').map((c) => c.args.id)).toEqual(['beat_1', 't1_Bigger']);
    expect(h.executed.slice(wipe).find((c) => c.name === 'update_layer' && c.args.nodeId === 't1_Bigger')!.args.fontSize).toBe(160);

    // The checklist: every stage, in order.
    expect(activity.map((a) => AUTHOR_STAGE_LABELS.findIndex((s) => a.startsWith(s)))).toEqual([0, 1, 2, 3, 4, 3]);
  });

  it('fails cleanly — nothing built — when the design is unusable, so the caster can run', async () => {
    const t = installScriptedTransport(() => ({ text: 'I cannot do that.' }));
    const h = harness();
    const res = await runAuthorPipeline(
      { provider: 'anthropic', dialect: 'anthropic', model: 'claude-opus-5', prompt: 'x', signal: new AbortController().signal, host: host() },
      h.ctx, h.registry, new Set(),
    );
    t.remove();
    expect(res.ok).toBe(false);
    expect(h.executed).toEqual([]);
    expect(t.requests).toHaveLength(1);
  });

  it('skips the critique when there is nothing to look at, and stops at the round budget', async () => {
    const t = installScriptedTransport((r) => {
      switch (kind(r)) {
        case 'design': return { text: JSON.stringify({ ...DESIGN, beats: DESIGN.beats.slice(0, 1) }) };
        case 'beats': return { text: JSON.stringify({ beats: [beatJson(0)] }) };
        default: return { text: '{}' };
      }
    });
    const h = harness();
    const res = await runAuthorPipeline(
      { provider: 'anthropic', dialect: 'anthropic', model: 'claude-opus-5', prompt: 'x', signal: new AbortController().signal, host: host(0) },
      h.ctx, h.registry, new Set(),
    );
    t.remove();
    expect(res.ok).toBe(true);
    expect(t.requests.map(kind)).toEqual(['design', 'beats']);
  });

  it('never revises past MAX rounds: a critic that always objects gets two revisions, then a final look', async () => {
    const t = installScriptedTransport((r) => {
      switch (kind(r)) {
        case 'design': return { text: JSON.stringify({ ...DESIGN, beats: DESIGN.beats.slice(0, 1) }) };
        case 'beats': return { text: JSON.stringify({ beats: [beatJson(0)] }) };
        case 'critique': return { text: JSON.stringify({ overall: 'no', beats: [{ index: 0, verdict: 'revise', findings: [{ problem: 'p', fix: 'f' }] }] }) };
        case 'revise': return { text: JSON.stringify({ layers: beatJson(0, 'Again').layers }) };
        default: return { text: '{}' };
      }
    });
    const h = harness();
    const res = await runAuthorPipeline(
      { provider: 'anthropic', dialect: 'anthropic', model: 'claude-opus-5', prompt: 'x', signal: new AbortController().signal, host: host() },
      h.ctx, h.registry, new Set(),
    );
    t.remove();
    expect(res.rounds).toBe(2);
    expect(t.requests.map(kind)).toEqual(['design', 'beats', 'critique', 'revise', 'critique', 'revise', 'critique']);
  });
});
