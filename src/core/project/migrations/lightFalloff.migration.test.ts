/**
 * 1.7.0 → 1.8.0 — Falloff None becomes AE's None; absent falloff → `legacy`.
 *
 * What this could get wrong, all silent:
 *  1. It changes the PICTURE. An old light shaded by the radius ramp must keep
 *     shading by it — asserted through `lightFalloffAt`, not only as data.
 *  2. It is not IDEMPOTENT. Documents are stamped '1.1.0' on save (F31), so
 *     this step runs on every load; a light this build wrote as `none` must
 *     stay `none`.
 *  3. It touches a non-light. Only a light's transform carries `falloff`.
 */

import { v1_7_0_to_v1_8_0 } from './v1_7_0_to_v1_8_0';
import { migrateDocument, CURRENT_DOCUMENT_VERSION } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';
import { lightFalloffAt, readNodeLight } from '@core/scene/light';
import type { SceneNode } from '@core/types';

function node(id: string, kind: string, props: Record<string, unknown>) {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind, x: 0, y: 0, ...props } }],
  };
}

function legacyDoc(): EditorDocument {
  return {
    version: '1.7.0',
    scene: {
      nodes: [
        node('old', 'light', { radius: 500, intensity: 100 }),
        node('spot', 'light', { lightType: 'spot', radius: 500 }),
        node('curved', 'light', { radius: 500, falloff: 'smooth', falloffDistance: 200 }),
        node('fresh', 'light', { radius: 500, falloff: 'none' }),
        node('box', 'shape', { radius: 500 }),
      ],
    },
  } as unknown as EditorDocument;
}

const propsOf = (doc: EditorDocument, id: string): Record<string, unknown> =>
  (doc.scene as { nodes: Array<{ id: string; components: Array<{ props: Record<string, unknown> }> }> }).nodes
    .find((n) => n.id === id)!.components[0]!.props;

describe('1.7.0 → 1.8.0 light falloff', () => {
  it('stamps `legacy` on every light without a falloff, and nothing else', () => {
    const out = v1_7_0_to_v1_8_0.migrate(legacyDoc());
    expect(propsOf(out, 'old').falloff).toBe('legacy');
    expect(propsOf(out, 'spot').falloff).toBe('legacy');
    expect(propsOf(out, 'curved').falloff).toBe('smooth');
    expect(propsOf(out, 'fresh').falloff).toBe('none');
    expect(propsOf(out, 'box').falloff).toBeUndefined();
  });

  it('keeps the old light shading exactly as it did: full at the light, gone at the radius', () => {
    const out = v1_7_0_to_v1_8_0.migrate(legacyDoc());
    const nodes = (out.scene as { nodes: SceneNode[] }).nodes;
    const old = readNodeLight(nodes.find((n) => n.id === 'old')!);
    expect(lightFalloffAt(0, old)).toBe(1);
    expect(lightFalloffAt(250, old)).toBeCloseTo(0.5, 6);
    expect(lightFalloffAt(500, old)).toBe(0);
    // And a light this build wrote is AE's None: constant.
    const fresh = readNodeLight(nodes.find((n) => n.id === 'fresh')!);
    expect(lightFalloffAt(5000, fresh)).toBe(1);
  });

  it('is idempotent and leaves an untouched document as the same object', () => {
    const once = v1_7_0_to_v1_8_0.migrate(legacyDoc());
    const twice = v1_7_0_to_v1_8_0.migrate(once);
    expect(twice).toBe(once);
  });

  it('is reached by the registry walk from 1.7.0', () => {
    const out = migrateDocument(legacyDoc());
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(propsOf(out, 'old').falloff).toBe('legacy');
  });
});
