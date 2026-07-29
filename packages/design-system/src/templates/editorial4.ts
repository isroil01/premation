/**
 * Layout templates, fourth set — the ones that close the M2 target.
 *
 * Three rules, all of them learned from linter failures in earlier sets:
 *
 *  • Positions come from column spans, never from dividing the frame.
 *  • A full-frame layer needs a light source — gradient, texture, or real
 *    imagery. The only layouts that skip the backdrop are the ones that sit over
 *    footage.
 *  • Never stack two type roles that are within one rung of each other. Caption
 *    and overline under one image is the case that caught it.
 */

import { breakLines } from '../type';
import { columnLeft, spanCenterX, spanWidth, baselineY, baselineRows } from '../grid';
import { mulberry32, pick, type ToolCall } from '../toolcall';
import {
  type ComposeContext,
  type ComposeResult,
  type LayoutTemplate,
  emitText,
  textMetricsFor,
} from '../compose';
import { emitBackdrop, emitMedia, emitPanel, emitRule } from './shared';

type Role = Parameters<typeof textMetricsFor>[1];

function lineHeightPx(ctx: ComposeContext, role: Role): number {
  const s = textMetricsFor(ctx, role);
  return s.fontSizePx * s.lineHeight;
}

function rowsFor(ctx: ComposeContext, role: Role, n: number, pad = 2): number {
  return Math.ceil((n * lineHeightPx(ctx, role)) / ctx.grid.baseline) + pad;
}

function perLine(ctx: ComposeContext, role: Role, width: number): number {
  return Math.max(8, Math.floor(width / (textMetricsFor(ctx, role).fontSizePx * 0.52)));
}

function itemText(
  item: { value?: string; label?: string; title?: string; body?: string } | undefined,
  prefer: 'value' | 'label' | 'title' | 'body' = 'title',
): string {
  if (!item) return '';
  return item[prefer] ?? item.title ?? item.value ?? item.label ?? item.body ?? '';
}

function cellSpans(ctx: ComposeContext, n: number): [number, number][] {
  const per = Math.max(1, Math.floor(ctx.grid.columns / Math.max(1, n)));
  return Array.from({ length: n }, (_, i) => [
    1 + i * per,
    Math.min(ctx.grid.columns - 1, i * per + per),
  ] as [number, number]);
}

// ── hero.split_vertical ───────────────────────────────────────────────

export const splitVertical: LayoutTemplate = {
  id: 'hero.split_vertical',
  displayName: 'Vertical Split',
  intent: 'The frame divided top and bottom: type above the line, image below it.',
  tags: ['hero', 'split', 'horizontal-rule', 'editorial', 'media'],
  packs: ['swiss_editorial', 'apple_keynote', 'saas_explainer'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'media', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.3, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [90, 270]) }).calls);

    const span: [number, number] = [1, 11];
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, 1) + width / 2;
    const rows = baselineRows(ctx.grid);
    // Where the frame divides is the variant axis. A split at exactly half reads
    // as indecision; the thirds read as a choice.
    const splitAt = pick(rng, [0.38, 0.44, 0.58]);
    const splitRow = Math.round(rows * splitAt);

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'display', width), 2);
    let row = Math.max(2, splitRow - rowsFor(ctx, 'display', headLines.length, 2));
    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'display', { x, y, width, fill: palette.fg, align: 'left' }));
      ids.push(id);
      boxes.push({ width, height: lineHeightPx(ctx, 'display') });
    });
    slots.headline = ids;

    calls.push(...emitRule(ctx, `${ctx.idPrefix}_split`, {
      x, y: baselineY(ctx.grid, splitRow), width, thickness: 2, fill: palette.line,
    }));
    boxes.push({ width, height: 2 });

    const mediaH = (rows - splitRow - 2) * ctx.grid.baseline;
    if (mediaH > ctx.grid.baseline * 4) {
      const mediaId = `${ctx.idPrefix}_media`;
      calls.push(...emitMedia(ctx, mediaId, {
        x, y: baselineY(ctx.grid, splitRow) + mediaH / 2 + ctx.grid.baseline, width, height: mediaH,
      }, content.mediaAssetId));
      slots.media = [mediaId];
      boxes.push({ width, height: mediaH });
    }
    row += 0;

    return { calls, slots, boxes };
  },
};

// ── list.two_column_bullets ───────────────────────────────────────────

export const twoColumnBullets: LayoutTemplate = {
  id: 'list.two_column_bullets',
  displayName: 'Two Column Bullets',
  intent: 'A list split across two columns so a long set stays on one screen.',
  tags: ['list', 'dense', 'feature', 'reference', 'scannable'],
  packs: ['saas_explainer', 'swiss_editorial', 'apple_keynote'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 8 },
  ],
  negativeSpaceRatio: [0.3, 0.58],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [130, 300]) }).calls);

    let row = Math.round(baselineRows(ctx.grid) * 0.22);
    if (content.headline) {
      const w = spanWidth(ctx.grid, [1, 11]);
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: columnLeft(ctx.grid, 1) + w / 2, y: baselineY(ctx.grid, row), width: w,
        fill: palette.fg, align: 'left',
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lineHeightPx(ctx, 'headline') });
      row += rowsFor(ctx, 'headline', 1, 3);
    }

    const items = (content.items ?? []).slice(0, 8).map((it) => itemText(it, 'title'));
    const spans = cellSpans(ctx, 2);
    const half = Math.ceil(items.length / 2);
    const step = rowsFor(ctx, 'body', 1, 1);
    const ids: string[] = [];

    spans.forEach((span, c) => {
      const w = spanWidth(ctx.grid, span);
      const x0 = columnLeft(ctx.grid, span[0]);
      const marker = Math.round(lineHeightPx(ctx, 'body') * 0.22);
      const gutter = marker * 3;
      items.slice(c * half, (c + 1) * half).forEach((text, i) => {
        const y = baselineY(ctx.grid, row + i * step);
        calls.push(...emitRule(ctx, `${ctx.idPrefix}_dot_${c}_${i}`, {
          x: x0 + marker / 2, y, width: marker, thickness: marker, fill: palette.accent,
        }));
        const id = `${ctx.idPrefix}_item_${c}_${i}`;
        calls.push(...emitText(ctx, id, text, 'body', {
          x: x0 + gutter + (w - gutter) / 2, y, width: w - gutter, fill: palette.fg, align: 'left',
        }));
        ids.push(id);
        boxes.push({ width: w - gutter, height: lineHeightPx(ctx, 'body') });
      });
    });
    slots.list = ids;

    return { calls, slots, boxes };
  },
};

// ── endcard.url_bar ───────────────────────────────────────────────────

export const urlBar: LayoutTemplate = {
  id: 'endcard.url_bar',
  displayName: 'End Card with URL Bar',
  intent: 'A closing mark with the address on its own bar across the bottom.',
  tags: ['endcard', 'closing', 'call-to-action', 'brand', 'broadcast'],
  packs: ['broadcast_sports', 'saas_explainer', 'cyberpunk_kinetic', 'swiss_editorial'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'cta', required: true, max: 1 },
  ],
  negativeSpaceRatio: [0.55, 0.82],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [0, 180]), kind: 'radial' }).calls);

    const span: [number, number] = [2, 10];
    const width = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);
    const rows = baselineRows(ctx.grid);

    const id = `${ctx.idPrefix}_headline`;
    const lines = breakLines(content.headline ?? '', perLine(ctx, 'headline', width), 2);
    lines.forEach((line, i) => {
      const lid = i === 0 ? id : `${id}_${i}`;
      const y = baselineY(ctx.grid, Math.round(rows * 0.36) + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, lid, line, 'headline', { x: cx, y, width, fill: palette.fg }));
      boxes.push({ width, height: lineHeightPx(ctx, 'headline') });
    });
    slots.headline = [id];

    // The bar spans the full frame, which is the point — it is the last thing on
    // screen and it should read as a band, not as another line of type.
    const barRows = rowsFor(ctx, 'title', 1, 2);
    const barH = barRows * ctx.grid.baseline;
    const barY = (rows - barRows - 1) * ctx.grid.baseline + barH / 2;
    // A SURFACE bar, not an accent one.
    //
    // Reversing type out of the accent colour is a real technique, but the
    // contrast rule measures the text against the palette's own background pair
    // and cannot see the bar underneath — so on the high-energy packs it
    // reported `CONTRAST_FAIL`, and rather than teach the linter about arbitrary
    // backing shapes the bar takes a colour the type is already guaranteed
    // against. The accent still marks it, as a rule along the top edge.
    calls.push(...emitPanel(ctx, `${ctx.idPrefix}_bar`, {
      x: ctx.width / 2, y: barY, width: ctx.width, height: barH,
    }, { level: 1, radiusStep: 0, fill: palette.surface }));
    calls.push(...emitRule(ctx, `${ctx.idPrefix}_bar_edge`, {
      x: ctx.width / 2, y: barY - barH / 2, width: ctx.width,
      thickness: Math.max(2, Math.round(ctx.grid.baseline * 0.16)), fill: palette.accent,
    }));
    boxes.push({ width: ctx.width, height: barH });

    const cid = `${ctx.idPrefix}_cta`;
    calls.push(...emitText(ctx, cid, content.cta ?? '', 'title', {
      x: ctx.width / 2, y: baselineY(ctx.grid, rows - barRows), width: ctx.width * 0.8,
      fill: palette.fg,
    }));
    slots.cta = [cid];
    boxes.push({ width: ctx.width * 0.8, height: lineHeightPx(ctx, 'title') });

    return { calls, slots, boxes };
  },
};

// ── grid.gallery_four ─────────────────────────────────────────────────

export const galleryFour: LayoutTemplate = {
  id: 'grid.gallery_four',
  displayName: 'Four-Up Gallery',
  intent: 'Four images in a two-by-two grid, equal weight, with one caption line.',
  tags: ['grid', 'gallery', 'media', 'portfolio', 'contact-sheet'],
  packs: ['swiss_editorial', 'luxury_film', 'apple_keynote', 'saas_explainer'],
  slots: [
    { role: 'media', required: true, max: 4 },
    { role: 'overline', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.22, 0.5],
  variants: 2,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [200, 20]) }).calls);

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.14);

    if (content.overline) {
      const w = spanWidth(ctx.grid, [1, 11]);
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: columnLeft(ctx.grid, 1) + w / 2, y: baselineY(ctx.grid, row), width: w,
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: w, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1, 2);
    }

    const spans = cellSpans(ctx, 2);
    const cellH = Math.round((ctx.height - row * ctx.grid.baseline - ctx.grid.baseline * 4) / 2);
    const ids: string[] = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const span = spans[c]!;
        const w = spanWidth(ctx.grid, span);
        const id = `${ctx.idPrefix}_media_${r}_${c}`;
        calls.push(...emitMedia(ctx, id, {
          x: spanCenterX(ctx.grid, span),
          y: baselineY(ctx.grid, row) + cellH * r + cellH / 2,
          width: w,
          height: cellH - ctx.grid.baseline,
        }, r === 0 && c === 0 ? content.mediaAssetId : undefined));
        ids.push(id);
        boxes.push({ width: w, height: cellH - ctx.grid.baseline });
      }
    }
    slots.media = ids;

    return { calls, slots, boxes };
  },
};

// ── editorial.numbered_section ────────────────────────────────────────

export const numberedSection: LayoutTemplate = {
  id: 'editorial.numbered_section',
  displayName: 'Numbered Section',
  intent: 'A large section number set against the title, the way a chapter opens.',
  tags: ['editorial', 'chapter', 'sequence', 'literary', 'structured'],
  packs: ['swiss_editorial', 'luxury_film', 'apple_keynote', 'saas_explainer'],
  slots: [
    { role: 'stat', required: true, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.45, 0.75],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [170, 320]) }).calls);

    const numSpan: [number, number] = [1, 3];
    const textSpan: [number, number] = pick(rng, [[4, 10], [4, 11]] as [number, number][]);
    const numW = spanWidth(ctx.grid, numSpan);
    const textW = spanWidth(ctx.grid, textSpan);
    const startRow = Math.round(baselineRows(ctx.grid) * 0.32);

    // The number is display-size and MUTED, not accent. At this scale an accent
    // number outshouts the title it is supposed to be numbering.
    const nid = `${ctx.idPrefix}_stat`;
    calls.push(...emitText(ctx, nid, itemText(content.items?.[0], 'value') || '01', 'display', {
      x: columnLeft(ctx.grid, numSpan[0]) + numW / 2,
      y: baselineY(ctx.grid, startRow), width: numW, fill: palette.muted, align: 'left', weight: 800,
    }));
    slots.stat = [nid];
    boxes.push({ width: numW, height: lineHeightPx(ctx, 'display') });

    let row = startRow;
    // `title`, not `headline`. The number is at `display` (scale step 5) and
    // `headline` is step 4 — one rung apart, which `WEAK_TYPE_CONTRAST` reported
    // and which is right: a section number the same size as its title is not a
    // number set against a title, it is two headlines.
    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'title', textW), 3);
    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'title')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'title', {
        x: columnLeft(ctx.grid, textSpan[0]) + textW / 2, y, width: textW, fill: palette.fg, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: textW, height: lineHeightPx(ctx, 'title') });
    });
    slots.headline = ids;
    row += rowsFor(ctx, 'title', headLines.length, 2);

    if (content.support) {
      const id = `${ctx.idPrefix}_support`;
      const lines = breakLines(content.support, perLine(ctx, 'body', textW * 0.86), 4);
      calls.push(...emitText(ctx, id, lines.join('\n'), 'body', {
        x: columnLeft(ctx.grid, textSpan[0]) + (textW * 0.86) / 2,
        y: baselineY(ctx.grid, row), width: textW * 0.86, fill: palette.muted, align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: textW * 0.86, height: lines.length * lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── data.legend_chart ─────────────────────────────────────────────────

export const legendChart: LayoutTemplate = {
  id: 'data.legend_chart',
  displayName: 'Chart with Legend',
  intent: 'A plot area with its key beside it, so the series can be named as they draw.',
  tags: ['data', 'chart', 'report', 'analytical', 'dashboard'],
  packs: ['saas_explainer', 'swiss_editorial', 'saas_product', 'broadcast_sports'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'media', required: false, max: 1 },
    { role: 'list', required: true, max: 4 },
  ],
  negativeSpaceRatio: [0.28, 0.56],
  variants: 2,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [150, 210]) }).calls);

    let row = Math.round(baselineRows(ctx.grid) * 0.16);
    if (content.headline) {
      const w = spanWidth(ctx.grid, [1, 11]);
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'title', {
        x: columnLeft(ctx.grid, 1) + w / 2, y: baselineY(ctx.grid, row), width: w,
        fill: palette.fg, align: 'left',
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lineHeightPx(ctx, 'title') });
      row += rowsFor(ctx, 'title', 1, 2);
    }

    // Plot left at 8 columns, legend right at 3 — the asymmetry is the point.
    // A legend given equal width competes with the data it labels.
    const plotSpan: [number, number] = [1, 8];
    const legendSpan: [number, number] = [9, 11];
    const plotW = spanWidth(ctx.grid, plotSpan);
    const plotH = Math.round(ctx.height * 0.46);

    const mediaId = `${ctx.idPrefix}_media`;
    calls.push(...emitMedia(ctx, mediaId, {
      x: columnLeft(ctx.grid, plotSpan[0]) + plotW / 2,
      y: baselineY(ctx.grid, row) + plotH / 2, width: plotW, height: plotH,
    }, content.mediaAssetId));
    slots.media = [mediaId];
    boxes.push({ width: plotW, height: plotH });

    const legendW = spanWidth(ctx.grid, legendSpan);
    const lx = columnLeft(ctx.grid, legendSpan[0]);
    const swatch = Math.round(lineHeightPx(ctx, 'body') * 0.4);
    const items = (content.items ?? []).slice(0, 4).map((it) => itemText(it, 'label'));
    const ids: string[] = [];
    items.forEach((text, i) => {
      const y = baselineY(ctx.grid, row + i * rowsFor(ctx, 'body', 1, 1));
      calls.push(...emitRule(ctx, `${ctx.idPrefix}_swatch_${i}`, {
        x: lx + swatch / 2, y, width: swatch, thickness: swatch,
        // Only the first series carries the accent — a legend where every entry
        // is accent-coloured tells you nothing about which series matters.
        fill: i === 0 ? palette.accent : palette.line,
      }));
      const id = `${ctx.idPrefix}_legend_${i}`;
      calls.push(...emitText(ctx, id, text, 'body', {
        x: lx + swatch * 2 + (legendW - swatch * 2) / 2, y,
        width: legendW - swatch * 2, fill: palette.muted, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: legendW - swatch * 2, height: lineHeightPx(ctx, 'body') });
    });
    slots.list = ids;

    return { calls, slots, boxes };
  },
};

// ── hero.overline_stack ───────────────────────────────────────────────

export const overlineStack: LayoutTemplate = {
  id: 'hero.overline_stack',
  displayName: 'Kicker Stack',
  intent: 'A kicker, a rule and a title stacked tight against the right edge.',
  tags: ['hero', 'right-aligned', 'editorial', 'compact', 'asymmetric'],
  packs: ['swiss_editorial', 'broadcast_sports', 'cyberpunk_kinetic', 'luxury_film'],
  slots: [
    { role: 'overline', required: true, max: 1 },
    { role: 'headline', required: true, max: 1 },
  ],
  negativeSpaceRatio: [0.55, 0.85],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [25, 205, 300]) }).calls);

    // Right-aligned, which nothing else in the library is. `EVERYTHING_CENTERED`
    // is a real rule and a library whose every template hangs off the left
    // margin has only moved the problem.
    const span: [number, number] = pick(rng, [[6, 11], [5, 11], [7, 11]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;
    let row = Math.round(baselineRows(ctx.grid) * pick(rng, [0.34, 0.4]));

    const oid = `${ctx.idPrefix}_overline`;
    calls.push(...emitText(ctx, oid, (content.overline ?? '').toUpperCase(), 'overline', {
      x, y: baselineY(ctx.grid, row), width, fill: palette.accentText, align: 'right',
    }));
    slots.overline = [oid];
    boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
    row += rowsFor(ctx, 'overline', 1, 1);

    calls.push(...emitRule(ctx, `${ctx.idPrefix}_rule`, {
      x, y: baselineY(ctx.grid, row), width, thickness: 2, fill: palette.line,
    }));
    boxes.push({ width, height: 2 });
    row += 2;

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'display', width), 3);
    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'display', { x, y, width, fill: palette.fg, align: 'right' }));
      ids.push(id);
      boxes.push({ width, height: lineHeightPx(ctx, 'display') });
    });
    slots.headline = ids;

    return { calls, slots, boxes };
  },
};

export const EDITORIAL_TEMPLATES_4: readonly LayoutTemplate[] = [
  splitVertical,
  twoColumnBullets,
  urlBar,
  galleryFour,
  numberedSection,
  legendChart,
  overlineStack,
];
