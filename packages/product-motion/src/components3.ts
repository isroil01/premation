/**
 * UI components, third set — closing the M2 target.
 *
 * The first set is primitives, the second is state. This one is the furniture
 * that appears once an interface has *structure*: navigation that remembers
 * where you are, containers that hold other containers, and the controls that
 * only exist in dense, professional tools.
 *
 * The shared rule across all three sets, and the reason `emit` returns layers
 * rather than one drawing: **anything that animates separately must be its own
 * layer.** A control drawn as one rectangle animates as one rectangle, and the
 * technique library then has nothing to move.
 */

import type { UiComponentDef } from './components';
import { surface, label } from './components';
import type { ToolCall } from '@motion/design-system';

/** A plain filled rect — dividers, tracks, fills, marks. */
function bar(
  id: string,
  o: { x: number; y: number; width: number; height: number; fill: string; radius?: number },
): ToolCall[] {
  return [
    {
      name: 'create_layer',
      args: { id, kind: 'shape', shape: 'rect', name: id, x: o.x, y: o.y, width: o.width, height: o.height },
    },
    { name: 'update_layer', args: { nodeId: id, fill: o.fill, cornerRadius: o.radius ?? 0 } },
  ];
}

export const sidebarNav: UiComponentDef = {
  id: 'ui.sidebar_nav',
  displayName: 'Sidebar Navigation',
  cls: 'surface',
  states: ['default', 'expanded', 'selected'],
  grid: 'fixed',
  elevation: 1,
  radiusStep: 0,
  techniques: ['ui.sidebar_collapse', 'ui.nav_slide', 'ui.list_stagger_in'],
  intrinsic: { width: 200, height: 400 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: 0 }),
    ];
    const rowH = box.height / 7;
    for (let i = 0; i < 5; i++) {
      const y = box.y - box.height / 2 + rowH * (i + 1);
      // The selected row gets an accent marker on the leading edge — the one
      // piece of colour, so it reads as position rather than decoration.
      if (i === 1) {
        calls.push(...bar(`${id}_marker`, {
          x: box.x - box.width / 2 + 2, y, width: 3, height: rowH * 0.6, fill: ctx.palette.accent,
        }));
      }
      calls.push(...label(ctx, `${id}_item_${i}`, i === 0 ? (text ?? 'Overview') : 'Section', {
        x: box.x - box.width * 0.05, y, width: box.width * 0.7, height: rowH,
      }, { fill: i === 1 ? ctx.palette.fg : ctx.palette.muted, sizePx: ctx.basePx * 0.88, weight: i === 1 ? 600 : 400 }));
    }
    return calls;
  },
};

export const commandPalette: UiComponentDef = {
  id: 'ui.command_palette',
  displayName: 'Command Palette',
  cls: 'overlay',
  states: ['default', 'expanded', 'focused'],
  grid: 'fixed',
  elevation: 3,
  radiusStep: 3,
  techniques: ['ui.search_suggest', 'ui.sheet_present', 'ui.list_stagger_in'],
  intrinsic: { width: 420, height: 240 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 3, radiusStep: ctx.shape.cardRadius }),
    ];
    const fieldH = box.height * 0.2;
    calls.push(...label(ctx, `${id}_query`, text ?? 'Type a command', {
      x: box.x - box.width * 0.05, y: box.y - box.height / 2 + fieldH / 2 + 6,
      width: box.width * 0.8, height: fieldH,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx, weight: 400 }));
    calls.push(...bar(`${id}_rule`, {
      x: box.x, y: box.y - box.height / 2 + fieldH + 6, width: box.width, height: 1, fill: ctx.palette.line,
    }));
    const rowH = (box.height - fieldH) / 4;
    for (let i = 0; i < 3; i++) {
      calls.push(...label(ctx, `${id}_result_${i}`, 'Result', {
        x: box.x - box.width * 0.05, y: box.y - box.height / 2 + fieldH + rowH * (i + 0.9),
        width: box.width * 0.8, height: rowH,
      }, { fill: i === 0 ? ctx.palette.fg : ctx.palette.muted, sizePx: ctx.basePx * 0.9, weight: 400 }));
    }
    return calls;
  },
};

export const kanbanColumn: UiComponentDef = {
  id: 'ui.kanban_column',
  displayName: 'Kanban Column',
  cls: 'container',
  states: ['default', 'expanded'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.drag_lift', 'ui.card_grid_in', 'ui.list_stagger_in'],
  intrinsic: { width: 220, height: 360 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    calls.push(...label(ctx, `${id}_title`, text ?? 'In progress', {
      x: box.x - box.width * 0.15, y: box.y - box.height / 2 + 14, width: box.width * 0.6, height: 24,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.82, weight: 600 }));
    // Three cards, each its own layer so a drag can lift one out of the stack.
    const cardH = (box.height - 40) / 3.4;
    for (let i = 0; i < 3; i++) {
      calls.push(...surface(ctx, `${id}_card_${i}`, {
        x: box.x, y: box.y - box.height / 2 + 40 + cardH * (i + 0.5) + i * 8,
        width: box.width, height: cardH,
      }, { fill: ctx.palette.surface, level: 2, radiusStep: ctx.shape.cardRadius }));
    }
    return calls;
  },
};

export const calendarCell: UiComponentDef = {
  id: 'ui.calendar_cell',
  displayName: 'Calendar Cell',
  cls: 'content',
  states: ['default', 'hover', 'selected'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.press_feedback', 'ui.card_grid_in', 'ui.status_settle'],
  intrinsic: { width: 64, height: 64 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    calls.push(...label(ctx, `${id}_date`, text ?? '14', {
      x: box.x - box.width * 0.22, y: box.y - box.height * 0.22, width: box.width * 0.5, height: box.height * 0.4,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.85, weight: 500 }));
    // Event dots rather than event text: at cell size, type is unreadable and a
    // dot carries the only thing that fits — that something is there.
    const dot = Math.max(4, Math.round(box.height * 0.09));
    for (let i = 0; i < 2; i++) {
      calls.push(...bar(`${id}_dot_${i}`, {
        x: box.x - box.width * 0.2 + i * dot * 2, y: box.y + box.height * 0.25,
        width: dot, height: dot, fill: i === 0 ? ctx.palette.accent : ctx.palette.line, radius: dot / 2,
      }));
    }
    return calls;
  },
};

export const filterChipRow: UiComponentDef = {
  id: 'ui.filter_chip_row',
  displayName: 'Filter Chip Row',
  cls: 'control',
  states: ['default', 'selected'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 4,
  techniques: ['ui.tag_pop_in', 'ui.filter_reflow', 'ui.press_feedback'],
  intrinsic: { width: 340, height: 32 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    const chipW = box.width / 3.4;
    for (let i = 0; i < 3; i++) {
      const cx = box.x - box.width / 2 + chipW * (i + 0.5) + i * 8;
      calls.push(...surface(ctx, `${id}_chip_${i}`, { x: cx, y: box.y, width: chipW, height: box.height }, {
        fill: i === 0 ? ctx.palette.accent : ctx.palette.surface, level: 1, radiusStep: 4,
      }));
      calls.push(...label(ctx, `${id}_chip_label_${i}`, i === 0 ? (text ?? 'All') : 'Filter', {
        x: cx, y: box.y, width: chipW * 0.8, height: box.height,
      }, { fill: i === 0 ? ctx.palette.bg : ctx.palette.muted, sizePx: ctx.basePx * 0.8, weight: 500 }));
    }
    return calls;
  },
};

export const codeDiff: UiComponentDef = {
  id: 'ui.code_diff',
  displayName: 'Code Diff',
  cls: 'content',
  states: ['default'],
  grid: 'fill',
  elevation: 1,
  radiusStep: 2,
  techniques: ['ui.list_stagger_in', 'ui.type_on'],
  intrinsic: { width: 460, height: 200 },
  emit(ctx, id, box) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 1, radiusStep: ctx.shape.cardRadius }),
    ];
    const rowH = box.height / 7;
    for (let i = 0; i < 6; i++) {
      const y = box.y - box.height / 2 + rowH * (i + 0.8);
      // The gutter mark is what makes it a diff rather than a code block: added
      // and removed lines are distinguished by position and colour, not by text.
      const kind = i === 2 ? 'add' : i === 3 ? 'del' : 'same';
      if (kind !== 'same') {
        calls.push(...bar(`${id}_gutter_${i}`, {
          x: box.x - box.width / 2 + 4, y, width: 3, height: rowH * 0.7,
          fill: kind === 'add' ? ctx.palette.accent : ctx.palette.muted,
        }));
      }
      calls.push(...bar(`${id}_line_${i}`, {
        x: box.x - box.width * 0.1 + (i % 3) * 8, y,
        width: box.width * (0.4 + (i % 4) * 0.12), height: Math.max(3, rowH * 0.18),
        fill: kind === 'same' ? ctx.palette.line : ctx.palette.fg, radius: 2,
      }));
    }
    return calls;
  },
};

export const statComparison: UiComponentDef = {
  id: 'ui.stat_comparison',
  displayName: 'Stat with Delta',
  cls: 'content',
  states: ['default'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.value_roll', 'ui.count_up', 'ui.status_settle'],
  intrinsic: { width: 200, height: 90 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    calls.push(...label(ctx, `${id}_label`, text ?? 'Active users', {
      x: box.x - box.width * 0.1, y: box.y - box.height * 0.3, width: box.width * 0.8, height: box.height * 0.3,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.78, weight: 500 }));
    calls.push(...label(ctx, `${id}_value`, '4,281', {
      x: box.x - box.width * 0.18, y: box.y + box.height * 0.12, width: box.width * 0.55, height: box.height * 0.42,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 1.9, weight: 700 }));
    // The delta is subordinate and beside the figure, never above it — a change
    // indicator larger than the value it qualifies inverts the hierarchy.
    calls.push(...label(ctx, `${id}_delta`, '+12%', {
      x: box.x + box.width * 0.3, y: box.y + box.height * 0.16, width: box.width * 0.3, height: box.height * 0.3,
    }, { fill: ctx.palette.accent, sizePx: ctx.basePx * 0.82, weight: 600 }));
    return calls;
  },
};

export const timelineRow: UiComponentDef = {
  id: 'ui.timeline_row',
  displayName: 'Timeline Row',
  cls: 'content',
  states: ['default', 'selected'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.list_stagger_in', 'ui.drag_lift', 'ui.progress_fill'],
  intrinsic: { width: 480, height: 36 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    calls.push(...label(ctx, `${id}_label`, text ?? 'Layer', {
      x: box.x - box.width * 0.38, y: box.y, width: box.width * 0.2, height: box.height,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.8, weight: 500 }));
    calls.push(...bar(`${id}_track`, {
      x: box.x + box.width * 0.12, y: box.y, width: box.width * 0.7, height: box.height * 0.5,
      fill: ctx.palette.line, radius: 3,
    }));
    calls.push(...bar(`${id}_clip`, {
      x: box.x + box.width * 0.02, y: box.y, width: box.width * 0.34, height: box.height * 0.5,
      fill: ctx.palette.accent, radius: 3,
    }));
    return calls;
  },
};

export const inlineBanner: UiComponentDef = {
  id: 'ui.inline_banner',
  displayName: 'Inline Banner',
  cls: 'surface',
  states: ['default', 'error'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.banner_dismiss', 'ui.error_shake', 'ui.toast_slide'],
  intrinsic: { width: 400, height: 44 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 0, radiusStep: 2, borderColor: ctx.palette.line }),
    ];
    calls.push(...label(ctx, `${id}_label`, text ?? 'Heads up', {
      x: box.x - box.width * 0.08, y: box.y, width: box.width * 0.72, height: box.height,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.88, weight: 400 }));
    return calls;
  },
};

export const pagination: UiComponentDef = {
  id: 'ui.pagination',
  displayName: 'Pagination',
  cls: 'control',
  states: ['default', 'selected'],
  grid: 'hug',
  elevation: 0,
  radiusStep: 3,
  techniques: ['ui.press_feedback', 'ui.tab_switch', 'ui.segmented_slide'],
  intrinsic: { width: 220, height: 32 },
  emit(ctx, id, box) {
    const calls: ToolCall[] = [];
    const cell = box.width / 5;
    for (let i = 0; i < 5; i++) {
      const cx = box.x - box.width / 2 + cell * (i + 0.5);
      if (i === 1) {
        calls.push(...surface(ctx, `${id}_current`, { x: cx, y: box.y, width: cell * 0.8, height: box.height }, {
          fill: ctx.palette.accent, level: 1, radiusStep: 3,
        }));
      }
      calls.push(...label(ctx, `${id}_page_${i}`, String(i + 1), {
        x: cx, y: box.y, width: cell * 0.8, height: box.height,
      }, { fill: i === 1 ? ctx.palette.bg : ctx.palette.muted, sizePx: ctx.basePx * 0.82, weight: i === 1 ? 600 : 400 }));
    }
    return calls;
  },
};

export const fileRow: UiComponentDef = {
  id: 'ui.file_row',
  displayName: 'File Row',
  cls: 'content',
  states: ['default', 'hover', 'loading'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.upload_progress', 'ui.list_stagger_in', 'ui.swipe_reveal'],
  intrinsic: { width: 380, height: 48 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    const icon = Math.round(box.height * 0.5);
    calls.push(...bar(`${id}_icon`, {
      x: box.x - box.width / 2 + icon, y: box.y, width: icon * 0.8, height: icon,
      fill: ctx.palette.line, radius: 3,
    }));
    calls.push(...label(ctx, `${id}_name`, text ?? 'document.pdf', {
      x: box.x - box.width * 0.05, y: box.y - box.height * 0.14, width: box.width * 0.6, height: box.height * 0.4,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.88, weight: 500 }));
    // The progress track lives under the name, so a file that is still uploading
    // reads as one row rather than a row plus a bar.
    calls.push(...bar(`${id}_progress_track`, {
      x: box.x - box.width * 0.05, y: box.y + box.height * 0.22, width: box.width * 0.6, height: 3,
      fill: ctx.palette.line, radius: 2,
    }));
    calls.push(...bar(`${id}_progress_fill`, {
      x: box.x - box.width * 0.23, y: box.y + box.height * 0.22, width: box.width * 0.24, height: 3,
      fill: ctx.palette.accent, radius: 2,
    }));
    return calls;
  },
};

export const inspectorField: UiComponentDef = {
  id: 'ui.inspector_field',
  displayName: 'Inspector Field',
  cls: 'control',
  states: ['default', 'focused', 'disabled'],
  grid: 'fill',
  elevation: 0,
  radiusStep: 2,
  techniques: ['ui.inline_edit', 'ui.focus_ring', 'ui.value_roll'],
  intrinsic: { width: 260, height: 30 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [];
    // Label left, field right, on one line — the dense two-column form that
    // every professional tool uses and no marketing page does.
    calls.push(...label(ctx, `${id}_label`, text ?? 'Opacity', {
      x: box.x - box.width * 0.3, y: box.y, width: box.width * 0.35, height: box.height,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.8, weight: 400 }));
    calls.push(...surface(ctx, `${id}_field`, {
      x: box.x + box.width * 0.22, y: box.y, width: box.width * 0.45, height: box.height,
    }, { fill: ctx.palette.surface, level: 0, radiusStep: 2, borderColor: ctx.palette.line }));
    calls.push(...label(ctx, `${id}_value`, '100%', {
      x: box.x + box.width * 0.22, y: box.y, width: box.width * 0.4, height: box.height,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.82, weight: 500 }));
    return calls;
  },
};

export const confirmDialog: UiComponentDef = {
  id: 'ui.confirm_dialog',
  displayName: 'Confirm Dialog',
  cls: 'overlay',
  states: ['default', 'error'],
  grid: 'fixed',
  elevation: 3,
  radiusStep: 3,
  techniques: ['ui.confirm_step', 'ui.sheet_present', 'ui.press_feedback'],
  intrinsic: { width: 340, height: 170 },
  emit(ctx, id, box, text) {
    const calls: ToolCall[] = [
      ...surface(ctx, id, box, { fill: ctx.palette.surface, level: 3, radiusStep: ctx.shape.cardRadius }),
    ];
    calls.push(...label(ctx, `${id}_title`, text ?? 'Delete this?', {
      x: box.x - box.width * 0.08, y: box.y - box.height * 0.26, width: box.width * 0.78, height: box.height * 0.24,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 1.1, weight: 600 }));
    calls.push(...label(ctx, `${id}_body`, 'This cannot be undone.', {
      x: box.x - box.width * 0.08, y: box.y - box.height * 0.02, width: box.width * 0.78, height: box.height * 0.24,
    }, { fill: ctx.palette.muted, sizePx: ctx.basePx * 0.85, weight: 400 }));
    // Two buttons, and the destructive one is NOT the accent. Accent means
    // "the thing to do", and this dialog exists because it might not be.
    const btnW = box.width * 0.3;
    calls.push(...surface(ctx, `${id}_cancel`, {
      x: box.x + box.width * 0.02, y: box.y + box.height * 0.3, width: btnW, height: box.height * 0.2,
    }, { fill: ctx.palette.surface, level: 1, radiusStep: ctx.shape.controlRadius, borderColor: ctx.palette.line }));
    calls.push(...label(ctx, `${id}_cancel_label`, 'Cancel', {
      x: box.x + box.width * 0.02, y: box.y + box.height * 0.3, width: btnW, height: box.height * 0.2,
    }, { fill: ctx.palette.fg, sizePx: ctx.basePx * 0.82, weight: 500 }));
    calls.push(...surface(ctx, `${id}_confirm`, {
      x: box.x + box.width * 0.34, y: box.y + box.height * 0.3, width: btnW, height: box.height * 0.2,
    }, { fill: ctx.palette.accent, level: 1, radiusStep: ctx.shape.controlRadius }));
    calls.push(...label(ctx, `${id}_confirm_label`, 'Delete', {
      x: box.x + box.width * 0.34, y: box.y + box.height * 0.3, width: btnW, height: box.height * 0.2,
    }, { fill: ctx.palette.bg, sizePx: ctx.basePx * 0.82, weight: 600 }));
    return calls;
  },
};

export const UI_COMPONENTS_3: readonly UiComponentDef[] = [
  sidebarNav,
  commandPalette,
  kanbanColumn,
  calendarCell,
  filterChipRow,
  codeDiff,
  statComparison,
  timelineRow,
  inlineBanner,
  pagination,
  fileRow,
  inspectorField,
  confirmDialog,
];
