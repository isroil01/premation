/**
 * More product-UI layouts.
 *
 * ## Why these exist
 *
 * Measured across the registry: `mobile_app` had **three** templates it was
 * allowed to use in total and `saas_product` had **six**. Every other pack had
 * between eleven and thirty. A pack with three layouts does not have a layout
 * decision to make — the caster's whole job at that stage is choosing a
 * structure, and with three options the structure is effectively fixed before
 * the model is asked.
 *
 * That starvation is also why product prompts were the most repetitive: the
 * technique library has 60+ product techniques, and all of them were being cast
 * onto the same three arrangements.
 *
 * ## What is deliberately different about each
 *
 * `ui.phone_frame` requires a `list`, so a product brief with a headline and a
 * CTA and no items could not use it. Half the additions here exist to cover
 * content shapes the original five simply rejected — which is a coverage gap,
 * not a taste gap, and it shows up as "no layout in this pack can hold this
 * beat's content" in the caster's problem log.
 */

import { columnLeft, spanCenterX, spanWidth, baselineY, baselineRows } from '../grid';
import { radius } from '../shape';
import { mulberry32, pick, type ToolCall } from '../toolcall';
import {
  type ComposeContext,
  type ComposeResult,
  type LayoutTemplate,
  emitText,
  textMetricsFor,
} from '../compose';
import { device, fitDevice } from './device';
import { emitBackdrop, emitPanel } from './shared';

function lhPx(ctx: ComposeContext, role: Parameters<typeof textMetricsFor>[1]): number {
  const s = textMetricsFor(ctx, role);
  return s.fontSizePx * s.lineHeight;
}

/** A CTA button — the same construction the other product templates use. */
function emitCta(
  ctx: ComposeContext,
  id: string,
  label: string,
  cx: number,
  cy: number,
): { calls: ToolCall[]; width: number; height: number } {
  const m = textMetricsFor(ctx, 'title');
  const w = Math.max(m.fontSizePx * 7, label.length * m.fontSizePx * 0.62);
  // Whole baselines, so the button's CENTRE lands on the grid and everything
  // inside it does too.
  const h = Math.round((m.fontSizePx * 2.6) / (ctx.grid.baseline * 2)) * ctx.grid.baseline * 2;
  return {
    calls: [
      { name: 'create_layer', args: { id: `${id}_bg`, kind: 'shape', shape: 'rect', name: 'CTA', x: cx, y: cy, width: w, height: h } },
      { name: 'update_layer', args: { nodeId: `${id}_bg`, fill: ctx.pack.palette.accent, cornerRadius: radius(ctx.pack.shape.controlRadius, { width: w, height: h }) } },
      ...emitText(ctx, id, label, 'title', { x: cx, y: cy, width: w, fill: ctx.pack.palette.bg, weight: 600 }),
    ],
    width: w,
    height: h,
  };
}

// ── ui.phone_copy ─────────────────────────────────────────────────────

/**
 * The layout `ui.phone_frame` could not be.
 *
 * Same device, but the content contract is headline + support + CTA rather than
 * a required `list`. A product brief whose beat is "here is the promise" has no
 * items to show, and before this the pack's answer was to reject every device
 * layout and fall back to a bare card.
 */
export const phoneCopy: LayoutTemplate = {
  id: 'ui.phone_copy',
  displayName: 'Phone and Copy',
  intent: 'A phone held to one side with the argument set beside it. No list required.',
  tags: ['product', 'ui', 'mobile', 'device', 'phone', 'hero'],
  packs: ['mobile_app', 'saas_product'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.4, 0.66],
  variants: 4,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [95, 115, 135]), lift: 0.05 }).calls);

    // Which side the device sits on is the variant that changes the read most —
    // device-right is the marketing default, device-left reads as a case study.
    const deviceRight = rng() > 0.4;
    const spec = device('phone_modern');
    const screenH = Math.round(ctx.height * pick(rng, [0.72, 0.8]));
    const dcx = deviceRight ? spanCenterX(ctx.grid, [8, 11]) : spanCenterX(ctx.grid, [0, 3]);
    const box = fitDevice(spec, dcx, ctx.height / 2, screenH);

    const screenId = `${ctx.idPrefix}_screen`;
    calls.push(
      ...emitPanel(ctx, `${ctx.idPrefix}_device`, box.frame, { level: 3, radiusStep: 4, fill: palette.fg }),
      ...emitPanel(ctx, screenId, box.screen, { level: 0, radiusStep: 3, fill: palette.bg }),
    );
    slots.mark = [`${ctx.idPrefix}_device`, screenId];
    boxes.push({ width: box.frame.width, height: box.frame.height });

    const typeSpan: [number, number] = deviceRight ? [0, 6] : [5, 11];
    const w = spanWidth(ctx.grid, typeSpan);
    const left = columnLeft(ctx.grid, typeSpan[0]);
    const cx = left + w / 2;
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * pick(rng, [0.3, 0.34]));

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'overline') });
      row += 4;
    }

    const id = `${ctx.idPrefix}_headline`;
    calls.push(...emitText(ctx, id, content.headline!, 'headline', {
      x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.fg, align: 'left',
    }));
    slots.headline = [id];
    boxes.push({ width: w, height: lhPx(ctx, 'headline') * 2 });
    row += 8;

    if (content.support) {
      const sid = `${ctx.idPrefix}_support`;
      calls.push(...emitText(ctx, sid, content.support, 'body', {
        x: cx, y: baselineY(ctx.grid, row), width: Math.min(w, textMetricsFor(ctx, 'body').fontSizePx * 34),
        fill: palette.muted, align: 'left',
      }));
      slots.support = [sid];
      boxes.push({ width: w, height: lhPx(ctx, 'body') * 2 });
      row += 6;
    }

    if (content.cta) {
      const cta = emitCta(ctx, `${ctx.idPrefix}_cta`, content.cta, left + 0, baselineY(ctx.grid, row));
      // Left-aligned with the type, so the button's LEFT edge is on the column
      // rather than its centre — a centred button under left-aligned copy is the
      // most common alignment mistake in a product layout.
      const shifted = cta.calls.map((c) =>
        c.args.x !== undefined ? { ...c, args: { ...c.args, x: left + cta.width / 2 } } : c,
      );
      calls.push(...shifted);
      slots.cta = [`${ctx.idPrefix}_cta_bg`, `${ctx.idPrefix}_cta`];
      boxes.push({ width: cta.width, height: cta.height });
      surfaces[`${ctx.idPrefix}_cta`] = palette.accent;
    }

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.metric_row ─────────────────────────────────────────────────────

/**
 * A row of metric tiles — the dashboard's top strip, on its own.
 *
 * `ui.dashboard_frame` draws a whole application; this is the one component that
 * carries a number, at a size you can actually read. A product beat whose job is
 * "the result was 4.2×" does not need a browser window around it.
 */
export const metricRow: LayoutTemplate = {
  id: 'ui.metric_row',
  displayName: 'Metric Row',
  intent: 'Two to four metric tiles across the frame, numbers set large. No chrome.',
  tags: ['product', 'ui', 'stat', 'metric', 'data', 'proof'],
  packs: ['saas_product', 'mobile_app'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'stat', required: true, max: 4 },
  ],
  negativeSpaceRatio: [0.3, 0.55],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { stat: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [90, 110]), lift: 0.04 }).calls);

    const items = (content.items ?? []).slice(0, 4);
    const n = Math.max(1, items.length);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.3);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      const span: [number, number] = [0, 11];
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: columnLeft(ctx.grid, 0) + spanWidth(ctx.grid, span) / 2,
        y: baselineY(ctx.grid, row), width: spanWidth(ctx.grid, span),
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: spanWidth(ctx.grid, span), height: lhPx(ctx, 'overline') });
      row += 6;
    }

    // Whole columns per tile, so the tiles land on the grid rather than on an
    // even division of the frame that happens to miss every column edge.
    const per = Math.max(2, Math.floor(ctx.grid.columns / n));
    const tileH = Math.round(ctx.height * pick(rng, [0.2, 0.24, 0.28]));
    const cy = baselineY(ctx.grid, row) + tileH / 2;

    items.forEach((item, i) => {
      const span: [number, number] = [i * per, i * per + per - 1];
      const w = spanWidth(ctx.grid, span);
      const cx = spanCenterX(ctx.grid, span);
      const tileId = `${ctx.idPrefix}_tile_${i}`;
      calls.push(...emitPanel(ctx, tileId, { x: cx, y: cy, width: w, height: tileH }, {
        level: 1, radiusStep: ctx.pack.shape.cardRadius, fill: palette.surface,
      }));

      const valueId = `${ctx.idPrefix}_value_${i}`;
      calls.push(...emitText(ctx, valueId, item.value ?? item.title ?? '—', 'display', {
        x: cx, y: cy - tileH * 0.1, width: w * 0.86, fill: palette.fg,
      }));
      surfaces[valueId] = palette.surface;

      const labelId = `${ctx.idPrefix}_label_${i}`;
      calls.push(...emitText(ctx, labelId, (item.label ?? item.body ?? '').toUpperCase(), 'overline', {
        x: cx, y: cy + tileH * 0.28, width: w * 0.86, fill: palette.muted,
      }));
      surfaces[labelId] = palette.surface;

      slots.stat!.push(tileId, valueId, labelId);
      boxes.push({ width: w, height: tileH });
    });

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.notification_stack ─────────────────────────────────────────────

/**
 * A leaning stack of notification cards.
 *
 * The one product layout with no device and no chrome — the cards ARE the
 * subject. It exists because a `mobile_app` beat about alerts, messages or
 * activity had to be drawn inside a phone frame, which shrinks each row to
 * something unreadable at video size.
 */
export const notificationStack: LayoutTemplate = {
  id: 'ui.notification_stack',
  displayName: 'Notification Stack',
  intent: 'Three or four notification cards stacked with a slight offset, shown at readable size.',
  tags: ['product', 'ui', 'mobile', 'notification', 'list', 'activity'],
  packs: ['mobile_app', 'saas_product'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 4 },
  ],
  negativeSpaceRatio: [0.34, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [100, 130]), lift: 0.05 }).calls);

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.24);

    if (content.headline) {
      const span: [number, number] = [2, 9];
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: spanCenterX(ctx.grid, span), y: baselineY(ctx.grid, row), width: spanWidth(ctx.grid, span),
        fill: palette.fg,
      }));
      slots.headline = [id];
      boxes.push({ width: spanWidth(ctx.grid, span), height: lhPx(ctx, 'headline') });
      row += 8;
    }

    const items = (content.items ?? []).slice(0, 4);
    const span: [number, number] = pick(rng, [[2, 9], [3, 8]] as [number, number][]);
    const w = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);
    const cardH = Math.round(ctx.height * 0.13);
    // Whole baselines between cards, so every card centre is on the grid.
    const step = Math.round((cardH * 1.18) / ctx.grid.baseline) * ctx.grid.baseline;
    let y = baselineY(ctx.grid, row) + cardH / 2;

    items.forEach((item, i) => {
      const id = `${ctx.idPrefix}_note_${i}`;
      // Each card slightly narrower than the one above it: the stack reads as
      // depth without needing a perspective transform, and it is what a real
      // notification group looks like on both platforms.
      const cw = Math.round(w * (1 - i * 0.045));
      calls.push(...emitPanel(ctx, id, { x: cx, y, width: cw, height: cardH }, {
        level: 3 - Math.min(2, i) as 1 | 2 | 3,
        radiusStep: 3,
        fill: palette.surface,
      }));

      const titleId = `${ctx.idPrefix}_notetitle_${i}`;
      calls.push(...emitText(ctx, titleId, item.title ?? item.label ?? `Update ${i + 1}`, 'title', {
        x: cx, y: y - cardH * 0.16, width: cw * 0.86, fill: palette.fg, align: 'left',
      }));
      surfaces[titleId] = palette.surface;

      if (item.body) {
        const bodyId = `${ctx.idPrefix}_notebody_${i}`;
        calls.push(...emitText(ctx, bodyId, item.body, 'caption', {
          x: cx, y: y + cardH * 0.2, width: cw * 0.86, fill: palette.muted, align: 'left',
        }));
        surfaces[bodyId] = palette.surface;
        slots.list!.push(bodyId);
      }

      slots.list!.push(id, titleId);
      boxes.push({ width: cw, height: cardH });
      y += step;
    });

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.split_app_copy ─────────────────────────────────────────────────

/**
 * An app pane on one side, the argument on the other.
 *
 * `ui.browser_window` centres its chrome and has no room for copy beside it.
 * This is the layout every SaaS landing page opens with, and the pack could not
 * produce it.
 */
export const splitAppCopy: LayoutTemplate = {
  id: 'ui.split_app_copy',
  displayName: 'App and Copy',
  intent: 'An application pane bleeding off one edge with the argument set against it.',
  tags: ['product', 'ui', 'web', 'split', 'hero', 'saas'],
  packs: ['saas_product'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'cta', required: false, max: 1 },
    { role: 'list', required: false, max: 4 },
  ],
  negativeSpaceRatio: [0.26, 0.5],
  variants: 4,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: 100, lift: 0.05 }).calls);

    const appRight = rng() > 0.35;
    const typeSpan: [number, number] = appRight ? [0, 4] : [7, 11];
    const w = spanWidth(ctx.grid, typeSpan);
    const left = columnLeft(ctx.grid, typeSpan[0]);
    const cx = left + w / 2;

    // The pane BLEEDS off its edge. An app screenshot inset to the margin reads
    // as a screenshot; one running off the frame reads as the product.
    const paneW = Math.round(ctx.width * pick(rng, [0.52, 0.58]));
    const paneH = Math.round(ctx.height * 0.66);
    const paneX = appRight ? ctx.width - paneW / 2 + ctx.grid.margin * 0.5 : paneW / 2 - ctx.grid.margin * 0.5;
    const paneId = `${ctx.idPrefix}_pane`;
    calls.push(...emitPanel(ctx, paneId, { x: paneX, y: ctx.height / 2, width: paneW, height: paneH }, {
      level: 3, radiusStep: ctx.pack.shape.cardRadius, fill: palette.surface,
    }));
    slots.media = [paneId];
    boxes.push({ width: paneW, height: paneH });

    // A few rows inside the pane, so it reads as an interface rather than a
    // blank card.
    const items = (content.items ?? []).slice(0, 4);
    const rowH = Math.round(paneH * 0.11);
    let ry = ctx.height / 2 - paneH / 2 + rowH * 1.6;
    items.forEach((item, i) => {
      const id = `${ctx.idPrefix}_approw_${i}`;
      calls.push(...emitPanel(ctx, id, { x: paneX, y: ry, width: paneW * 0.84, height: rowH }, {
        level: 0, radiusStep: 2, fill: palette.bg,
      }));
      const labelId = `${ctx.idPrefix}_approw_label_${i}`;
      // `overline`, not `caption`. This template is the only product layout that
      // puts marketing body copy and in-app row labels in the SAME frame, and
      // caption sits one rung below body — close enough that the linter reads the
      // two as one block, correctly. Overline is two rungs down and 700 weight,
      // so the interface chrome reads as chrome instead of as more prose.
      calls.push(...emitText(ctx, labelId, (item.title ?? item.label ?? `Row ${i + 1}`).toUpperCase(), 'overline', {
        x: paneX, y: ry, width: paneW * 0.7, fill: palette.fg, align: 'left',
      }));
      surfaces[labelId] = palette.bg;
      slots.list = [...(slots.list ?? []), id, labelId];
      boxes.push({ width: paneW * 0.84, height: rowH });
      ry += Math.round((rowH * 1.5) / ctx.grid.baseline) * ctx.grid.baseline;
    });

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.32);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'overline') });
      row += 4;
    }

    const hid = `${ctx.idPrefix}_headline`;
    calls.push(...emitText(ctx, hid, content.headline!, 'headline', {
      x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.fg, align: 'left',
    }));
    slots.headline = [hid];
    boxes.push({ width: w, height: lhPx(ctx, 'headline') * 2 });
    row += 8;

    if (content.support) {
      const sid = `${ctx.idPrefix}_support`;
      calls.push(...emitText(ctx, sid, content.support, 'body', {
        x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.muted, align: 'left',
      }));
      slots.support = [sid];
      boxes.push({ width: w, height: lhPx(ctx, 'body') * 2 });
      row += 6;
    }

    if (content.cta) {
      const cta = emitCta(ctx, `${ctx.idPrefix}_cta`, content.cta, left, baselineY(ctx.grid, row));
      calls.push(...cta.calls.map((c) =>
        c.args.x !== undefined ? { ...c, args: { ...c.args, x: left + cta.width / 2 } } : c,
      ));
      slots.cta = [`${ctx.idPrefix}_cta_bg`, `${ctx.idPrefix}_cta`];
      boxes.push({ width: cta.width, height: cta.height });
      surfaces[`${ctx.idPrefix}_cta`] = palette.accent;
    }

    return { calls, slots, boxes, surfaces };
  },
};

export const DEVICE_TEMPLATES_2 = [phoneCopy, metricRow, notificationStack, splitAppCopy] as const;
