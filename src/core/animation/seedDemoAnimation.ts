/**
 * Seed a small demo animation so playback visibly drives the renderer. Temporary
 * content — replaced once keyframe authoring UI exists. Idempotent.
 */

import defaultAnimation from './AnimationEngine';

let seeded = false;

export function seedDemoAnimation(): void {
  if (seeded || defaultAnimation.hasAnimation('shape_circle')) {
    seeded = true;
    return;
  }

  // Circle: bounce across + spin.
  defaultAnimation.setKeyframe('shape_circle', 'x', 0, 320, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'x', 2.5, 1500, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'x', 5, 320, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', 0, 300, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', 2.5, 760, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', 5, 300, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'rotation', 0, 0);
  defaultAnimation.setKeyframe('shape_circle', 'rotation', 5, 360);

  // Rectangle: slow counter-rotate + fade pulse.
  defaultAnimation.setKeyframe('shape_rect', 'rotation', 0, 0);
  defaultAnimation.setKeyframe('shape_rect', 'rotation', 5, -180);
  defaultAnimation.setKeyframe('shape_rect', 'opacity', 0, 100);
  defaultAnimation.setKeyframe('shape_rect', 'opacity', 2.5, 30, 'easeInOut');
  defaultAnimation.setKeyframe('shape_rect', 'opacity', 5, 100, 'easeInOut');

  seeded = true;
}

export default seedDemoAnimation;
