import {
  readNodeCornerPin,
  cornerPinToQuad,
  isIdentityCornerPin,
  isUsableCornerPin,
  IDENTITY_CORNER_PIN,
  type CornerPin,
} from './cornerPin';
import type { SceneNode } from '@core/types';

const node = (cornerPin?: unknown): SceneNode =>
  ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
     transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
     components: cornerPin !== undefined ? [{ id: 'fx', type: 'fx', props: { cornerPin } }] : [] } as unknown as SceneNode);

const KEYSTONE: CornerPin = [0.25, 0, 0.75, 0, 1, 1, 0, 1];

describe('pure helpers', () => {
  it('cornerPinToQuad splits the flat form into TL,TR,BR,BL', () => {
    expect(cornerPinToQuad(KEYSTONE)).toEqual([
      { x: 0.25, y: 0 }, { x: 0.75, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ]);
  });

  it('isIdentityCornerPin is true only for the unit square', () => {
    expect(isIdentityCornerPin(IDENTITY_CORNER_PIN)).toBe(true);
    expect(isIdentityCornerPin(KEYSTONE)).toBe(false);
  });

  it('isUsableCornerPin accepts a convex pin and rejects degenerate ones', () => {
    expect(isUsableCornerPin(KEYSTONE)).toBe(true);
    expect(isUsableCornerPin([0, 0, 1, 0, 0, 1, 1, 1])).toBe(false); // bow-tie
    expect(isUsableCornerPin([0, 0, 1, 0, 2, 0, 1, 1])).toBe(false); // collinear TL,TR,BR
  });
});

describe('readNodeCornerPin — collapses non-render cases to undefined', () => {
  it('undefined when there is no fx pin', () => {
    expect(readNodeCornerPin(node())).toBeUndefined();
  });

  it('undefined for the identity pin (renders on the affine path)', () => {
    expect(readNodeCornerPin(node([...IDENTITY_CORNER_PIN]))).toBeUndefined();
  });

  it('undefined for a degenerate (non-convex) pin', () => {
    expect(readNodeCornerPin(node([0, 0, 1, 0, 0, 1, 1, 1]))).toBeUndefined();
  });

  it('undefined for a malformed value (wrong length / non-numbers)', () => {
    expect(readNodeCornerPin(node([0, 0, 1, 0]))).toBeUndefined();
    expect(readNodeCornerPin(node([0, 0, 1, 0, 1, 1, 0, 'x']))).toBeUndefined();
    expect(readNodeCornerPin(node('nope'))).toBeUndefined();
  });

  it('returns the pin for a valid convex non-identity quad', () => {
    expect(readNodeCornerPin(node([...KEYSTONE]))).toEqual(KEYSTONE);
  });
});
