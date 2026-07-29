/**
 * Device frames and product-UI layouts.
 *
 * These are what the `saas_product` and `mobile_app` packs lay out into. Without
 * them those packs had techniques and components but nowhere to put them — their
 * `layoutPrefer` lists named four templates that did not exist, and
 * `templatesForPack` returned nothing for either.
 *
 * ## A device frame is not a rounded rectangle
 *
 * It is a bezel with a known aspect ratio, a screen inset, and **safe areas** —
 * the status-bar and home-indicator strips that content must not occupy. Those
 * insets are not decoration: content underneath them is genuinely unreadable on
 * the device, which is why the UI-motion linter has a rule for it.
 *
 * ## Why these live in the design system rather than product-motion
 *
 * They are layouts. `@motion/product-motion` owns how things MOVE; where they sit
 * is the design system's job, and keeping that split means a phone frame gets the
 * same grid, elevation stack and surface treatment as everything else.
 */

import { columnLeft, spanCenterX, spanWidth, baselineY, baselineRows } from '../grid';
import { radius } from '../shape';
import { elevation, glass } from '../depth';
import { mulberry32, pick, type ToolCall } from '../toolcall';
import {
  type ComposeContext,
  type ComposeResult,
  type LayoutTemplate,
  emitText,
  textMetricsFor,
} from '../compose';
import { emitBackdrop, emitPanel, emitRule } from './shared';

function lhPx(ctx: ComposeContext, role: Parameters<typeof textMetricsFor>[1]): number {
  const s = textMetricsFor(ctx, role);
  return s.fontSizePx * s.lineHeight;
}

// ── Device geometry ───────────────────────────────────────────────────

export interface DeviceSpec {
  id: string;
  displayName: string;
  /** Screen aspect, width ÷ height. */
  aspect: number;
  /** Bezel thickness as a fraction of screen width. */
  bezel: number;
  /** Corner radius as a fraction of screen width. */
  cornerFraction: number;
  /** Safe-area insets as fractions of screen HEIGHT. */
  safeTop: number;
  safeBottom: number;
}

/**
 * The device catalogue.
 *
 * Aspect ratios are the real ones. A "phone" at 16:9 has not been a phone since
 * about 2017, and the difference is immediately visible to anyone who uses one.
 */
export const DEVICES: readonly DeviceSpec[] = [
  { id: 'phone_modern', displayName: 'Phone', aspect: 1179 / 2556, bezel: 0.035, cornerFraction: 0.13, safeTop: 0.045, safeBottom: 0.026 },
  { id: 'phone_compact', displayName: 'Compact Phone', aspect: 750 / 1334, bezel: 0.05, cornerFraction: 0.06, safeTop: 0.03, safeBottom: 0.01 },
  { id: 'tablet', displayName: 'Tablet', aspect: 1640 / 2360, bezel: 0.045, cornerFraction: 0.05, safeTop: 0.02, safeBottom: 0.012 },
  { id: 'laptop', displayName: 'Laptop', aspect: 16 / 10, bezel: 0.012, cornerFraction: 0.012, safeTop: 0, safeBottom: 0 },
  { id: 'desktop', displayName: 'Desktop', aspect: 16 / 9, bezel: 0.008, cornerFraction: 0.006, safeTop: 0, safeBottom: 0 },
  { id: 'watch', displayName: 'Watch', aspect: 396 / 484, bezel: 0.09, cornerFraction: 0.24, safeTop: 0.06, safeBottom: 0.06 },
] as const;

export function device(id: string): DeviceSpec {
  return DEVICES.find((d) => d.id === id) ?? DEVICES[0]!;
}

export interface DeviceBox {
  /** The outer bezel. */
  frame: { x: number; y: number; width: number; height: number };
  /** The screen inside it. */
  screen: { x: number; y: number; width: number; height: number };
  /** Absolute y bounds content must stay inside. */
  safe: { top: number; bottom: number };
  cornerRadius: number;
}

/** Fit a device to a height, centred at (cx, cy). */
export function fitDevice(spec: DeviceSpec, cx: number, cy: number, screenHeight: number): DeviceBox {
  const screenWidth = screenHeight * spec.aspect;
  const bezelPx = screenWidth * spec.bezel;
  return {
    frame: { x: cx, y: cy, width: screenWidth + bezelPx * 2, height: screenHeight + bezelPx * 2 },
    screen: { x: cx, y: cy, width: screenWidth, height: screenHeight },
    safe: {
      top: cy - screenHeight / 2 + screenHeight * spec.safeTop,
      bottom: cy + screenHeight / 2 - screenHeight * spec.safeBottom,
    },
    cornerRadius: screenWidth * spec.cornerFraction,
  };
}

/**
 * The bezel, screen and chrome.
 *
 * The bezel is DARKER than the composition background even on a light pack —
 * a device reads as an object because it is a different material from the room
 * it sits in, and a bezel that matches the backdrop reads as a hole.
 */
function emitDeviceFrame(
  ctx: ComposeContext,
  idPrefix: string,
  box: DeviceBox,
  o: { statusBar?: boolean; homeIndicator?: boolean } = {},
): { calls: ToolCall[]; frameId: string; screenId: string } {
  const { palette } = ctx.pack;
  const frameId = `${idPrefix}_frame`;
  const screenId = `${idPrefix}_screen`;

  const calls: ToolCall[] = [
    {
      name: 'create_layer',
      args: {
        id: frameId, kind: 'shape', shape: 'rect', name: 'Device',
        x: box.frame.x, y: box.frame.y, width: box.frame.width, height: box.frame.height,
      },
    },
    {
      name: 'update_layer',
      args: {
        nodeId: frameId,
        // Near-black, never pure — the palette's own bg is the darkest legal value.
        fill: palette.bg,
        cornerRadius: box.cornerRadius + (box.frame.width - box.screen.width) / 2,
      },
    },
    // A device floats. Elevation 5 is the modal tier and it is correct here:
    // this is the object the whole composition is about.
    {
      name: 'set_shadow_stack',
      args: {
        nodeId: frameId,
        shadows: elevation(5, { background: palette.bg, angle: 90, scale: ctx.height / 1080 }),
      },
    },
    {
      name: 'create_layer',
      args: {
        id: screenId, kind: 'shape', shape: 'rect', name: 'Screen',
        x: box.screen.x, y: box.screen.y, width: box.screen.width, height: box.screen.height,
      },
    },
    { name: 'update_layer', args: { nodeId: screenId, fill: palette.surface, cornerRadius: box.cornerRadius } },
  ];

  // Status bar and home indicator, drawn INSIDE the safe insets so they mark the
  // boundary rather than sitting on top of content.
  if (o.statusBar !== false && box.safe.top > box.screen.y - box.screen.height / 2 + 1) {
    const id = `${idPrefix}_statusbar`;
    const h = box.safe.top - (box.screen.y - box.screen.height / 2);
    calls.push(
      ...emitRule(ctx, id, {
        x: box.screen.x + box.screen.width * 0.32,
        y: box.screen.y - box.screen.height / 2 + h / 2,
        width: box.screen.width * 0.16,
        thickness: Math.max(3, h * 0.22),
        fill: palette.muted,
      }),
    );
  }
  if (o.homeIndicator !== false && box.safe.bottom < box.screen.y + box.screen.height / 2 - 1) {
    const id = `${idPrefix}_home`;
    calls.push(
      ...emitRule(ctx, id, {
        x: box.screen.x,
        y: box.screen.y + box.screen.height / 2 - (box.screen.y + box.screen.height / 2 - box.safe.bottom) / 2,
        width: box.screen.width * 0.34,
        thickness: Math.max(3, box.screen.height * 0.005),
        fill: palette.line,
      }),
    );
  }

  return { calls, frameId, screenId };
}

// ── ui.phone_frame ────────────────────────────────────────────────────

export const phoneFrame: LayoutTemplate = {
  id: 'ui.phone_frame',
  displayName: 'Phone Frame',
  intent: 'A phone standing in the frame with a list of rows on screen, safe areas respected.',
  tags: ['product', 'ui', 'mobile', 'device', 'phone'],
  packs: ['mobile_app', 'saas_product'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 6 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.35, 0.62],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [100, 120, 140]), lift: 0.05 }).calls);

    const spec = device(pick(rng, ['phone_modern', 'phone_modern', 'phone_compact']));
    // The phone sits slightly LEFT of centre when there is a headline beside it,
    // and centred when there is not. A device dead-centre with type beside it
    // reads as two unrelated halves.
    const hasCopy = Boolean(content.headline);
    const cx = hasCopy ? spanCenterX(ctx.grid, [7, 11]) : ctx.width / 2;
    const screenH = Math.round(ctx.height * pick(rng, [0.7, 0.78, 0.84]));
    const box = fitDevice(spec, cx, ctx.height / 2, screenH);

    const frame = emitDeviceFrame(ctx, ctx.idPrefix, box);
    calls.push(...frame.calls);
    slots.mark = [frame.frameId];
    boxes.push({ width: box.frame.width, height: box.frame.height });

    // Rows live INSIDE the safe area, never under the status bar.
    const items = (content.items ?? []).slice(0, 6);
    const pad = box.screen.width * 0.06;
    const rowH = Math.round(box.screen.height * 0.09);
    const rowGap = Math.round(rowH * 0.28);
    let y = box.safe.top + rowH / 2 + rowH * 0.4;

    items.forEach((item, i) => {
      if (y + rowH / 2 > box.safe.bottom) return;
      const id = `${ctx.idPrefix}_row_${i}`;
      calls.push(
        ...emitPanel(ctx, id, { x: box.screen.x, y, width: box.screen.width - pad * 2, height: rowH }, {
          level: 0, radiusStep: 2, fill: palette.bg,
        }),
      );
      const labelId = `${ctx.idPrefix}_rowlabel_${i}`;
      calls.push(...emitText(ctx, labelId, item.title ?? item.label ?? `Item ${i + 1}`, 'caption', {
        x: box.screen.x, y, width: box.screen.width - pad * 4, fill: palette.fg, align: 'left',
      }));
      surfaces[labelId] = palette.bg;
      slots.list!.push(id, labelId);
      boxes.push({ width: box.screen.width - pad * 2, height: rowH });
      y += rowH + rowGap;
    });

    if (hasCopy) {
      const span: [number, number] = [0, 5];
      const w = spanWidth(ctx.grid, span);
      const left = columnLeft(ctx.grid, 0);
      const rows = baselineRows(ctx.grid);
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline!, 'headline', {
        x: left + w / 2, y: baselineY(ctx.grid, Math.round(rows * 0.38)), width: w,
        fill: palette.fg, align: 'left',
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'headline') * 2 });

      if (content.cta) {
        const ctaId = `${ctx.idPrefix}_cta`;
        const label = textMetricsFor(ctx, 'title');
        const cw = Math.max(label.fontSizePx * 7, content.cta.length * label.fontSizePx * 0.62);
        const ch = Math.round((label.fontSizePx * 2.6) / (ctx.grid.baseline * 2)) * ctx.grid.baseline * 2;
        const cyy = baselineY(ctx.grid, Math.round(rows * 0.58)) + ch / 2;
        calls.push(
          { name: 'create_layer', args: { id: `${ctaId}_bg`, kind: 'shape', shape: 'rect', name: 'CTA', x: left + cw / 2, y: cyy, width: cw, height: ch } },
          { name: 'update_layer', args: { nodeId: `${ctaId}_bg`, fill: palette.accent, cornerRadius: radius(ctx.pack.shape.controlRadius, { width: cw, height: ch }) } },
          ...emitText(ctx, ctaId, content.cta, 'title', { x: left + cw / 2, y: cyy, width: cw, fill: palette.bg, weight: 600 }),
        );
        slots.cta = [`${ctaId}_bg`, ctaId];
        boxes.push({ width: cw, height: ch });
        surfaces[ctaId] = palette.accent;
      }
    }

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.browser_window ─────────────────────────────────────────────────

export const browserWindow: LayoutTemplate = {
  id: 'ui.browser_window',
  displayName: 'Browser Window',
  intent: 'A browser chrome with a URL bar and tabs, holding a web app on screen.',
  tags: ['product', 'ui', 'browser', 'web', 'device', 'desktop'],
  packs: ['saas_product'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'media', required: false, max: 1 },
    { role: 'list', required: false, max: 4 },
  ],
  negativeSpaceRatio: [0.2, 0.45],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [95, 115]), lift: 0.06 }).calls);

    const w = Math.round(ctx.width * pick(rng, [0.68, 0.76, 0.84]));
    const h = Math.round(w / (16 / 10));
    const cx = ctx.width / 2;
    const cy = Math.round(ctx.height * 0.54);
    const chromeH = Math.round(h * 0.085);

    const winId = `${ctx.idPrefix}_window`;
    calls.push(...emitPanel(ctx, winId, { x: cx, y: cy, width: w, height: h }, { level: 5, radiusStep: 3, fill: palette.bg }));
    slots.mark = [winId];
    boxes.push({ width: w, height: h });

    // Chrome bar, then the traffic lights, then the URL pill. Omitting any one of
    // the three is what makes a hand-drawn browser look like a rectangle with a
    // stripe.
    const chromeId = `${ctx.idPrefix}_chrome`;
    calls.push(
      ...emitRule(ctx, chromeId, {
        x: cx, y: cy - h / 2 + chromeH / 2, width: w, thickness: chromeH, fill: palette.surface,
      }),
    );
    const dot = Math.max(4, chromeH * 0.18);
    for (let i = 0; i < 3; i++) {
      calls.push(
        ...emitRule(ctx, `${ctx.idPrefix}_light_${i}`, {
          x: cx - w / 2 + chromeH * 0.55 + i * dot * 2.2,
          y: cy - h / 2 + chromeH / 2,
          width: dot, thickness: dot,
          fill: palette.line,
        }),
      );
    }
    const pillW = w * 0.44;
    const pillId = `${ctx.idPrefix}_url`;
    calls.push(
      ...emitPanel(ctx, pillId, { x: cx, y: cy - h / 2 + chromeH / 2, width: pillW, height: chromeH * 0.56 }, {
        level: 0, radiusStep: 5, fill: palette.bg,
      }),
    );
    const urlText = `${ctx.idPrefix}_urltext`;
    calls.push(...emitText(ctx, urlText, 'app.example.com', 'caption', {
      x: cx, y: cy - h / 2 + chromeH / 2, width: pillW * 0.8, fill: palette.muted,
    }));
    surfaces[urlText] = palette.bg;

    // Viewport content: a sidebar plus a content area, which is what a web app
    // actually looks like. A single empty rectangle is not a screenshot.
    const viewY = cy - h / 2 + chromeH;
    const viewH = h - chromeH;
    const sidebarW = w * 0.2;
    calls.push(
      ...emitRule(ctx, `${ctx.idPrefix}_sidebar`, {
        x: cx - w / 2 + sidebarW / 2, y: viewY + viewH / 2, width: sidebarW, thickness: viewH, fill: palette.surface,
      }),
    );

    const items = (content.items ?? []).slice(0, 4);
    const cardW = (w - sidebarW) * 0.42;
    const cardH = viewH * 0.3;
    items.forEach((item, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const id = `${ctx.idPrefix}_card_${i}`;
      const x = cx - w / 2 + sidebarW + (w - sidebarW) * (col === 0 ? 0.28 : 0.72);
      const y = viewY + viewH * (row === 0 ? 0.3 : 0.72);
      calls.push(...emitPanel(ctx, id, { x, y, width: cardW, height: cardH }, { level: 1, radiusStep: 2 }));
      const t = `${ctx.idPrefix}_cardtitle_${i}`;
      calls.push(...emitText(ctx, t, item.title ?? item.label ?? `Card ${i + 1}`, 'caption', {
        x, y: y - cardH / 2 + textMetricsFor(ctx, 'caption').fontSizePx * 1.6, width: cardW * 0.8, fill: palette.fg, align: 'left',
      }));
      surfaces[t] = palette.surface;
      slots.list!.push(id, t);
      boxes.push({ width: cardW, height: cardH });
    });

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      const span: [number, number] = [2, 9];
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: spanCenterX(ctx.grid, span),
        y: baselineY(ctx.grid, Math.round(baselineRows(ctx.grid) * 0.1)),
        width: spanWidth(ctx.grid, span), fill: palette.fg,
      }));
      slots.headline = [id];
      boxes.push({ width: spanWidth(ctx.grid, span), height: lhPx(ctx, 'headline') });
    }

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.dashboard_frame ────────────────────────────────────────────────

export const dashboardFrame: LayoutTemplate = {
  id: 'ui.dashboard_frame',
  displayName: 'Dashboard',
  intent: 'A data dashboard — stat tiles across the top, a chart panel beneath.',
  tags: ['product', 'ui', 'dashboard', 'data', 'saas'],
  packs: ['saas_product'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'stat', required: true, max: 4 },
    { role: 'media', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.18, 0.42],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { stat: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: 100, lift: 0.05 }).calls);

    const items = (content.items ?? []).slice(0, 4);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.16);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      const span: [number, number] = [0, 5];
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: columnLeft(ctx.grid, 0) + spanWidth(ctx.grid, span) / 2,
        y: baselineY(ctx.grid, row), width: spanWidth(ctx.grid, span),
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      row += 4;
    }

    // Stat tiles across the top, evenly — a row of peers.
    const per = Math.max(1, Math.floor(ctx.grid.columns / Math.max(1, items.length)));
    const tileH = Math.round(ctx.height * 0.16);
    const tileY = baselineY(ctx.grid, row) + tileH / 2;
    items.forEach((item, i) => {
      const span: [number, number] = [i * per, i * per + per - 1];
      const cx = spanCenterX(ctx.grid, span);
      const tw = spanWidth(ctx.grid, span);
      const id = `${ctx.idPrefix}_tile_${i}`;
      calls.push(...emitPanel(ctx, id, { x: cx, y: tileY, width: tw, height: tileH }, { level: 1, radiusStep: 3 }));

      const valueId = `${ctx.idPrefix}_stat_${i}`;
      const labelId = `${ctx.idPrefix}_statlabel_${i}`;
      calls.push(...emitText(ctx, valueId, item.value ?? '—', 'headline', {
        x: cx, y: tileY - tileH * 0.1, width: tw * 0.8,
        fill: i === 0 ? palette.accent : palette.fg, align: 'left',
      }));
      calls.push(...emitText(ctx, labelId, (item.label ?? '').toUpperCase(), 'overline', {
        x: cx, y: tileY + tileH * 0.26, width: tw * 0.8, fill: palette.muted, align: 'left',
      }));
      surfaces[valueId] = palette.surface;
      surfaces[labelId] = palette.surface;
      slots.stat!.push(id, valueId, labelId);
      boxes.push({ width: tw, height: tileH });
    });
    row += Math.ceil(tileH / ctx.grid.baseline) + 4;

    // The chart panel beneath, full content width.
    const chartSpan: [number, number] = [0, ctx.grid.columns - 1];
    const chartW = spanWidth(ctx.grid, chartSpan);
    const chartH = Math.round(ctx.height * pick(rng, [0.3, 0.36, 0.42]));
    const chartY = baselineY(ctx.grid, row) + chartH / 2;
    const chartId = `${ctx.idPrefix}_chart`;
    calls.push(...emitPanel(ctx, chartId, {
      x: columnLeft(ctx.grid, 0) + chartW / 2, y: chartY, width: chartW, height: chartH,
    }, { level: 2, radiusStep: 3 }));
    boxes.push({ width: chartW, height: chartH });

    // Bars inside it, with a real baseline. A chart panel with nothing in it is a
    // rectangle claiming to be data.
    const barCount = 7;
    const barW = (chartW * 0.78) / (barCount * 1.8);
    const baseY = chartY + chartH * 0.32;
    const barIds: string[] = [];
    for (let i = 0; i < barCount; i++) {
      const id = `${ctx.idPrefix}_bar_${i}`;
      // Deterministic but uneven heights — evenly-stepped bars read as a diagram
      // of a chart rather than as data.
      const t = 0.35 + 0.55 * Math.abs(Math.sin((i + 1) * 1.7 + seed));
      const bh = chartH * 0.5 * t;
      calls.push(
        ...emitRule(ctx, id, {
          x: columnLeft(ctx.grid, 0) + chartW * 0.14 + i * barW * 1.8 + barW / 2,
          y: baseY - bh / 2,
          width: barW,
          thickness: bh,
          fill: i === barCount - 1 ? palette.accent : palette.support,
        }),
      );
      barIds.push(id);
      boxes.push({ width: barW, height: bh });
    }
    slots.media = [chartId, ...barIds];

    return { calls, slots, boxes, surfaces };
  },
};

// ── ui.card_detail_pair ───────────────────────────────────────────────

export const cardDetailPair: LayoutTemplate = {
  id: 'ui.card_detail_pair',
  displayName: 'Card → Detail',
  intent: 'A list of cards beside the detail view one of them expands into. Built for magic move.',
  tags: ['product', 'ui', 'magic-move', 'shared-element', 'transition'],
  packs: ['saas_product', 'mobile_app'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 4 },
    { role: 'media', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.2, 0.45],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: 110, lift: 0.05 }).calls);

    // The list on one side, the detail on the other. The pairing is the point:
    // this template exists so `ui.shared_element_expand` has a FROM and a TO in
    // the same frame, which is what a magic move needs.
    const listOnLeft = rng() > 0.4;
    const listSpan: [number, number] = listOnLeft ? [0, 3] : [8, 11];
    const detailSpan: [number, number] = listOnLeft ? [5, 11] : [0, 6];

    const listW = spanWidth(ctx.grid, listSpan);
    const listX = columnLeft(ctx.grid, listSpan[0]) + listW / 2;
    const rows = baselineRows(ctx.grid);
    const items = (content.items ?? []).slice(0, 4);
    const cardH = Math.round(ctx.height * 0.13);
    let y = baselineY(ctx.grid, Math.round(rows * 0.26)) + cardH / 2;

    items.forEach((item, i) => {
      const id = `${ctx.idPrefix}_card_${i}`;
      calls.push(...emitPanel(ctx, id, { x: listX, y, width: listW, height: cardH }, {
        // The FIRST card is the one that expands, so it sits one elevation step
        // above its siblings — the affordance that says "this one is selected".
        level: i === 0 ? 3 : 1,
        radiusStep: ctx.pack.shape.cardRadius,
      }));
      const t = `${ctx.idPrefix}_cardtitle_${i}`;
      calls.push(...emitText(ctx, t, item.title ?? item.label ?? `Item ${i + 1}`, 'caption', {
        x: listX, y, width: listW * 0.8, fill: i === 0 ? palette.fg : palette.muted, align: 'left',
      }));
      surfaces[t] = palette.surface;
      slots.list!.push(id, t);
      boxes.push({ width: listW, height: cardH });
      y += cardH + ctx.grid.baseline * 3;
    });

    const detailW = spanWidth(ctx.grid, detailSpan);
    const detailH = Math.round(ctx.height * 0.56);
    const detailX = columnLeft(ctx.grid, detailSpan[0]) + detailW / 2;
    const detailY = Math.round(ctx.height * 0.5);
    const detailId = `${ctx.idPrefix}_detail`;
    calls.push(...emitPanel(ctx, detailId, { x: detailX, y: detailY, width: detailW, height: detailH }, {
      level: 4,
      radiusStep: ctx.pack.shape.cardRadius,
      // Glass, so the list reads THROUGH the detail view — which is what makes
      // the expansion feel like the same surface growing rather than a new one
      // appearing on top.
      glassy: true,
    }));
    slots.media = [detailId];
    boxes.push({ width: detailW, height: detailH });

    const g = glass(palette.bg);
    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'title', {
        x: detailX, y: detailY - detailH / 2 + ctx.grid.baseline * 6, width: detailW * 0.8,
        fill: palette.fg, weight: 600, align: 'left',
      }));
      slots.headline = [id];
      surfaces[id] = g.fill;
      boxes.push({ width: detailW * 0.8, height: lhPx(ctx, 'title') });
    }

    return { calls, slots, boxes, surfaces };
  },
};



// ── ui.sheet_stack ────────────────────────────────────────────────────

/**
 * The canonical mobile pattern: content behind, a sheet in front of it.
 *
 * Paired with `ui.sheet_present`, which is the technique that raises it. A sheet
 * layout that did not exist is why `mobile_app` had only two usable layouts —
 * and two layouts across a whole pack means every piece in it repeats.
 */
export const sheetStack: LayoutTemplate = {
  id: 'ui.sheet_stack',
  displayName: 'Sheet Stack',
  intent: 'A phone with a bottom sheet raised over dimmed content behind it.',
  tags: ['product', 'ui', 'mobile', 'sheet', 'device', 'modal'],
  packs: ['mobile_app'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 4 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.32, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];
    const surfaces: Record<string, string> = {};

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [110, 130]), lift: 0.05 }).calls);

    const spec = device('phone_modern');
    const screenH = Math.round(ctx.height * pick(rng, [0.74, 0.8, 0.86]));
    const box = fitDevice(spec, ctx.width / 2, ctx.height / 2, screenH);
    const frame = emitDeviceFrame(ctx, ctx.idPrefix, box);
    calls.push(...frame.calls);
    slots.mark = [frame.frameId];
    boxes.push({ width: box.frame.width, height: box.frame.height });

    // The scrim between the content and the sheet. Without it the sheet reads as
    // a panel that happens to be in front rather than as a layer above.
    const scrimId = `${ctx.idPrefix}_scrim`;
    calls.push(
      ...emitRule(ctx, scrimId, {
        x: box.screen.x, y: box.screen.y, width: box.screen.width, thickness: box.screen.height,
        fill: palette.bg,
      }),
      { name: 'update_layer', args: { nodeId: scrimId, opacity: 45 } },
    );

    // The sheet itself: bottom-anchored, top corners rounded, grabber present.
    const sheetH = Math.round(box.screen.height * pick(rng, [0.52, 0.6, 0.68]));
    const sheetY = box.screen.y + box.screen.height / 2 - sheetH / 2;
    const sheetId = `${ctx.idPrefix}_sheet`;
    calls.push(...emitPanel(ctx, sheetId, {
      x: box.screen.x, y: sheetY, width: box.screen.width, height: sheetH,
    }, { level: 5, radiusStep: 4, fill: palette.surface }));
    slots.media = [sheetId];
    boxes.push({ width: box.screen.width, height: sheetH });

    const grabberId = `${ctx.idPrefix}_grabber`;
    calls.push(
      ...emitRule(ctx, grabberId, {
        x: box.screen.x,
        y: sheetY - sheetH / 2 + box.screen.height * 0.022,
        width: box.screen.width * 0.12,
        thickness: Math.max(3, box.screen.height * 0.005),
        fill: palette.line,
      }),
    );

    let y = sheetY - sheetH / 2 + box.screen.height * 0.075;

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'title', {
        x: box.screen.x, y, width: box.screen.width * 0.82,
        fill: palette.fg, weight: 600, align: 'left',
      }));
      slots.headline = [id];
      surfaces[id] = palette.surface;
      boxes.push({ width: box.screen.width * 0.82, height: lhPx(ctx, 'title') });
      y += lhPx(ctx, 'title') * 1.7;
    }

    const items = (content.items ?? []).slice(0, 4);
    const rowH = Math.round(sheetH * 0.14);
    items.forEach((item, i) => {
      if (y + rowH / 2 > box.safe.bottom) return;
      const id = `${ctx.idPrefix}_sheetrow_${i}`;
      calls.push(...emitPanel(ctx, id, {
        x: box.screen.x, y, width: box.screen.width * 0.88, height: rowH,
      }, { level: 0, radiusStep: 2, fill: palette.bg }));
      const t = `${ctx.idPrefix}_sheetlabel_${i}`;
      calls.push(...emitText(ctx, t, item.title ?? item.label ?? `Option ${i + 1}`, 'caption', {
        x: box.screen.x, y, width: box.screen.width * 0.7, fill: palette.fg, align: 'left',
      }));
      surfaces[t] = palette.bg;
      slots.list!.push(id, t);
      boxes.push({ width: box.screen.width * 0.88, height: rowH });
      y += rowH * 1.25;
    });

    if (content.cta && y + rowH < box.safe.bottom) {
      const id = `${ctx.idPrefix}_cta`;
      const cw = box.screen.width * 0.88;
      const ch = rowH * 1.05;
      const cy = box.safe.bottom - ch * 0.9;
      calls.push(
        { name: 'create_layer', args: { id: `${id}_bg`, kind: 'shape', shape: 'rect', name: 'CTA', x: box.screen.x, y: cy, width: cw, height: ch } },
        { name: 'update_layer', args: { nodeId: `${id}_bg`, fill: palette.accent, cornerRadius: radius(ctx.pack.shape.controlRadius, { width: cw, height: ch }) } },
        ...emitText(ctx, id, content.cta, 'caption', { x: box.screen.x, y: cy, width: cw * 0.8, fill: palette.bg, weight: 600 }),
      );
      slots.cta = [`${id}_bg`, id];
      surfaces[id] = palette.accent;
      boxes.push({ width: cw, height: ch });
    }

    return { calls, slots, boxes, surfaces };
  },
};

export const DEVICE_TEMPLATES = [
  phoneFrame,
  browserWindow,
  dashboardFrame,
  cardDetailPair,
  sheetStack,
] as const;
