/**
 * Layout templates, third set.
 *
 * Two lessons from the second set, both enforced by the design linter rather
 * than by memory:
 *
 *  • **Positions come from the grid, not from arithmetic on the frame.**
 *    Dividing the content width evenly by an item count puts every cell centre
 *    between two column centres, and `OFF_GRID` reports it — correctly, because
 *    a grid nothing lands on is decoration.
 *  • **A full-frame flat fill needs a light source.** Either a gradient, a
 *    texture, or real imagery. A frame-sized panel of one colour is the most
 *    recognisable tell there is.
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

/** Column spans that tile the content columns into `n` equal cells. */
function cellSpans(ctx: ComposeContext, n: number): [number, number][] {
  const per = Math.max(1, Math.floor(ctx.grid.columns / Math.max(1, n)));
  return Array.from({ length: n }, (_, i) => [
    1 + i * per,
    Math.min(ctx.grid.columns - 1, i * per + per),
  ] as [number, number]);
}

// ── hero.side_rule ────────────────────────────────────────────────────

export const sideRule: LayoutTemplate = {
  id: 'hero.side_rule',
  displayName: 'Side Rule',
  intent: 'A vertical rule down the left with the title hung off it, like a chapter opening.',
  tags: ['hero', 'editorial', 'literary', 'restrained', 'asymmetric'],
  packs: ['swiss_editorial', 'luxury_film', 'apple_keynote', 'saas_explainer'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.5, 0.78],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [155, 195, 340]) }).calls);

    const span: [number, number] = pick(rng, [[2, 9], [2, 8], [3, 10]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;
    const rows = baselineRows(ctx.grid);
    const startRow = Math.round(rows * pick(rng, [0.3, 0.34]));

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'display', width), 3);
    const blockRows =
      (content.overline ? rowsFor(ctx, 'overline', 1) : 0) +
      rowsFor(ctx, 'display', headLines.length) +
      (content.subhead ? rowsFor(ctx, 'body', 2) : 0);

    // The rule spans exactly the text block — a rule longer than what it marks
    // reads as a border, and this is a margin note, not a frame.
    const ruleH = blockRows * ctx.grid.baseline;
    calls.push(...emitRule(ctx, `${ctx.idPrefix}_siderule`, {
      x: columnLeft(ctx.grid, span[0]) - ctx.grid.gutter,
      y: baselineY(ctx.grid, startRow) + ruleH / 2,
      width: Math.max(2, Math.round(ctx.grid.baseline * 0.18)),
      thickness: ruleH,
      fill: palette.accent,
    }));

    let row = startRow;
    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1, 1);
    }

    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'display', { x, y, width, fill: palette.fg, align: 'left' }));
      ids.push(id);
      boxes.push({ width, height: lineHeightPx(ctx, 'display') });
    });
    slots.headline = ids;
    row += rowsFor(ctx, 'display', headLines.length, 2);

    if (content.subhead) {
      const id = `${ctx.idPrefix}_subhead`;
      const lines = breakLines(content.subhead, perLine(ctx, 'body', width * 0.8), 2);
      calls.push(...emitText(ctx, id, lines.join(String.fromCharCode(10)), 'body', {
        x, y: baselineY(ctx.grid, row), width: width * 0.8, fill: palette.muted, align: 'left',
      }));
      slots.subhead = [id];
      boxes.push({ width: width * 0.8, height: lines.length * lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── grid.tile_trio ────────────────────────────────────────────────────

export const tileTrio: LayoutTemplate = {
  id: 'grid.tile_trio',
  displayName: 'Tile Trio',
  intent: 'Three panels side by side, each with a title and a line of body.',
  tags: ['grid', 'feature', 'saas', 'comparison', 'scannable'],
  packs: ['saas_explainer', 'apple_keynote', 'swiss_editorial', 'broadcast_sports', 'cyberpunk_kinetic'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 3 },
  ],
  negativeSpaceRatio: [0.32, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [110, 250]) }).calls);

    let row = Math.round(baselineRows(ctx.grid) * 0.2);

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

    const items = (content.items ?? []).slice(0, 3);
    const spans = cellSpans(ctx, Math.max(1, items.length));
    const panelH = Math.round(ctx.height * 0.3);
    const ids: string[] = [];

    items.forEach((item, i) => {
      const span = spans[i]!;
      const w = spanWidth(ctx.grid, span);
      const cx = spanCenterX(ctx.grid, span);
      calls.push(...emitPanel(ctx, `${ctx.idPrefix}_panel_${i}`, {
        x: cx, y: baselineY(ctx.grid, row) + panelH / 2, width: w, height: panelH,
      }, { level: 2 }));
      boxes.push({ width: w, height: panelH });

      const titleId = `${ctx.idPrefix}_title_${i}`;
      calls.push(...emitText(ctx, titleId, itemText(item, 'title'), 'title', {
        x: cx, y: baselineY(ctx.grid, row + 3), width: w * 0.82, fill: palette.fg, align: 'left',
      }));
      ids.push(titleId);
      boxes.push({ width: w * 0.82, height: lineHeightPx(ctx, 'title') });

      const body = itemText(item, 'body');
      if (body) {
        const lines = breakLines(body, perLine(ctx, 'body', w * 0.82), 3);
        calls.push(...emitText(ctx, `${ctx.idPrefix}_body_${i}`, lines.join('\n'), 'body', {
          x: cx, y: baselineY(ctx.grid, row + 3 + rowsFor(ctx, 'title', 1)), width: w * 0.82,
          fill: palette.muted, align: 'left',
        }));
        boxes.push({ width: w * 0.82, height: lines.length * lineHeightPx(ctx, 'body') });
      }
    });
    slots.list = ids;

    return { calls, slots, boxes };
  },
};

// ── quote.attributed_card ─────────────────────────────────────────────

export const attributedCard: LayoutTemplate = {
  id: 'quote.attributed_card',
  displayName: 'Attributed Card',
  intent: 'A testimonial on its own raised card, with the attribution below a short rule.',
  tags: ['quote', 'testimonial', 'saas', 'social-proof', 'card'],
  packs: ['saas_explainer', 'apple_keynote', 'saas_product', 'mobile_app'],
  slots: [
    { role: 'quote', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.42, 0.7],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [140, 220]) }).calls);

    const span: [number, number] = pick(rng, [[2, 10], [3, 10], [2, 9]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);
    const startRow = Math.round(baselineRows(ctx.grid) * 0.3);

    const quoteLines = breakLines(content.quote ?? '', perLine(ctx, 'title', width * 0.86), 4);
    const cardRows = rowsFor(ctx, 'title', quoteLines.length, 6) + (content.support ? 4 : 0);
    const cardH = cardRows * ctx.grid.baseline;

    calls.push(...emitPanel(ctx, `${ctx.idPrefix}_card`, {
      x: cx, y: baselineY(ctx.grid, startRow) + cardH / 2 - ctx.grid.baseline * 2,
      width, height: cardH,
    }, { level: 3 }));
    boxes.push({ width, height: cardH });

    let row = startRow;
    const ids: string[] = [];
    quoteLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_quote_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'title')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'title', {
        x: cx, y, width: width * 0.86, fill: palette.fg, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: width * 0.86, height: lineHeightPx(ctx, 'title') });
    });
    slots.quote = ids;
    row += rowsFor(ctx, 'title', quoteLines.length, 2);

    if (content.support) {
      // A short rule between the claim and who made it — the one distinction a
      // testimonial has to carry.
      calls.push(...emitRule(ctx, `${ctx.idPrefix}_attr_rule`, {
        x: cx - width * 0.36, y: baselineY(ctx.grid, row), width: Math.round(width * 0.1),
        thickness: 2, fill: palette.line,
      }));
      row += 2;
      const id = `${ctx.idPrefix}_support`;
      calls.push(...emitText(ctx, id, content.support, 'body', {
        x: cx, y: baselineY(ctx.grid, row), width: width * 0.86, fill: palette.muted, align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: width * 0.86, height: lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── lowerthird.stacked ────────────────────────────────────────────────

export const lowerThirdStacked: LayoutTemplate = {
  id: 'lowerthird.stacked',
  displayName: 'Stacked Lower Third',
  intent: 'Name over role in the lower left, on a bar that spans only the type.',
  tags: ['lowerthird', 'broadcast', 'identification', 'compact'],
  packs: ['broadcast_sports', 'saas_explainer', 'swiss_editorial', 'cyberpunk_kinetic'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.7, 0.92],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    // No backdrop: a lower third sits OVER footage. A full-frame gradient behind
    // it would black out whatever it is identifying.
    const span: [number, number] = pick(rng, [[1, 6], [1, 7]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;
    const blockRows = rowsFor(ctx, 'title', 1, 1) + (content.subhead ? rowsFor(ctx, 'body', 1, 1) : 0);
    let row = baselineRows(ctx.grid) - blockRows - 4;

    // The bar spans the TYPE, not the frame — a full-width bar is a banner, and
    // a lower third is an annotation.
    const barH = blockRows * ctx.grid.baseline;
    calls.push(...emitPanel(ctx, `${ctx.idPrefix}_bar`, {
      x, y: baselineY(ctx.grid, row) + barH / 2 - ctx.grid.baseline, width, height: barH,
    }, { level: 2, radiusStep: 1 }));
    boxes.push({ width, height: barH });

    calls.push(...emitRule(ctx, `${ctx.idPrefix}_accent`, {
      x: columnLeft(ctx.grid, span[0]),
      y: baselineY(ctx.grid, row) + barH / 2 - ctx.grid.baseline,
      width: Math.max(3, Math.round(ctx.grid.baseline * 0.22)),
      thickness: barH,
      fill: palette.accent,
    }));

    const id = `${ctx.idPrefix}_headline`;
    calls.push(...emitText(ctx, id, content.headline ?? '', 'title', {
      x, y: baselineY(ctx.grid, row), width: width * 0.88, fill: palette.fg, align: 'left',
    }));
    slots.headline = [id];
    boxes.push({ width: width * 0.88, height: lineHeightPx(ctx, 'title') });
    row += rowsFor(ctx, 'title', 1, 1);

    if (content.subhead) {
      const sid = `${ctx.idPrefix}_subhead`;
      calls.push(...emitText(ctx, sid, content.subhead.toUpperCase(), 'overline', {
        x, y: baselineY(ctx.grid, row), width: width * 0.88, fill: palette.accentText, align: 'left',
      }));
      slots.subhead = [sid];
      boxes.push({ width: width * 0.88, height: lineHeightPx(ctx, 'overline') });
    }

    return { calls, slots, boxes };
  },
};

// ── editorial.media_caption ───────────────────────────────────────────

export const mediaCaption: LayoutTemplate = {
  id: 'editorial.media_caption',
  displayName: 'Media with Caption',
  intent: 'An image occupying most of the frame with a small caption hung under its left edge.',
  tags: ['editorial', 'photographic', 'magazine', 'documentary', 'media'],
  packs: ['swiss_editorial', 'luxury_film', 'apple_keynote'],
  // No overline slot, deliberately. `caption` sits one rung below `body` and
  // `overline` two, so stacked under one image they were within a step of each
  // other and `WEAK_TYPE_CONTRAST` reported it. Two labels at nearly the same
  // size under one picture is the design problem, not the rule — here the
  // caption IS the kicker.
  slots: [
    { role: 'media', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.28, 0.55],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [180, 200]) }).calls);

    const span: [number, number] = pick(rng, [[2, 10], [1, 9], [3, 11]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);
    const mediaH = Math.round(ctx.height * pick(rng, [0.52, 0.6, 0.66]));
    const startRow = Math.round(baselineRows(ctx.grid) * 0.16);

    const mediaId = `${ctx.idPrefix}_media`;
    calls.push(...emitMedia(ctx, mediaId, {
      x: cx, y: baselineY(ctx.grid, startRow) + mediaH / 2, width, height: mediaH,
    }, content.mediaAssetId));
    slots.media = [mediaId];
    boxes.push({ width, height: mediaH });

    const row = startRow + Math.ceil(mediaH / ctx.grid.baseline) + 2;

    if (content.support) {
      // Hung under the image's LEFT edge at a narrow measure — centring it under
      // the picture would make it a title rather than a caption.
      const id = `${ctx.idPrefix}_support`;
      const capW = width * 0.42;
      const lines = breakLines(content.support, perLine(ctx, 'caption', capW), 3);
      calls.push(...emitText(ctx, id, lines.join('\n'), 'caption', {
        x: columnLeft(ctx.grid, span[0]) + capW / 2,
        y: baselineY(ctx.grid, row), width: capW, fill: palette.muted, align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: capW, height: lines.length * lineHeightPx(ctx, 'caption') });
    }

    return { calls, slots, boxes };
  },
};

// ── stat.paired ───────────────────────────────────────────────────────

export const statPaired: LayoutTemplate = {
  id: 'stat.paired',
  displayName: 'Paired Metrics',
  intent: 'Two figures with their labels, side by side at equal weight.',
  tags: ['stat', 'data', 'report', 'comparison', 'symmetric'],
  packs: ['saas_explainer', 'broadcast_sports', 'swiss_editorial', 'apple_keynote', 'cyberpunk_kinetic'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'stat', required: true, max: 2 },
  ],
  negativeSpaceRatio: [0.48, 0.76],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [60, 300]) }).calls);

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * pick(rng, [0.3, 0.36]));

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

    const items = (content.items ?? []).slice(0, 2);
    const spans = cellSpans(ctx, 2);
    const ids: string[] = [];
    items.forEach((item, i) => {
      const span = spans[i]!;
      const w = spanWidth(ctx.grid, span);
      const cx = spanCenterX(ctx.grid, span);
      const vid = `${ctx.idPrefix}_stat_${i}`;
      calls.push(...emitText(ctx, vid, itemText(item, 'value') || '—', 'display', {
        x: cx, y: baselineY(ctx.grid, row), width: w, fill: palette.fg, align: 'left', weight: 800,
      }));
      ids.push(vid);
      boxes.push({ width: w, height: lineHeightPx(ctx, 'display') });

      const label = itemText(item, 'label');
      if (label) {
        const lid = `${ctx.idPrefix}_label_${i}`;
        calls.push(...emitText(ctx, lid, label, 'body', {
          x: cx, y: baselineY(ctx.grid, row + rowsFor(ctx, 'display', 1, 0)), width: w,
          fill: palette.muted, align: 'left',
        }));
        boxes.push({ width: w, height: lineHeightPx(ctx, 'body') });
      }
    });
    slots.stat = ids;

    return { calls, slots, boxes };
  },
};

export const EDITORIAL_TEMPLATES_3: readonly LayoutTemplate[] = [
  sideRule,
  tileTrio,
  attributedCard,
  lowerThirdStacked,
  mediaCaption,
  statPaired,
];
