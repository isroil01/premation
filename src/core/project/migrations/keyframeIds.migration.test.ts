/**
 * 1.8.0 → 1.9.0 — every keyframe gets a stable id, deterministically.
 * Fixture: a 1.8.0 document with scalar tracks, a data track, mask-shape
 * keyframes and one key that already carries an id.
 */

import { migrateDocument, CURRENT_DOCUMENT_VERSION, MIGRATIONS } from './index';
import { v1_8_0_to_v1_9_0 } from './v1_8_0_to_v1_9_0';
import type { EditorDocument } from '@core/api/cloudDocument';

function fixture(): EditorDocument {
  return {
    version: '1.8.0',
    scene: {
      version: '1.0.0',
      nodes: [
        { id: 'comp_root', parent: null, children: ['n1'], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, components: [] },
        {
          id: 'n1', parent: 'comp_root', children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [{ id: 'n1_fx', type: 'fx', props: { maskAnim: [{ t: 0, mask: { paths: [] } }, { t: 1, mask: { paths: [] } }] } }],
        },
      ],
    },
    animation: {
      tracks: {
        n1: {
          x: { nodeId: 'n1', prop: 'x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 10, id: 'k7' }] },
          y: { nodeId: 'n1', prop: 'y', keyframes: [{ t: 0, value: 0 }] },
        },
      },
      expressions: {},
      data: { n1: { 'text.source': { nodeId: 'n1', prop: 'text.source', kind: 'text', keyframes: [{ t: 0, value: 'a' }] } } },
    },
  } as unknown as EditorDocument;
}

test('the chain ends at 1.9.0', () => {
  expect(CURRENT_DOCUMENT_VERSION).toBe('1.9.0');
  expect(MIGRATIONS.at(-1)).toBe(v1_8_0_to_v1_9_0);
});

test('assigns k<n> past the highest existing id, in document order: tracks, data, mask shapes', () => {
  const doc = fixture();
  const out = migrateDocument(doc);
  const anim = out.animation as unknown as { tracks: Record<string, Record<string, { keyframes: Array<{ id?: string }> }>>; data: Record<string, Record<string, { keyframes: Array<{ id?: string }> }>> };
  expect(anim.tracks.n1!.x!.keyframes.map((k) => k.id)).toEqual(['k8', 'k7']);
  expect(anim.tracks.n1!.y!.keyframes.map((k) => k.id)).toEqual(['k9']);
  expect(anim.data.n1!['text.source']!.keyframes.map((k) => k.id)).toEqual(['k10']);
  const fx = out.scene.nodes[1]!.components[0]!.props as { maskAnim: Array<{ id?: string }> };
  expect(fx.maskAnim.map((k) => k.id)).toEqual(['k11', 'k12']);
  // Pure: the input is untouched.
  expect((doc.animation.tracks.n1!.x!.keyframes[0] as { id?: string }).id).toBeUndefined();
});

test('deterministic and idempotent', () => {
  const a = migrateDocument(fixture());
  const b = migrateDocument(fixture());
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  const again = v1_8_0_to_v1_9_0.migrate({ ...a, version: '1.8.0' });
  expect(again).toBe(v1_8_0_to_v1_9_0.migrate(again));
  expect(JSON.stringify(again.animation)).toBe(JSON.stringify(a.animation));
});
