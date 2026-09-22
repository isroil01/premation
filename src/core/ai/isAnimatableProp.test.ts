/**
 * The animatable-prop gate, checked against the paths the ENGINE actually
 * writes — because the one divergence it had was exactly the silent kind:
 * `pathOp.` (camelCase, a prefix no real track ever carried) while
 * `pathOpPropPath` mints `pathop.`, so the AI was told by add_path_operator's
 * own reply to keyframe a path the gate then refused.
 */

import { isAnimatableProp } from './toolContext';
import { pathOpPropPath, newPathOpId } from '@core/scene/pathOps';
import { polystarPropPath } from '@core/scene/polystar';
import { FILL_GRADIENT_TRACKS } from '@core/rendering/gradientPaintTracks';

describe('isAnimatableProp', () => {
  it('REGRESSION: accepts the exact path pathOpPropPath mints', () => {
    expect(isAnimatableProp(pathOpPropPath(newPathOpId(), 'amount'))).toBe(true);
  });

  it('accepts the other engine-minted prefixes', () => {
    expect(isAnimatableProp('effect.fx1.amount')).toBe(true);
    expect(isAnimatableProp('ta.0.offset')).toBe(true);
  });

  it('accepts what create_layer / create_gradient now build: polystar params and gradient-fill geometry', () => {
    // Both are sampled by name in buildSnapshot (resolvePolystar, fillPaint
    // resolution) — a tool that creates them and a gate that refuses to
    // animate them would be half a feature.
    expect(isAnimatableProp(polystarPropPath('points'))).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.radius)).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.centerX)).toBe(true);
    expect(isAnimatableProp(FILL_GRADIENT_TRACKS.angle)).toBe(true);
  });

  it('still rejects arbitrary names', () => {
    expect(isAnimatableProp('definitelyNotAProp')).toBe(false);
  });
});
