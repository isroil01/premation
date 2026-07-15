import { getTimelineController } from '@core/timeline/TimelineController';
/**
 * Seed a small demo animation so playback visibly drives the renderer. Temporary
 * content — replaced once keyframe authoring UI exists. Idempotent.
 */

import { defaultAnimation } from '@motion/animation';

let seeded = false;

export function seedDemoAnimation(): void {
  if (seeded || defaultAnimation.hasAnimation('shape_circle')) {
    seeded = true;
    return;
  }

  // Circle: bounce across + spin.
  defaultAnimation.setKeyframe('shape_circle', 'x', getTimelineController().toLayerTime('shape_circle', 0), 320, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'x', getTimelineController().toLayerTime('shape_circle', 2.5), 1500, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'x', getTimelineController().toLayerTime('shape_circle', 5), 320, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', getTimelineController().toLayerTime('shape_circle', 0), 300, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', getTimelineController().toLayerTime('shape_circle', 2.5), 760, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'y', getTimelineController().toLayerTime('shape_circle', 5), 300, 'easeInOut');
  defaultAnimation.setKeyframe('shape_circle', 'rotation', getTimelineController().toLayerTime('shape_circle', 0), 0);
  defaultAnimation.setKeyframe('shape_circle', 'rotation', getTimelineController().toLayerTime('shape_circle', 5), 360);

  // Rectangle: slow counter-rotate + fade pulse.
  defaultAnimation.setKeyframe('shape_rect', 'rotation', getTimelineController().toLayerTime('shape_rect', 0), 0);
  defaultAnimation.setKeyframe('shape_rect', 'rotation', getTimelineController().toLayerTime('shape_rect', 5), -180);
  defaultAnimation.setKeyframe('shape_rect', 'opacity', getTimelineController().toLayerTime('shape_rect', 0), 100);
  defaultAnimation.setKeyframe('shape_rect', 'opacity', getTimelineController().toLayerTime('shape_rect', 2.5), 30, 'easeInOut');
  defaultAnimation.setKeyframe('shape_rect', 'opacity', getTimelineController().toLayerTime('shape_rect', 5), 100, 'easeInOut');

  seeded = true;
}

export default seedDemoAnimation;
