/**
 * Layout templates, second set.
 *
 * The bar is the same as for techniques: **structurally different, not a
 * colourway**. A centred stack with a bigger headline is not a new layout; it is
 * `centered_stack` with a different variant seed, and the caster can already
 * reach that.
 *
 * What makes each of these its own template is where the weight sits and what
 * the eye is asked to do:
 *
 *   • `hero.corner_anchor`      — everything in one corner; the emptiness is the
 *                                 other three quarters of the frame.
 *   • `hero.banded_rule`        — headline clamped between two heavy rules, so
 *                                 the type reads as a plate rather than a line.
 *   • `hero.full_bleed_scrim`   — media edge to edge, type over a scrim. The one
 *                                 layout where the image leads and type follows.
 *   • `editorial.two_column`    — a real measure in two columns. Reading, not
 *                                 scanning.
 *   • `editorial.pull_quote`    — body one side, an oversized quote the other,
 *                                 at genuinely different scales.
 *   • `stat.hero_number`        — one number at display scale with everything
 *                                 else subordinate to it.
 *   • `stat.band`               — stats in a horizontal band across the middle,
 *                                 divided by rules.
 *   • `list.checklist`          — marked rows with a hanging indent.
 *   • `list.timeline`           — a vertical spine with events hung off it.
 *   • `endcard.lockup`          — mark, tagline, CTA, centred and quiet.
 *   • `endcard.split_contact`   — mark left, details right, divided.
 *   • `compare.before_after`    — the frame split down the middle, both halves
 *                                 equal weight. The only symmetric layout here,
 *                                 and symmetry is the point.
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

/** Rows a block of `n` lines of `role` occupies, plus `pad` rows of air. */
function rowsFor(ctx: ComposeContext, role: Role, n: number, pad = 2): number {
  return Math.ceil((n * lineHeightPx(ctx, role)) / ctx.grid.baseline) + pad;
}

/**
 * The text of a repeating item.
 *
 * `SlotContent.items` carries `{ value, label }` for stats and `{ title, body }`
 * for tiles — one array reused for both, so a template has to say which face of
 * it it wants rather than assuming a string.
 */
function itemText(
  item: { value?: string; label?: string; title?: string; body?: string } | undefined,
  prefer: 'value' | 'label' | 'title' | 'body' = 'title',
): string {
  if (!item) return '';
  return item[prefer] ?? item.title ?? item.value ?? item.label ?? item.body ?? '';
}

/** Characters that fit on one line of `role` at `width`. */
function perLine(ctx: ComposeContext, role: Role, width: number): number {
  return Math.max(8, Math.floor(width / (textMetricsFor(ctx, role).fontSizePx * 0.52)));
}

// ── hero.corner_anchor ────────────────────────────────────────────────

export const cornerAnchor: LayoutTemplate = {
  id: 'hero.corner_anchor',
  displayName: 'Corner Anchor',
  intent: 'Everything gathered into one corner; three quarters of the frame left deliberately empty.',
  tags: ['hero', 'asymmetric', 'spacious', 'editorial', 'confident'],
  packs: ['swiss_editorial', 'luxury_film', 'apple_keynote'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.68, 0.88],
  variants: 4,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [200, 235, 285]) }).calls);

    const rows = baselineRows(ctx.grid);
    // Which corner is a real variant axis, not a cosmetic one: a bottom-left
    // anchor reads as a caption and a top-left one reads as a masthead.
    const bottom = rng() > 0.45;
    const span: [number, number] = pick(rng, [[1, 6], [1, 7], [2, 7]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'display', width), 3);
    const blockRows =
      (content.overline ? rowsFor(ctx, 'overline', 1) : 0) +
      rowsFor(ctx, 'display', headLines.length) +
      (content.cta ? rowsFor(ctx, 'body', 1) : 0);
    let row = bottom ? Math.max(2, rows - blockRows - 3) : 3;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1);
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
    row += rowsFor(ctx, 'display', headLines.length, 1);

    if (content.cta) {
      const id = `${ctx.idPrefix}_cta`;
      calls.push(...emitText(ctx, id, content.cta, 'body', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.accentText, align: 'left',
      }));
      slots.cta = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── hero.banded_rule ──────────────────────────────────────────────────

export const bandedRule: LayoutTemplate = {
  id: 'hero.banded_rule',
  displayName: 'Banded Rule',
  intent: 'The headline clamped between two heavy rules so it reads as a plate, not a line of text.',
  tags: ['hero', 'graphic', 'editorial', 'bold', 'broadcast'],
  packs: ['swiss_editorial', 'broadcast_sports', 'cyberpunk_kinetic'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.45, 0.7],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [90, 180, 270]) }).calls);

    const rows = baselineRows(ctx.grid);
    const span: [number, number] = pick(rng, [[1, 11], [2, 10]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;
    const thickness = Math.max(3, Math.round(ctx.grid.baseline * pick(rng, [0.35, 0.5, 0.7])));

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'display', width), 2);
    let row = Math.round(rows * 0.3);

    calls.push(...emitRule(ctx, `${ctx.idPrefix}_rule_top`, {
      x, y: baselineY(ctx.grid, row), width, thickness, fill: palette.accent,
    }));
    boxes.push({ width, height: thickness });
    row += 2;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.muted, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1, 1);
    }

    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line.toUpperCase(), 'display', { x, y, width, fill: palette.fg, align: 'left' }));
      ids.push(id);
      boxes.push({ width, height: lineHeightPx(ctx, 'display') });
    });
    slots.headline = ids;
    row += rowsFor(ctx, 'display', headLines.length, 1);

    calls.push(...emitRule(ctx, `${ctx.idPrefix}_rule_bottom`, {
      x, y: baselineY(ctx.grid, row), width, thickness, fill: palette.accent,
    }));
    boxes.push({ width, height: thickness });
    row += 2;

    if (content.subhead) {
      const id = `${ctx.idPrefix}_subhead`;
      const lines = breakLines(content.subhead, perLine(ctx, 'body', width), 2);
      calls.push(...emitText(ctx, id, lines.join('\n'), 'body', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.muted, align: 'left',
      }));
      slots.subhead = [id];
      boxes.push({ width, height: lines.length * lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── hero.full_bleed_scrim ─────────────────────────────────────────────

export const fullBleedScrim: LayoutTemplate = {
  id: 'hero.full_bleed_scrim',
  displayName: 'Full Bleed with Scrim',
  intent: 'Image edge to edge, type over a darkened scrim. The one layout where the picture leads.',
  tags: ['hero', 'cinematic', 'media', 'immersive', 'photographic'],
  packs: ['luxury_film', 'apple_keynote', 'broadcast_sports'],
  slots: [
    { role: 'media', required: true, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.3, 0.62],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    // The backdrop goes down FIRST even though a real full-bleed asset covers
    // it. Two reasons, and the first was an assumption worth abandoning: it
    // carries the scene's surface treatment, and a frame with no texture layer
    // at all is flagged — correctly, since a perfectly clean gradient is the
    // clearest "rendered, not shot" tell there is.
    //
    // Second: when the caster has no asset yet, this gradient IS the image. A
    // flat placeholder panel at frame size is a wall of one colour, which the
    // linter reported as FLAT_FILL and which looks like a broken render.
    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [15, 165, 200]) }).calls);

    const mediaId = `${ctx.idPrefix}_media`;
    if (content.mediaAssetId) {
      calls.push(...emitMedia(ctx, mediaId, {
        x: ctx.width / 2, y: ctx.height / 2, width: ctx.width, height: ctx.height,
      }, content.mediaAssetId, { radiusStep: 0 }));
      slots.media = [mediaId];
    }

    // The scrim is what makes the type legible, and it is a gradient rather than
    // a flat wash: a flat 40% black over a photograph is the single most
    // recognisable "text on image" tell there is.
    const scrimId = `${ctx.idPrefix}_scrim`;
    calls.push(...emitPanel(ctx, scrimId, {
      x: ctx.width / 2, y: ctx.height * 0.74, width: ctx.width, height: ctx.height * 0.52,
    }, { level: 0, radiusStep: 0, fill: palette.bg }));
    calls.push({ name: 'update_layer', args: { nodeId: scrimId, opacity: pick(rng, [72, 80, 86]) } });

    const rows = baselineRows(ctx.grid);
    const span: [number, number] = pick(rng, [[1, 8], [1, 9]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'headline', width), 2);
    let row = rows - rowsFor(ctx, 'headline', headLines.length) - (content.subhead ? 4 : 0) - 3;

    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'headline', { x, y, width, fill: palette.fg, align: 'left' }));
      ids.push(id);
      boxes.push({ width, height: lineHeightPx(ctx, 'headline') });
    });
    slots.headline = ids;
    row += rowsFor(ctx, 'headline', headLines.length, 1);

    if (content.subhead) {
      const id = `${ctx.idPrefix}_subhead`;
      calls.push(...emitText(ctx, id, content.subhead, 'body', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.muted, align: 'left',
      }));
      slots.subhead = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── editorial.two_column ──────────────────────────────────────────────

export const twoColumn: LayoutTemplate = {
  id: 'editorial.two_column',
  displayName: 'Two Column',
  intent: 'A real reading measure in two columns, with the headline spanning both.',
  tags: ['editorial', 'reading', 'magazine', 'dense', 'text'],
  packs: ['swiss_editorial', 'saas_explainer', 'apple_keynote'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: true, max: 1 },
    { role: 'overline', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.35, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [160, 200]) }).calls);

    const fullSpan: [number, number] = [1, 11];
    const fullWidth = spanWidth(ctx.grid, fullSpan);
    const fullX = columnLeft(ctx.grid, 1) + fullWidth / 2;
    let row = Math.round(baselineRows(ctx.grid) * 0.22);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: fullX, y: baselineY(ctx.grid, row), width: fullWidth, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: fullWidth, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1, 1);
    }

    const headLines = breakLines(content.headline ?? '', perLine(ctx, 'headline', fullWidth), 2);
    const ids: string[] = [];
    headLines.forEach((line, i) => {
      const id = `${ctx.idPrefix}_headline_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, id, line, 'headline', {
        x: fullX, y, width: fullWidth, fill: palette.fg, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: fullWidth, height: lineHeightPx(ctx, 'headline') });
    });
    slots.headline = ids;
    row += rowsFor(ctx, 'headline', headLines.length, 2);

    // A rule under the headline, spanning both columns — this is what makes the
    // two columns read as one article rather than two unrelated blocks.
    calls.push(...emitRule(ctx, `${ctx.idPrefix}_rule`, {
      x: fullX, y: baselineY(ctx.grid, row), width: fullWidth, thickness: 2, fill: palette.line,
    }));
    boxes.push({ width: fullWidth, height: 2 });
    row += 2;

    // The body, split across two columns at a real measure.
    const colSpans: [number, number][] = [[1, 5], [7, 11]];
    const body = content.support ?? '';
    const colWidth = spanWidth(ctx.grid, colSpans[0]!);
    const cpl = Math.floor(colWidth / (textMetricsFor(ctx, 'body').fontSizePx * 0.5));
    const allLines = breakLines(body, cpl, 14);
    const half = Math.ceil(allLines.length / 2);
    const supportIds: string[] = [];
    colSpans.forEach((span, c) => {
      const lines = allLines.slice(c * half, (c + 1) * half);
      if (!lines.length) return;
      const id = `${ctx.idPrefix}_support_${c}`;
      const w = spanWidth(ctx.grid, span);
      calls.push(...emitText(ctx, id, lines.join('\n'), 'body', {
        x: columnLeft(ctx.grid, span[0]) + w / 2,
        y: baselineY(ctx.grid, row),
        width: w,
        fill: palette.muted,
        align: 'left',
      }));
      supportIds.push(id);
      boxes.push({ width: w, height: lines.length * lineHeightPx(ctx, 'body') });
    });
    slots.support = supportIds;

    return { calls, slots, boxes };
  },
};

// ── stat.hero_number ──────────────────────────────────────────────────

export const heroNumber: LayoutTemplate = {
  id: 'stat.hero_number',
  displayName: 'Hero Number',
  intent: 'One number at full display scale, everything else deliberately subordinate to it.',
  tags: ['stat', 'data', 'impact', 'single-focus', 'report'],
  packs: ['broadcast_sports', 'saas_explainer', 'swiss_editorial', 'apple_keynote'],
  slots: [
    { role: 'stat', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
    { role: 'overline', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.55, 0.8],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [45, 135, 315]) }).calls);

    const span: [number, number] = pick(rng, [[1, 8], [2, 9], [1, 10]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x = columnLeft(ctx.grid, span[0]) + width / 2;
    let row = Math.round(baselineRows(ctx.grid) * pick(rng, [0.3, 0.34]));

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
      row += rowsFor(ctx, 'overline', 1, 1);
    }

    const value = itemText(content.items?.[0], 'value') || '100%';
    const id = `${ctx.idPrefix}_stat`;
    calls.push(...emitText(ctx, id, value, 'display', {
      x, y: baselineY(ctx.grid, row), width, fill: palette.fg, align: 'left', weight: 800,
    }));
    slots.stat = [id];
    boxes.push({ width, height: lineHeightPx(ctx, 'display') });
    row += rowsFor(ctx, 'display', 1, 1);

    if (content.subhead) {
      const sid = `${ctx.idPrefix}_subhead`;
      const lines = breakLines(content.subhead, perLine(ctx, 'body', width), 2);
      calls.push(...emitText(ctx, sid, lines.join('\n'), 'body', {
        x, y: baselineY(ctx.grid, row), width, fill: palette.muted, align: 'left',
      }));
      slots.subhead = [sid];
      boxes.push({ width, height: lines.length * lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── stat.band ─────────────────────────────────────────────────────────

export const statBand: LayoutTemplate = {
  id: 'stat.band',
  displayName: 'Stat Band',
  intent: 'Figures in a horizontal band across the middle, separated by rules.',
  tags: ['stat', 'data', 'report', 'horizontal', 'comparison'],
  packs: ['saas_explainer', 'swiss_editorial', 'broadcast_sports'],
  slots: [
    { role: 'stat', required: true, max: 4 },
    { role: 'overline', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.5, 0.75],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [0, 180]) }).calls);

    const items = (content.items ?? []).slice(0, 4).map((it) => itemText(it, 'value') || '—');
    const rows = baselineRows(ctx.grid);
    const bandRow = Math.round(rows * 0.42);
    const fullWidth = spanWidth(ctx.grid, [1, 11]);
    const left = columnLeft(ctx.grid, 1);
    // Cells are COLUMN spans, not an even division of the content width.
    // Dividing the width by the item count put every cell centre between two
    // column centres — OFF_GRID on the stats and on the dividers, which is the
    // rule doing exactly its job: a grid nothing lands on is decoration.
    const per = Math.max(1, Math.floor(ctx.grid.columns / Math.max(1, items.length)));
    const cellSpans: [number, number][] = items.map((_, i) => [
      1 + i * per,
      Math.min(ctx.grid.columns - 1, i * per + per),
    ]);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: left + fullWidth / 2, y: baselineY(ctx.grid, bandRow - 4), width: fullWidth,
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: fullWidth, height: lineHeightPx(ctx, 'overline') });
    }

    const ids: string[] = [];
    items.forEach((value, i) => {
      const span = cellSpans[i]!;
      const cellW = spanWidth(ctx.grid, span);
      const cx = spanCenterX(ctx.grid, span);
      const id = `${ctx.idPrefix}_stat_${i}`;
      calls.push(...emitText(ctx, id, value, 'headline', {
        x: cx, y: baselineY(ctx.grid, bandRow), width: cellW, fill: palette.fg, align: 'left', weight: 800,
      }));
      ids.push(id);
      boxes.push({ width: cellW, height: lineHeightPx(ctx, 'headline') });

      // A divider BETWEEN cells, never after the last — a trailing rule reads as
      // a truncated list. It sits on the next cell's centre line so it is on the
      // grid like everything else.
      if (i < items.length - 1) {
        const next = cellSpans[i + 1]!;
        calls.push(...emitRule(ctx, `${ctx.idPrefix}_div_${i}`, {
          x: spanCenterX(ctx.grid, [span[1], next[0]]),
          y: baselineY(ctx.grid, bandRow),
          width: 2,
          thickness: Math.round(lineHeightPx(ctx, 'headline') * 1.1),
          fill: palette.line,
        }));
      }
    });
    slots.stat = ids;

    return { calls, slots, boxes };
  },
};

// ── list.checklist ────────────────────────────────────────────────────

export const checklist: LayoutTemplate = {
  id: 'list.checklist',
  displayName: 'Checklist',
  intent: 'Marked rows with a hanging indent, so the marks form their own vertical line.',
  tags: ['list', 'feature', 'saas', 'scannable', 'benefit'],
  packs: ['saas_explainer', 'apple_keynote', 'swiss_editorial'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 6 },
  ],
  negativeSpaceRatio: [0.42, 0.7],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [120, 240]) }).calls);

    const span: [number, number] = pick(rng, [[1, 8], [2, 9]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x0 = columnLeft(ctx.grid, span[0]);
    let row = Math.round(baselineRows(ctx.grid) * 0.24);

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      const lines = breakLines(content.headline, perLine(ctx, 'headline', width), 2);
      lines.forEach((line, i) => {
        const lid = i === 0 ? id : `${id}_${i}`;
        const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline));
        calls.push(...emitText(ctx, lid, line, 'headline', {
          x: x0 + width / 2, y, width, fill: palette.fg, align: 'left',
        }));
        boxes.push({ width, height: lineHeightPx(ctx, 'headline') });
      });
      slots.headline = [id];
      row += rowsFor(ctx, 'headline', lines.length, 2);
    }

    const items = (content.items ?? []).slice(0, 6).map((it) => itemText(it, 'title'));
    // The hanging indent is the whole idea: the marks line up in their own
    // column so the eye can run down them without reading the text.
    const markW = Math.round(lineHeightPx(ctx, 'body') * 0.5);
    const gutter = Math.round(markW * 1.8);
    const textW = width - gutter;
    const ids: string[] = [];
    items.forEach((text, i) => {
      const y = baselineY(ctx.grid, row);
      const markId = `${ctx.idPrefix}_mark_${i}`;
      calls.push(...emitRule(ctx, markId, {
        x: x0 + markW / 2, y, width: markW, thickness: markW, fill: palette.accent,
      }));
      const id = `${ctx.idPrefix}_item_${i}`;
      calls.push(...emitText(ctx, id, text, 'body', {
        x: x0 + gutter + textW / 2, y, width: textW, fill: palette.fg, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: textW, height: lineHeightPx(ctx, 'body') });
      row += rowsFor(ctx, 'body', 1, 1);
    });
    slots.list = ids;

    return { calls, slots, boxes };
  },
};

// ── list.timeline ─────────────────────────────────────────────────────

export const timeline: LayoutTemplate = {
  id: 'list.timeline',
  displayName: 'Timeline',
  intent: 'A vertical spine with events hung off it — sequence made visible.',
  tags: ['list', 'sequence', 'process', 'roadmap', 'chronological'],
  packs: ['saas_explainer', 'swiss_editorial', 'apple_keynote'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'list', required: true, max: 5 },
  ],
  negativeSpaceRatio: [0.45, 0.72],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [90, 270]) }).calls);

    const span: [number, number] = pick(rng, [[2, 9], [1, 8]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const x0 = columnLeft(ctx.grid, span[0]);
    const items = (content.items ?? []).slice(0, 5).map((it) => itemText(it, 'title'));
    const startRow = Math.round(baselineRows(ctx.grid) * 0.26);
    const stepRows = rowsFor(ctx, 'body', 1, 3);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: x0 + width / 2, y: baselineY(ctx.grid, startRow - 4), width,
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
    }

    // The spine runs the full height of the events and NO further. A spine that
    // overshoots the last event reads as an unfinished list.
    const spineH = Math.max(1, (items.length - 1) * stepRows * ctx.grid.baseline);
    const dot = Math.round(lineHeightPx(ctx, 'body') * 0.36);
    calls.push(...emitRule(ctx, `${ctx.idPrefix}_spine`, {
      x: x0 + dot / 2,
      y: baselineY(ctx.grid, startRow) + spineH / 2,
      width: 2,
      thickness: spineH,
      fill: palette.line,
    }));

    const gutter = Math.round(dot * 3);
    const textW = width - gutter;
    const ids: string[] = [];
    items.forEach((text, i) => {
      const y = baselineY(ctx.grid, startRow + i * stepRows);
      calls.push(...emitRule(ctx, `${ctx.idPrefix}_node_${i}`, {
        x: x0 + dot / 2, y, width: dot, thickness: dot, fill: palette.accent,
      }));
      const id = `${ctx.idPrefix}_item_${i}`;
      calls.push(...emitText(ctx, id, text, 'body', {
        x: x0 + gutter + textW / 2, y, width: textW, fill: palette.fg, align: 'left',
      }));
      ids.push(id);
      boxes.push({ width: textW, height: lineHeightPx(ctx, 'body') });
    });
    slots.list = ids;

    return { calls, slots, boxes };
  },
};

// ── endcard.lockup ────────────────────────────────────────────────────

export const endcardLockup: LayoutTemplate = {
  id: 'endcard.lockup',
  displayName: 'End Card Lockup',
  intent: 'Mark, tagline and call to action, centred and quiet. The last thing on screen.',
  tags: ['endcard', 'closing', 'brand', 'centred', 'calm'],
  packs: ['apple_keynote', 'luxury_film', 'saas_explainer', 'swiss_editorial'],
  slots: [
    { role: 'mark', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.62, 0.85],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [180, 200, 340]), kind: 'radial' }).calls);

    const span: [number, number] = [3, 9];
    const width = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.38);

    {
      const id = `${ctx.idPrefix}_mark`;
      const size = Math.round(lineHeightPx(ctx, 'headline') * 0.9);
      calls.push(...emitPanel(ctx, id, {
        x: cx, y: baselineY(ctx.grid, row), width: size, height: size,
      }, { level: 2, fill: palette.accent }));
      slots.mark = [id];
      boxes.push({ width: size, height: size });
      row += Math.ceil(size / ctx.grid.baseline) + 2;
    }

    const id = `${ctx.idPrefix}_headline`;
    const lines = breakLines(content.headline ?? '', perLine(ctx, 'headline', width), 2);
    lines.forEach((line, i) => {
      const lid = i === 0 ? id : `${id}_${i}`;
      const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline));
      calls.push(...emitText(ctx, lid, line, 'headline', { x: cx, y, width, fill: palette.fg }));
      boxes.push({ width, height: lineHeightPx(ctx, 'headline') });
    });
    slots.headline = [id];
    row += rowsFor(ctx, 'headline', lines.length, 2);

    if (content.cta) {
      const cid = `${ctx.idPrefix}_cta`;
      calls.push(...emitText(ctx, cid, content.cta, 'body', {
        x: cx, y: baselineY(ctx.grid, row), width, fill: palette.accentText,
      }));
      slots.cta = [cid];
      boxes.push({ width, height: lineHeightPx(ctx, 'body') });
    }

    return { calls, slots, boxes };
  },
};

// ── compare.before_after ──────────────────────────────────────────────

export const beforeAfter: LayoutTemplate = {
  id: 'compare.before_after',
  displayName: 'Before / After',
  intent: 'The frame split down the middle, both halves carrying equal weight.',
  tags: ['compare', 'split', 'symmetric', 'product', 'proof'],
  packs: ['saas_explainer', 'apple_keynote', 'broadcast_sports'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'media', required: false, max: 2 },
    { role: 'list', required: true, max: 2 },
  ],
  negativeSpaceRatio: [0.3, 0.58],
  variants: 2,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [0, 90]) }).calls);

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.16);

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      const w = spanWidth(ctx.grid, [1, 11]);
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: columnLeft(ctx.grid, 1) + w / 2, y: baselineY(ctx.grid, row), width: w,
        fill: palette.fg, align: 'left',
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lineHeightPx(ctx, 'headline') });
      row += rowsFor(ctx, 'headline', 1, 2);
    }

    // Symmetry is deliberate here and nowhere else in this file. A comparison
    // whose halves differ in weight has already made the argument for you.
    const halves: [number, number][] = [[1, 5], [7, 11]];
    const panelH = Math.round(ctx.height * 0.36);
    const labels = (content.items ?? []).slice(0, 2).map((it) => itemText(it, 'label'));
    const listIds: string[] = [];
    const mediaIds: string[] = [];

    halves.forEach((span, i) => {
      const w = spanWidth(ctx.grid, span);
      const cx = columnLeft(ctx.grid, span[0]) + w / 2;
      const mid = `${ctx.idPrefix}_media_${i}`;
      calls.push(...emitMedia(ctx, mid, {
        x: cx, y: baselineY(ctx.grid, row) + panelH / 2, width: w, height: panelH,
      }, i === 0 ? content.mediaAssetId : undefined));
      mediaIds.push(mid);
      boxes.push({ width: w, height: panelH });

      const lid = `${ctx.idPrefix}_label_${i}`;
      calls.push(...emitText(ctx, lid, (labels[i] || (i === 0 ? 'Before' : 'After')).toUpperCase(), 'overline', {
        x: cx,
        y: baselineY(ctx.grid, row + Math.ceil(panelH / ctx.grid.baseline) + 2),
        width: w,
        // The second half gets the accent — that is the one being argued FOR.
        fill: i === 1 ? palette.accentText : palette.muted,
        align: 'left',
      }));
      listIds.push(lid);
      boxes.push({ width: w, height: lineHeightPx(ctx, 'overline') });
    });
    slots.media = mediaIds;
    slots.list = listIds;

    return { calls, slots, boxes };
  },
};

export const EDITORIAL_TEMPLATES_2: readonly LayoutTemplate[] = [
  cornerAnchor,
  bandedRule,
  fullBleedScrim,
  twoColumn,
  heroNumber,
  statBand,
  checklist,
  timeline,
  endcardLockup,
  beforeAfter,
];
