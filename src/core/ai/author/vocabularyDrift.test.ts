/**
 * `@motion/author` cannot import the app, so its animatable-prop list is
 * hand-written. This is the guard that keeps it honest, in both directions:
 * every prop the author card offers passes the real gate (`isAnimatableProp`),
 * and every plain prop the gate admits is on the card — a prop missing from
 * the card is a capability no authored scene can reach.
 */

import { ANIMATABLE_PROPS, AUTHOR_EFFECTS } from '@motion/author';
import { effectDefFor } from '@core/effects/effects';
import {
  CAMERA_PROPS,
  GRADIENT_FILL_PROPS,
  SAMPLED_LAYER_PROPS,
  THREE_D_PROPS,
  TRANSFORM_PROPS,
  isAnimatableProp,
} from '../toolContext';

describe('author vocabulary ⇄ the app', () => {
  it('every animatable prop on the author card passes isAnimatableProp', () => {
    const refused = ANIMATABLE_PROPS.filter((p) => !isAnimatableProp(p));
    expect(refused).toEqual([]);
  });

  it('every plain prop the gate lists is on the author card', () => {
    const card = new Set(ANIMATABLE_PROPS);
    const gate = [...TRANSFORM_PROPS, ...THREE_D_PROPS, ...CAMERA_PROPS, ...SAMPLED_LAYER_PROPS, ...GRADIENT_FILL_PROPS];
    expect(gate.filter((p) => !card.has(p))).toEqual([]);
  });

  it('every effect on the card is one the app can add', () => {
    expect(AUTHOR_EFFECTS.filter((e) => !effectDefFor(e.type)).map((e) => e.type)).toEqual([]);
  });
});
