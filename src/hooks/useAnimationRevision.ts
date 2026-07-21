/**
 * Re-render this component whenever the animation changes.
 *
 * Keyframes do not live in a store — they live in the AnimationEngine, which
 * announces edits on the event bus rather than through React. So any panel that
 * *reads* a sampled value has to subscribe, or it keeps showing the number it
 * rendered with: type a value into a keyframed property and the field silently
 * keeps the old one until something unrelated re-renders it.
 *
 * MotionControls and ViewportHeader each hand-rolled this reducer + effect;
 * this is that same pattern, once, so a panel gains it with one line instead of
 * five (and so it cannot be half-forgotten, which is how TransformSection ended
 * up showing stale values).
 */

import { useEffect, useReducer } from 'react';
import { getEventBus } from '@core/events/EventBus';

export function useAnimationRevision(): number {
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = getEventBus().on('AnimationChanged', () => bump());
    return () => sub.dispose();
  }, []);
  return rev;
}
