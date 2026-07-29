/**
 * The UI component kit.
 *
 * You cannot compose a professional interface out of `create_layer(kind:'rect')`.
 * A button is not a rounded rectangle — it is a rounded rectangle with a defined
 * elevation, a defined press response, a defined focus ring, a defined disabled
 * treatment, and a defined relationship to the grid. Encoding those once is what
 * makes twenty compositions look like the same product rather than twenty
 * different products.
 *
 * Each component declares:
 *  • its **states** and the spring choreography between them,
 *  • its **grid behaviour** (fills a column, hugs its content, or fixed),
 *  • its **elevation**, which feeds the design system's shadow stack,
 *  • its **element class**, which decides its timing budget,
 *  • which **techniques** may animate it — a toast cannot magic-move into a chart.
 *
 * Theming comes entirely from `@motion/design-system`: one component set, eight
 * pack looks.
 *
 * Pure — a component `emit` returns `ToolCall[]`.
 */

import { elevation, radius, type Elevation, type Palette, type RadiusStep, type ShapeLanguage, mk, type ToolCall } from '@motion/design-system';
import type { UiElementClass } from './choreography';

export type ComponentState =
  | 'default' | 'hover' | 'pressed' | 'focused' | 'disabled'
  | 'loading' | 'error' | 'filled' | 'empty' | 'selected' | 'expanded';

export type GridBehaviour = 'fill' | 'hug' | 'fixed';

export interface ComponentContext {
  palette: Palette;
  shape: ShapeLanguage;
  /** Base font size, so components scale with the frame. */
  basePx: number;
  /** Frame density, for stroke and shadow scaling. */
  densityScale: number;
}

export interface ComponentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiComponentDef {
  id: string;
  displayName: string;
  cls: UiElementClass;
  states: readonly ComponentState[];
  grid: GridBehaviour;
  elevation: Elevation;
  radiusStep: RadiusStep;
  /** Technique ids allowed to animate this component. Empty = any product one. */
  techniques: readonly string[];
  /** Natural size at `basePx = 16`, before grid sizing. */
  intrinsic: { width: number; height: number };
  emit(ctx: ComponentContext, id: string, box: ComponentBox, label?: string): ToolCall[];
}

// ── Shared emit helpers ───────────────────────────────────────────────

export function surface(
  ctx: ComponentContext,
  id: string,
  box: ComponentBox,
  o: { fill: string; level: Elevation; radiusStep: RadiusStep; borderColor?: string },
): ToolCall[] {
  const r = radius(o.radiusStep, box);
  const calls: ToolCall[] = [
    mk('create_layer', {
      id, kind: 'shape', shape: 'rect', name: id,
      x: box.x, y: box.y, width: box.width, height: box.height,
    }),
    mk('update_layer', { nodeId: id, fill: o.fill, cornerRadius: r }),
  ];
  const stack = elevation(o.level, { background: ctx.palette.bg, angle: 90, scale: ctx.densityScale });
  if (stack.length) calls.push(mk('set_shadow_stack', { nodeId: id, shadows: stack }));
  return calls;
}

export function label(
  _ctx: ComponentContext,
  id: string,
  text: string,
  box: ComponentBox,
  o: { fill: string; sizePx: number; weight: number; align?: 'left' | 'center' | 'right' },
): ToolCall[] {
  return [
    mk('create_layer', { id, kind: 'text', name: id, text, x: box.x, y: box.y }),
    mk('update_layer', {
      nodeId: id,
      fontSize: o.sizePx,
      fontWeight: o.weight,
      fill: o.fill,
      width: box.width,
      align: o.align ?? 'center',
      // UI labels are small, so tracking is POSITIVE — the same curve the design
      // system applies to editorial captions. A UI label at zero tracking looks
      // cramped in exactly the way a headline at zero tracking looks loose.
      letterSpacing: Number((o.sizePx * 0.015).toFixed(2)),
      lineHeight: 1.3,
    }),
  ];
}

// ── Components ────────────────────────────────────────────────────────

export const button: UiComponentDef = {
  id: 'ui.button',
  displayName: 'Button',
  cls: 'control',
  states: ['default', 'hover', 'pressed', 'focused', 'loading', 'disabled'],
  grid: 'hug',
  elevation: 1,
  radiusStep: 3,
  techniques: ['ui.press_feedback', 'ui.list_stagger_in', 'ui.shared_element_expand'],
  intrinsic: { width: 120, height: 40 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.accent, level: 1, radiusStep: ctx.shape.controlRadius }),
      ...label(ctx, `${id}_label`, text ?? 'Continue', box, {
        fill: ctx.palette.bg, sizePx: ctx.basePx * 0.9, weight: 600,
      }),
    ];
  },
};

export const secondaryButton: UiComponentDef = {
  id: 'ui.button_secondary',
  displayName: 'Secondary Button',
  cls: 'control',
  states: ['default', 'hover', 'pressed', 'focused', 'disabled'],
  grid: 'hug',
  elevation: 0,
  radiusStep: 3,
  techniques: ['ui.press_feedback', 'ui.list_stagger_in'],
  intrinsic: { width: 120, height: 40 },
  emit(ctx, id, box, text) {
    return [
      // Elevation 0, not 1. A secondary action that casts the same shadow as the
      // primary is not secondary — the depth difference IS the hierarchy.
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 0, radiusStep: ctx.shape.controlRadius }),
      ...label(ctx, `${id}_label`, text ?? 'Cancel', box, {
        fill: ctx.palette.fg, sizePx: ctx.basePx * 0.9, weight: 500,
      }),
    ];
  },
};

export const input: UiComponentDef = {
  id: 'ui.input',
  displayName: 'Text Input',
  cls: 'control',
  states: ['empty', 'focused', 'filled', 'error', 'disabled'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.focus_ring', 'ui.list_stagger_in'],
  intrinsic: { width: 280, height: 44 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 0, radiusStep: 2 }),
      ...label(ctx, `${id}_value`, text ?? 'Placeholder', box, {
        fill: ctx.palette.muted, sizePx: ctx.basePx, weight: 400, align: 'left',
      }),
    ];
  },
};

export const toggle: UiComponentDef = {
  id: 'ui.toggle',
  displayName: 'Toggle',
  cls: 'control',
  states: ['default', 'selected', 'focused', 'disabled'],
  grid: 'fixed',
  elevation: 0,
  radiusStep: 5,
  techniques: ['ui.toggle_flip', 'ui.press_feedback', 'ui.focus_ring'],
  intrinsic: { width: 48, height: 28 },
  emit(ctx, id, box) {
    const knob = box.height - 6;
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.line, level: 0, radiusStep: 5 }),
      ...surface(ctx, `${id}_knob`, { x: box.x - box.width / 2 + knob / 2 + 3, y: box.y, width: knob, height: knob }, {
        // The knob carries a shadow and the track does not. A flat knob reads as
        // a drawing of a switch; a lifted one reads as a switch.
        fill: ctx.palette.fg, level: 2, radiusStep: 5,
      }),
    ];
  },
};

export const card: UiComponentDef = {
  id: 'ui.card',
  displayName: 'Card',
  cls: 'container',
  states: ['default', 'hover', 'pressed', 'selected', 'expanded'],
  grid: 'fill',
  elevation: 2,
  radiusStep: 3,
  techniques: ['ui.shared_element_expand', 'ui.list_stagger_in', 'ui.press_feedback', 'ui.hover_lift'],
  intrinsic: { width: 320, height: 200 },
  emit(ctx, id, box, text) {
    const calls = surface(ctx, id, box, { fill: ctx.palette.surface, level: 2, radiusStep: ctx.shape.cardRadius });
    if (text) {
      calls.push(...label(ctx, `${id}_title`, text, {
        ...box,
        y: box.y - box.height / 2 + ctx.basePx * 2,
        width: box.width - ctx.basePx * 3,
      }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 1.25, weight: 600, align: 'left' }));
    }
    return calls;
  },
};

export const listRow: UiComponentDef = {
  id: 'ui.list_row',
  displayName: 'List Row',
  cls: 'container',
  states: ['default', 'hover', 'pressed', 'selected'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 1,
  techniques: ['ui.list_stagger_in', 'ui.shared_element_expand', 'ui.press_feedback'],
  intrinsic: { width: 360, height: 56 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 0, radiusStep: 1 }),
      ...label(ctx, `${id}_label`, text ?? 'Item', box, {
        fill: ctx.palette.fg, sizePx: ctx.basePx, weight: 500, align: 'left',
      }),
    ];
  },
};

export const toast: UiComponentDef = {
  id: 'ui.toast',
  displayName: 'Toast',
  cls: 'overlay',
  states: ['default'],
  grid: 'hug',
  elevation: 4,
  radiusStep: 3,
  // A toast cannot magic-move into anything — it has no counterpart in the next
  // state, and matching it to one would produce a morph that reads as a glitch.
  techniques: ['ui.toast_slide'],
  intrinsic: { width: 300, height: 52 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.fg, level: 4, radiusStep: 3 }),
      ...label(ctx, `${id}_label`, text ?? 'Saved', box, {
        fill: ctx.palette.bg, sizePx: ctx.basePx * 0.95, weight: 500,
      }),
    ];
  },
};

export const modal: UiComponentDef = {
  id: 'ui.modal',
  displayName: 'Modal',
  cls: 'surface',
  states: ['default', 'expanded'],
  grid: 'fixed',
  elevation: 5,
  radiusStep: 3,
  techniques: ['ui.sheet_present', 'ui.shared_element_expand'],
  intrinsic: { width: 480, height: 320 },
  emit(ctx, id, box, text) {
    const calls = surface(ctx, id, box, { fill: ctx.palette.surface, level: 5, radiusStep: ctx.shape.cardRadius });
    if (text) {
      calls.push(...label(ctx, `${id}_title`, text, {
        ...box, y: box.y - box.height / 2 + ctx.basePx * 2.5, width: box.width - ctx.basePx * 4,
      }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 1.4, weight: 600, align: 'left' }));
    }
    return calls;
  },
};

export const sheet: UiComponentDef = {
  id: 'ui.sheet',
  displayName: 'Bottom Sheet',
  cls: 'surface',
  states: ['default', 'expanded'],
  grid: 'fill',
  elevation: 5,
  radiusStep: 4,
  techniques: ['ui.sheet_present', 'ui.momentum_scroll'],
  intrinsic: { width: 390, height: 420 },
  emit(ctx, id, box) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 5, radiusStep: 4 }),
      // The grabber. Small, and its absence is one of those things nobody
      // notices until the sheet feels un-draggable.
      ...surface(ctx, `${id}_grabber`, {
        x: box.x, y: box.y - box.height / 2 + ctx.basePx * 1.2, width: 36, height: 4,
      }, { fill: ctx.palette.line, level: 0, radiusStep: 5 }),
    ];
  },
};

export const navBar: UiComponentDef = {
  id: 'ui.nav_bar',
  displayName: 'Nav Bar',
  cls: 'container',
  states: ['default'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 0,
  techniques: ['ui.tab_switch'],
  intrinsic: { width: 390, height: 56 },
  emit(ctx, id, box) {
    return surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: 0 });
  },
};

export const tabBar: UiComponentDef = {
  id: 'ui.tab_bar',
  displayName: 'Tab Bar',
  cls: 'container',
  states: ['default', 'selected'],
  grid: 'fill',
  elevation: 2,
  radiusStep: 0,
  techniques: ['ui.tab_switch', 'ui.press_feedback'],
  intrinsic: { width: 390, height: 64 },
  emit(ctx, id, box) {
    return surface(ctx, id, box, { fill: ctx.palette.surface, level: 2, radiusStep: 0 });
  },
};

export const statTile: UiComponentDef = {
  id: 'ui.stat_tile',
  displayName: 'Stat Tile',
  cls: 'container',
  states: ['default', 'loading'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 3,
  techniques: ['ui.count_up', 'ui.list_stagger_in', 'ui.skeleton_resolve'],
  intrinsic: { width: 200, height: 120 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: ctx.shape.cardRadius }),
      ...label(ctx, `${id}_value`, text ?? '0', { ...box, y: box.y - ctx.basePx * 0.4 }, {
        fill: ctx.palette.fg, sizePx: ctx.basePx * 2.2, weight: 700, align: 'left',
      }),
    ];
  },
};

export const chartLine: UiComponentDef = {
  id: 'ui.chart_line',
  displayName: 'Line Chart',
  cls: 'content',
  states: ['default', 'loading'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 0,
  techniques: ['ui.chart_draw_on', 'ui.skeleton_resolve'],
  intrinsic: { width: 320, height: 160 },
  emit(ctx, id, box) {
    return [
      mk('create_layer', {
        id, kind: 'shape', shape: 'line', name: 'Chart Line',
        x: box.x, y: box.y, width: box.width, height: box.height,
      }),
      mk('update_layer', { nodeId: id, fill: ctx.palette.accent }),
      // Trim path at zero — the chart draws ON rather than fading in, which is
      // the only chart entrance that reads as data arriving.
      mk('set_trim_path', { nodeId: id, start: 0, end: 0, offset: 0 }),
    ];
  },
};

export const chartBar: UiComponentDef = {
  id: 'ui.chart_bar',
  displayName: 'Bar Chart',
  cls: 'content',
  states: ['default', 'loading'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.chart_draw_on', 'ui.list_stagger_in'],
  intrinsic: { width: 320, height: 160 },
  emit(ctx, id, box) {
    return surface(ctx, id, box, { fill: ctx.palette.accent, level: 0, radiusStep: 2 });
  },
};

export const skeleton: UiComponentDef = {
  id: 'ui.skeleton',
  displayName: 'Skeleton',
  cls: 'indicator',
  states: ['loading'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.skeleton_resolve'],
  intrinsic: { width: 200, height: 16 },
  emit(ctx, id, box) {
    return surface(ctx, id, box, { fill: ctx.palette.line, level: 0, radiusStep: 2 });
  },
};

export const badge: UiComponentDef = {
  id: 'ui.badge',
  displayName: 'Badge',
  cls: 'indicator',
  states: ['default'],
  grid: 'hug',
  elevation: 0,
  radiusStep: 5,
  techniques: ['ui.press_feedback', 'ui.list_stagger_in'],
  intrinsic: { width: 56, height: 22 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.accent, level: 0, radiusStep: 5 }),
      ...label(ctx, `${id}_label`, text ?? 'New', box, {
        fill: ctx.palette.bg, sizePx: ctx.basePx * 0.72, weight: 700,
      }),
    ];
  },
};

export const avatar: UiComponentDef = {
  id: 'ui.avatar',
  displayName: 'Avatar',
  cls: 'content',
  states: ['default'],
  grid: 'fixed',
  elevation: 0,
  radiusStep: 5,
  techniques: ['ui.list_stagger_in', 'ui.shared_element_expand'],
  intrinsic: { width: 40, height: 40 },
  emit(ctx, id, box) {
    return surface(ctx, id, box, { fill: ctx.palette.support, level: 0, radiusStep: 5 });
  },
};

export const tooltip: UiComponentDef = {
  id: 'ui.tooltip',
  displayName: 'Tooltip',
  cls: 'overlay',
  states: ['default'],
  grid: 'hug',
  elevation: 3,
  radiusStep: 2,
  techniques: ['ui.tooltip_appear'],
  intrinsic: { width: 160, height: 32 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.fg, level: 3, radiusStep: 2 }),
      ...label(ctx, `${id}_label`, text ?? 'Tooltip', box, {
        fill: ctx.palette.bg, sizePx: ctx.basePx * 0.8, weight: 500,
      }),
    ];
  },
};

export const progress: UiComponentDef = {
  id: 'ui.progress',
  displayName: 'Progress Bar',
  cls: 'indicator',
  states: ['loading', 'default'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 5,
  techniques: ['ui.progress_fill'],
  intrinsic: { width: 240, height: 6 },
  emit(ctx, id, box) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.line, level: 0, radiusStep: 5 }),
      ...surface(ctx, `${id}_fill`, { ...box, x: box.x - box.width / 2, width: box.width }, {
        fill: ctx.palette.accent, level: 0, radiusStep: 5,
      }),
    ];
  },
};

export const searchField: UiComponentDef = {
  id: 'ui.search_field',
  displayName: 'Search Field',
  cls: 'control',
  states: ['empty', 'focused', 'filled'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 5,
  techniques: ['ui.focus_ring', 'ui.list_stagger_in'],
  intrinsic: { width: 320, height: 40 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 0, radiusStep: 5 }),
      ...label(ctx, `${id}_value`, text ?? 'Search', box, {
        fill: ctx.palette.muted, sizePx: ctx.basePx * 0.95, weight: 400, align: 'left',
      }),
    ];
  },
};

export const chatBubble: UiComponentDef = {
  id: 'ui.chat_bubble',
  displayName: 'Chat Bubble',
  cls: 'container',
  states: ['default'],
  grid: 'hug',
  elevation: 1,
  radiusStep: 4,
  techniques: ['ui.list_stagger_in', 'ui.bubble_pop'],
  intrinsic: { width: 240, height: 44 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.accent, level: 1, radiusStep: 4 }),
      ...label(ctx, `${id}_label`, text ?? 'Hello', box, {
        fill: ctx.palette.bg, sizePx: ctx.basePx * 0.95, weight: 400, align: 'left',
      }),
    ];
  },
};

export const codeBlock: UiComponentDef = {
  id: 'ui.code_block',
  displayName: 'Code Block',
  cls: 'container',
  states: ['default'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 2,
  techniques: ['ui.type_on', 'ui.list_stagger_in'],
  intrinsic: { width: 400, height: 200 },
  emit(ctx, id, box, text) {
    return [
      ...surface(ctx, id, box, { fill: ctx.palette.bg, level: 1, radiusStep: 2 }),
      ...label(ctx, `${id}_code`, text ?? '$ npm run build', {
        ...box, y: box.y - box.height / 2 + ctx.basePx * 1.6, width: box.width - ctx.basePx * 2,
      }, { fill: ctx.palette.accentText, sizePx: ctx.basePx * 0.9, weight: 400, align: 'left' }),
    ];
  },
};

import { UI_COMPONENTS_2 } from './components2';
import { UI_COMPONENTS_3 } from './components3';

export const UI_COMPONENTS: readonly UiComponentDef[] = [
  button, secondaryButton, input, toggle, card, listRow, toast, modal, sheet,
  navBar, tabBar, statTile, chartLine, chartBar, skeleton, badge, avatar,
  tooltip, progress, searchField, chatBubble, codeBlock,
  ...UI_COMPONENTS_2,
  ...UI_COMPONENTS_3,
];

const BY_ID = new Map(UI_COMPONENTS.map((c) => [c.id, c]));

export function uiComponent(id: string): UiComponentDef | undefined {
  return BY_ID.get(id);
}

/** May this technique animate this component? */
export function componentAllows(component: UiComponentDef, techniqueId: string): boolean {
  return component.techniques.length === 0 || component.techniques.includes(techniqueId);
}
