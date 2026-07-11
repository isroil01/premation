/**
 * Bundled sample plugins that exercise the plugin API. Each registers a real
 * command (which becomes searchable in the Command Palette) that authors
 * editable keyframes on the selected layer — proving effects stay non-destructive.
 */

import type { MotionPlugin } from '@core/plugins/PluginHost';
import { asCommandId } from '@app-types/common';

export const SAMPLE_PLUGINS: MotionPlugin[] = [
  {
    id: 'elastic-overshoot',
    name: 'Elastic Overshoot',
    description: 'Adds an "Apply Elastic Overshoot" command with a springy rotation.',
    activate: (ctx) => {
      ctx.registerCommand({
        id: asCommandId('plugin.elasticOvershoot'),
        label: 'Apply Elastic Overshoot',
        icon: 'refresh',
        enabled: () => ctx.getSelection().length > 0,
        execute: () => {
          for (const id of ctx.getSelection()) {
            const r = ctx.animation.sample(id, 'rotation', 0) ?? 0;
            ctx.animation.setKeyframe(id, 'rotation', 0, r - 14);
            ctx.animation.setKeyframe(id, 'rotation', 0.3, r + 6);
            ctx.animation.setKeyframe(id, 'rotation', 0.55, r);
          }
          ctx.notify('Elastic overshoot applied');
        },
      });
      ctx.registerEffect({
        id: 'elastic',
        label: 'Elastic',
        apply: (id, t) => {
          const r = ctx.animation.sample(id, 'rotation', t) ?? 0;
          ctx.animation.setKeyframe(id, 'rotation', t, r - 14);
          ctx.animation.setKeyframe(id, 'rotation', t + 0.3, r + 6);
          ctx.animation.setKeyframe(id, 'rotation', t + 0.55, r);
        },
      });
    },
  },
  {
    id: 'pulse-glow',
    name: 'Pulse',
    description: 'Adds a "Apply Pulse" command that fades opacity rhythmically.',
    activate: (ctx) => {
      ctx.registerCommand({
        id: asCommandId('plugin.pulse'),
        label: 'Apply Pulse',
        icon: 'circle',
        enabled: () => ctx.getSelection().length > 0,
        execute: () => {
          for (const id of ctx.getSelection()) {
            ctx.animation.setKeyframe(id, 'opacity', 0, 100);
            ctx.animation.setKeyframe(id, 'opacity', 0.5, 40);
            ctx.animation.setKeyframe(id, 'opacity', 1, 100);
          }
          ctx.notify('Pulse applied');
        },
      });
    },
  },
];
