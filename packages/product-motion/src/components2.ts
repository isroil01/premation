/**
 * UI components, second set.
 *
 * The first set covers the primitives an interface is built from — button,
 * input, card, row, sheet. These are the ones that appear once an interface has
 * *state to communicate*: something is loading, something went wrong, something
 * is selected, something is empty, something needs a decision.
 *
 * That is the same dividing line the second set of product techniques follows,
 * and it is deliberate: a component and the motion that animates it are two
 * halves of one idea, and a library that grew only its primitives would keep
 * producing pieces where nothing ever fails, empties, or waits.
 */

import type { UiComponentDef } from './components';
import { surface, label } from './components';
import type { ToolCall } from '@motion/design-system';

// ── ui.alert_banner ───────────────────────────────────────────────────

export const alertBanner: UiComponentDef = {
  id: 'ui.alert_banner',
  displayName: 'Alert Banner',
  cls: 'surface',
  states: ['default', 'error'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 2,
  techniques: ['ui.error_shake', 'ui.toast_slide', 'ui.list_stagger_in'],
  intrinsic: { width: 420, height: 56 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: ctx.shape.cardRadius }),
    ];
    // The status stripe down the leading edge, not a tinted background. A wash
    // of colour behind body copy is what fails contrast; a stripe carries the
    // same signal and leaves the text on the surface it was designed for.
    const stripeW = Math.max(3, Math.round(box.height * 0.07));
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_stripe`, kind: 'shape', shape: 'rect', name: 'Status',
        x: box.x - box.width / 2 + stripeW / 2, y: box.y,
        width: stripeW, height: box.height,
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_stripe`, fill: ctx.palette.accent, cornerRadius: 0 } });
    calls.push(...label(ctx, `${id}_label`, text ?? 'Something needs your attention', box, {
      fill: ctx.palette.fg, sizePx: ctx.basePx * 0.95, weight: 500,
    }));
    return calls;
  },
};

// ── ui.empty_state ────────────────────────────────────────────────────

export const emptyState: UiComponentDef = {
  id: 'ui.empty_state',
  displayName: 'Empty State',
  cls: 'content',
  states: ['default'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.empty_state_settle', 'ui.list_stagger_in'],
  intrinsic: { width: 360, height: 220 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    // No surface. An empty state that sits on a card looks like a broken card;
    // it belongs directly on the background, which is the whole visual point.
    const glyph = Math.round(Math.min(box.width, box.height) * 0.28);
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_glyph`, kind: 'shape', shape: 'ellipse', name: 'Illustration',
        x: box.x, y: box.y - box.height * 0.18, width: glyph, height: glyph,
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_glyph`, fill: ctx.palette.line, opacity: 60 } });
    calls.push(...label(ctx, `${id}_label`, text ?? 'Nothing here yet', {
      ...box, y: box.y + box.height * 0.18,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx, weight: 500 }));
    return calls;
  },
};

// ── ui.segmented_control ──────────────────────────────────────────────

export const segmentedControl: UiComponentDef = {
  id: 'ui.segmented_control',
  displayName: 'Segmented Control',
  cls: 'control',
  states: ['default', 'focused'],
  grid: 'hug',
  elevation: 1,
  radiusStep: 3,
  techniques: ['ui.segmented_slide', 'ui.press_feedback'],
  intrinsic: { width: 260, height: 36 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: ctx.shape.controlRadius }),
    ];
    // The selection pill is its own layer so `ui.segmented_slide` has something
    // to move. A control drawn as one piece cannot animate its own selection.
    const inset = Math.max(2, Math.round(box.height * 0.1));
    const pillW = box.width / 3 - inset;
    calls.push(...surface(ctx, `${id}_pill`, {
      x: box.x - box.width / 3, y: box.y, width: pillW, height: box.height - inset * 2,
    }, { fill: ctx.palette.accent, level: 1, radiusStep: ctx.shape.controlRadius }));
    calls.push(...label(ctx, `${id}_label`, text ?? 'All', {
      x: box.x - box.width / 3, y: box.y, width: pillW, height: box.height,
    }, { fill: ctx.palette.bg, sizePx: ctx.basePx * 0.85, weight: 600 }));
    return calls;
  },
};

// ── ui.data_table_row ─────────────────────────────────────────────────

export const dataTableRow: UiComponentDef = {
  id: 'ui.data_table_row',
  displayName: 'Data Table Row',
  cls: 'content',
  states: ['default', 'hover', 'selected'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 0,
  techniques: ['ui.list_stagger_in', 'ui.hover_lift', 'ui.filter_reflow'],
  intrinsic: { width: 520, height: 44 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    // A table row is a rule, not a card. Giving each row its own elevated
    // surface is the single most common way a data table stops looking like one.
    calls.push(...label(ctx, `${id}_label`, text ?? 'Row', {
      ...box, x: box.x - box.width * 0.25,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.9, weight: 400 }));
    calls.push(...label(ctx, `${id}_value`, '—', {
      ...box, x: box.x + box.width * 0.35,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.9, weight: 500 }));
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_rule`, kind: 'shape', shape: 'rect', name: 'Row rule',
        x: box.x, y: box.y + box.height / 2, width: box.width, height: 1,
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_rule`, fill: ctx.palette.line, cornerRadius: 0 } });
    return calls;
  },
};

// ── ui.dropdown ───────────────────────────────────────────────────────

export const dropdown: UiComponentDef = {
  id: 'ui.dropdown',
  displayName: 'Dropdown',
  cls: 'overlay',
  states: ['default', 'expanded', 'focused'],
  grid: 'hug',
  elevation: 3,
  radiusStep: 3,
  techniques: ['ui.sheet_present', 'ui.list_stagger_in', 'ui.press_feedback'],
  intrinsic: { width: 200, height: 160 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 3, radiusStep: ctx.shape.cardRadius }),
    ];
    // Three rows, so a stagger has something to stagger. A dropdown drawn as one
    // rectangle animates as one rectangle.
    const rowH = box.height / 4;
    for (let i = 0; i < 3; i++) {
      calls.push(...label(ctx, `${id}_row_${i}`, i === 0 ? (text ?? 'Option') : 'Option', {
        x: box.x - box.width * 0.1,
        y: box.y - box.height / 2 + rowH * (i + 0.9),
        width: box.width * 0.7,
        height: rowH,
      }, { fill: i === 0 ? ctx.palette.fg : ctx.palette.muted, sizePx: ctx.basePx * 0.88, weight: 400 }));
    }
    return calls;
  },
};

// ── ui.stepper ────────────────────────────────────────────────────────

export const stepper: UiComponentDef = {
  id: 'ui.stepper',
  displayName: 'Stepper',
  cls: 'indicator',
  states: ['default'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 4,
  techniques: ['ui.progress_fill', 'ui.list_stagger_in', 'ui.badge_pulse'],
  intrinsic: { width: 320, height: 28 },
  emit(ctx, id, box) {
    const calls: ToolCall[] = [];
    const steps = 4;
    const dot = Math.round(box.height * 0.55);
    const gap = (box.width - dot) / (steps - 1);
    // The connecting track goes down FIRST, so the dots sit on it rather than
    // beside it. Drawing it after would put a line through every dot.
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_track`, kind: 'shape', shape: 'rect', name: 'Track',
        x: box.x, y: box.y, width: box.width - dot, height: Math.max(2, Math.round(dot * 0.12)),
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_track`, fill: ctx.palette.line, cornerRadius: 0 } });
    for (let i = 0; i < steps; i++) {
      const sid = `${id}_step_${i}`;
      calls.push({
        name: 'create_layer',
        args: {
          id: sid, kind: 'shape', shape: 'ellipse', name: `Step ${i + 1}`,
          x: box.x - box.width / 2 + dot / 2 + gap * i, y: box.y, width: dot, height: dot,
        },
      });
      // Completed steps carry the accent; the rest are line-weight. A stepper
      // where every dot looks the same communicates nothing.
      calls.push({
        name: 'update_layer',
        args: { nodeId: sid, fill: i <= 1 ? ctx.palette.accent : ctx.palette.line },
      });
    }
    return calls;
  },
};

// ── ui.metric_card ────────────────────────────────────────────────────

export const metricCard: UiComponentDef = {
  id: 'ui.metric_card',
  displayName: 'Metric Card',
  cls: 'container',
  states: ['default', 'hover'],
  grid: 'fill',
  elevation: 2,
  radiusStep: 3,
  techniques: ['ui.value_roll', 'ui.count_up', 'ui.hover_lift', 'ui.chart_draw_on'],
  intrinsic: { width: 220, height: 130 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 2, radiusStep: ctx.shape.cardRadius }),
    ];
    // Label above, figure below, and the figure is nearly three times the label.
    // A metric card whose number and caption are the same size is a form field.
    calls.push(...label(ctx, `${id}_label`, text ?? 'Revenue', {
      x: box.x - box.width * 0.12, y: box.y - box.height * 0.26, width: box.width * 0.7, height: box.height * 0.3,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.8, weight: 500 }));
    calls.push(...label(ctx, `${id}_value`, '128', {
      x: box.x - box.width * 0.12, y: box.y + box.height * 0.12, width: box.width * 0.7, height: box.height * 0.42,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 2.3, weight: 700 }));
    return calls;
  },
};

// ── ui.slider ─────────────────────────────────────────────────────────

export const slider: UiComponentDef = {
  id: 'ui.slider',
  displayName: 'Slider',
  cls: 'control',
  states: ['default', 'hover', 'pressed', 'focused'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 4,
  techniques: ['ui.press_feedback', 'ui.progress_fill', 'ui.drag_lift'],
  intrinsic: { width: 240, height: 24 },
  emit(ctx, id, box) {
    const trackH = Math.max(3, Math.round(box.height * 0.18));
    const knob = Math.round(box.height * 0.85);
    const calls: ToolCall[] = [
      ...surface(ctx, id, { ...box, height: trackH }, {
        fill: ctx.palette.line, level: 0, radiusStep: 4,
      }),
    ];
    // The filled portion is a separate layer, which is what lets a value change
    // animate rather than redraw.
    calls.push(...surface(ctx, `${id}_fill`, {
      x: box.x - box.width * 0.175, y: box.y, width: box.width * 0.65, height: trackH,
    }, { fill: ctx.palette.accent, level: 0, radiusStep: 4 }));
    calls.push(...surface(ctx, `${id}_knob`, {
      x: box.x + box.width * 0.15, y: box.y, width: knob, height: knob,
    }, { fill: ctx.palette.bg, level: 2, radiusStep: 4, borderColor: ctx.palette.accent }));
    return calls;
  },
};

// ── ui.breadcrumb ─────────────────────────────────────────────────────

export const breadcrumb: UiComponentDef = {
  id: 'ui.breadcrumb',
  displayName: 'Breadcrumb',
  cls: 'indicator',
  states: ['default'],
  grid: 'hug',
  elevation: 0,
  radiusStep: 0,
  techniques: ['ui.list_stagger_in', 'ui.tab_switch'],
  intrinsic: { width: 300, height: 24 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    const parts = [text ?? 'Home', 'Section', 'Page'];
    const cell = box.width / parts.length;
    parts.forEach((part, i) => {
      calls.push(...label(ctx, `${id}_part_${i}`, part, {
        x: box.x - box.width / 2 + cell * (i + 0.5), y: box.y, width: cell * 0.8, height: box.height,
      }, {
        // The last crumb is where you ARE, so it is the only one at full weight.
        fill: i === parts.length - 1 ? ctx.palette.fg : ctx.palette.muted,
        sizePx: ctx.basePx * 0.82,
        weight: i === parts.length - 1 ? 600 : 400,
      }));
    });
    return calls;
  },
};

// ── ui.notification_row ───────────────────────────────────────────────

export const notificationRow: UiComponentDef = {
  id: 'ui.notification_row',
  displayName: 'Notification Row',
  cls: 'content',
  states: ['default', 'selected', 'empty'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.swipe_reveal', 'ui.list_stagger_in', 'ui.badge_pulse'],
  intrinsic: { width: 380, height: 60 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    const avatar = Math.round(box.height * 0.62);
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_avatar`, kind: 'shape', shape: 'ellipse', name: 'Avatar',
        x: box.x - box.width / 2 + avatar * 0.85, y: box.y, width: avatar, height: avatar,
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_avatar`, fill: ctx.palette.line } });
    calls.push(...label(ctx, `${id}_label`, text ?? 'New activity', {
      x: box.x + avatar * 0.3, y: box.y - box.height * 0.14, width: box.width * 0.62, height: box.height * 0.4,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.9, weight: 500 }));
    calls.push(...label(ctx, `${id}_meta`, 'just now', {
      x: box.x + avatar * 0.3, y: box.y + box.height * 0.18, width: box.width * 0.62, height: box.height * 0.36,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.76, weight: 400 }));
    // The unread dot — small, accent, and the only accent on the row.
    const dot = Math.max(6, Math.round(box.height * 0.13));
    calls.push({
      name: 'create_layer',
      args: {
        id: `${id}_dot`, kind: 'shape', shape: 'ellipse', name: 'Unread',
        x: box.x + box.width / 2 - dot * 1.6, y: box.y, width: dot, height: dot,
      },
    });
    calls.push({ name: 'update_layer', args: { nodeId: `${id}_dot`, fill: ctx.palette.accent } });
    return calls;
  },
};

export const UI_COMPONENTS_2: readonly UiComponentDef[] = [
  alertBanner,
  emptyState,
  segmentedControl,
  dataTableRow,
  dropdown,
  stepper,
  metricCard,
  slider,
  breadcrumb,
  notificationRow,
];
