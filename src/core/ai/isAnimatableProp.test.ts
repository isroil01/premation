/**
 * The animatable-prop gate, checked against the paths the ENGINE actually
 * writes — because the one divergence it had was exactly the silent kind:
 * `pathOp.` (camelCase, a prefix no real track ever carried) while
 * `pathOpPropPath` mints `pathop.`, so the AI was told by add_path_operator's
 * own reply to keyframe a path the gate then refused.
 */

import { isAnimatableProp } from './toolContext';
import { pathOpPropPath, newPathOpId } from '@core/scene/pathOps';

describe('isAnimatableProp', () => {
  it('REGRESSION: accepts the exact path pathOpPropPath mints', () => {
    expect(isAnimatableProp(pathOpPropPath(newPathOpId(), 'amount'))).toBe(true);
  });

  it('accepts the other engine-minted prefixes', () => {
    expect(isAnimatableProp('effect.fx1.amount')).toBe(true);
    expect(isAnimatableProp('ta.0.offset')).toBe(true);
  });

  it('still rejects arbitrary names', () => {
    expect(isAnimatableProp('definitelyNotAProp')).toBe(false);
  });
});
