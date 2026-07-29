/**
 * Hero / title layouts.
 *
 * Four templates that are STRUCTURALLY different, not four colourways of a
 * centred stack. That distinction is the whole reason the library exists: a model
 * asked for "a hero" produces a centred stack every time, so the variety has to
 * come from the set of authored structures.
 *
 *   • `centered_stack`   — the honest, calm one. Optically centred, not
 *                          geometrically. Off-axis by a third so it is not dead
 *                          centre.
 *   • `offset_mark`      — headline hard against the left columns, a mark far
 *                          right. Asymmetric.
 *   • `vast_space`       — content occupies two columns of twelve. The emptiness
 *                          IS the design.
 *   • `split_asymmetric` — 5/7 split, type left, media bleeding off the right
 *                          edge.
 */

import { breakLines } from '../type';
import { columnLeft, spanCenterX, spanWidth, baselineY, baselineRows, opticalLeftX } from '../grid';
import { radius } from '../shape';
import { mulberry32, pick, type ToolCall } from '../toolcall';
import {
  type ComposeContext,
  type ComposeResult,
  type LayoutTemplate,
  emitText,
  textMetricsFor,
} from '../compose';
import { emitBackdrop, emitMedia, emitRule } from './shared';

/** Line height in px for a role, so stacks can be laid out without measuring. */
function lineHeightPx(ctx: ComposeContext, role: Parameters<typeof textMetricsFor>[1]): number {
  const s = textMetricsFor(ctx, role);
  return s.fontSizePx * s.lineHeight;
}

// ── hero.centered_stack ───────────────────────────────────────────────

export const centeredStack: LayoutTemplate = {
  id: 'hero.centered_stack',
  displayName: 'Centred Stack',
  intent: 'Calm centred title stack, optically balanced, with generous air above and below.',
  tags: ['hero', 'centred', 'calm', 'keynote', 'product'],
  packs: ['apple_keynote', 'saas_explainer', 'luxury_film', 'mobile_app', 'saas_product'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'subhead', required: false, max: 1 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.5, 0.72],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    const bd = emitBackdrop(ctx, { angle: pick(rng, [100, 115, 145]) });
    calls.push(...bd.calls);

    // Centred horizontally, but NOT centred vertically. The optical centre of a
    // frame sits above the geometric one — a stack at exactly 50% reads as
    // slightly low, which is why posters put the title on the upper third.
    const rows = baselineRows(ctx.grid);
    const startRow = Math.round(rows * pick(rng, [0.3, 0.34, 0.38]));
    // Width bias is a variant axis: a narrow measure forces more line breaks and
    // reads more editorial; a wide one reads more corporate.
    const span: [number, number] = pick(rng, [[2, 9], [3, 8], [1, 10]] as [number, number][]);
    const width = spanWidth(ctx.grid, span);
    const cx = spanCenterX(ctx.grid, span);

    let row = startRow;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      const y = baselineY(ctx.grid, row);
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: cx, y, width, fill: palette.accentText,
      }));
      slots.overline = [id];
      boxes.push({ width, height: lineHeightPx(ctx, 'overline') });
      row += Math.ceil(lineHeightPx(ctx, 'overline') / ctx.grid.baseline) + 2;
    }

    if (content.headline) {
      const display = textMetricsFor(ctx, 'display');
      // Characters-per-line from the real measure and the real font size, so the
      // break points suit THIS frame rather than a guessed 30.
      const perLine = Math.max(8, Math.floor(width / (display.fontSizePx * 0.52)));
      const lines = breakLines(content.headline, perLine, 3);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        const y = baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline));
        calls.push(...emitText(ctx, id, line, 'display', { x: cx, y, width, fill: palette.fg }));
        ids.push(id);
        boxes.push({ width, height: lineHeightPx(ctx, 'display') });
      });
      slots.headline = ids;
      row += Math.ceil((lines.length * lineHeightPx(ctx, 'display')) / ctx.grid.baseline) + 3;
    }

    if (content.subhead) {
      const id = `${ctx.idPrefix}_subhead`;
      const body = textMetricsFor(ctx, 'body');
      // A subhead measure is capped: body copy past ~70 characters a line is
      // measurably harder to read, whatever the frame allows.
      const subWidth = Math.min(width, body.fontSizePx * 34);
      const lines = breakLines(content.subhead, Math.floor(subWidth / (body.fontSizePx * 0.5)), 3);
      calls.push(...emitText(ctx, id, lines.join('\n'), 'body', {
        x: cx, y: baselineY(ctx.grid, row), width: subWidth, fill: palette.muted,
      }));
      slots.subhead = [id];
      boxes.push({ width: subWidth, height: lines.length * lineHeightPx(ctx, 'body') });
      row += Math.ceil((lines.length * lineHeightPx(ctx, 'body')) / ctx.grid.baseline) + 4;
    }

    const surfaces: Record<string, string> = {};

    if (content.cta) {
      const id = `${ctx.idPrefix}_cta`;
      const label = textMetricsFor(ctx, 'title');
      const w = Math.max(label.fontSizePx * 7, content.cta.length * label.fontSizePx * 0.62);
      // Height rounded to whole baselines so the button's CENTRE lands on the
      // grid. A half-baseline height puts every element inside it half a unit off,
      // which the OFF_GRID rule catches — correctly.
      const h = Math.round((label.fontSizePx * 2.6) / (ctx.grid.baseline * 2)) * ctx.grid.baseline * 2;
      const y = baselineY(ctx.grid, row) + h / 2;
      calls.push(
        { name: 'create_layer', args: { id: `${id}_bg`, kind: 'shape', shape: 'rect', name: 'CTA', x: cx, y, width: w, height: h } },
        { name: 'update_layer', args: { nodeId: `${id}_bg`, fill: palette.accent, cornerRadius: radius(ctx.pack.shape.controlRadius, { width: w, height: h }) } },
        ...emitText(ctx, id, content.cta, 'title', { x: cx, y, width: w, fill: palette.bg, weight: 600 }),
      );
      slots.cta = [`${id}_bg`, id];
      boxes.push({ width: w, height: h });
      // The label sits on the BUTTON, not on the composition background. Without
      // this the contrast rule measures it against the frame and reports a
      // failure whose "fix" would break the button.
      surfaces[id] = palette.accent;
    }

    return { calls, slots, boxes, surfaces };
  },
};

// ── hero.offset_mark ──────────────────────────────────────────────────

export const offsetMark: LayoutTemplate = {
  id: 'hero.offset_mark',
  displayName: 'Offset Mark',
  intent: 'Headline pinned to the left columns, a mark or stat alone at the far right. Asymmetric.',
  tags: ['hero', 'asymmetric', 'editorial', 'left-aligned'],
  packs: ['swiss_editorial', 'cyberpunk_kinetic', 'broadcast_sports', 'apple_keynote'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'mark', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.42, 0.65],
  variants: 4,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [75, 90, 160]) }).calls);

    // Type occupies the left 6–8 columns; the mark sits in the last two. The gap
    // between them is the design.
    const typeSpan: [number, number] = pick(rng, [[0, 5], [0, 6], [0, 7]] as [number, number][]);
    const typeWidth = spanWidth(ctx.grid, typeSpan);
    const left = columnLeft(ctx.grid, typeSpan[0]);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * pick(rng, [0.36, 0.42, 0.48]));

    const display = textMetricsFor(ctx, 'display');
    // Left-aligned text needs its `x` to be the CENTRE of the box for the engine,
    // so half-width is added back — and optical overhang is applied so a round or
    // pointed first letter does not leave the column edge looking ragged.
    const textX = (w: number, first: string, size: number): number =>
      opticalLeftX(left, size, first) + w / 2;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      const s = textMetricsFor(ctx, 'overline');
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: textX(typeWidth, content.overline[0] ?? 'A', s.fontSizePx),
        y: baselineY(ctx.grid, row),
        width: typeWidth,
        fill: palette.accentText,
        align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: typeWidth, height: lineHeightPx(ctx, 'overline') });
      row += 4;
    }

    if (content.headline) {
      const perLine = Math.max(6, Math.floor(typeWidth / (display.fontSizePx * 0.5)));
      const lines = breakLines(content.headline, perLine, 4);
      // The accented line is a variant axis — which line gets the accent changes
      // the read of the whole headline, and it costs nothing.
      const accentLine = Math.floor(rng() * lines.length);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        calls.push(...emitText(ctx, id, line, 'display', {
          x: textX(typeWidth, line[0] ?? 'A', display.fontSizePx),
          y: baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'display')) / ctx.grid.baseline)),
          width: typeWidth,
          fill: i === accentLine ? palette.accent : palette.fg,
          align: 'left',
        }));
        ids.push(id);
        boxes.push({ width: typeWidth, height: lineHeightPx(ctx, 'display') });
      });
      slots.headline = ids;
      row += Math.ceil((lines.length * lineHeightPx(ctx, 'display')) / ctx.grid.baseline) + 3;
    }

    if (content.support) {
      const id = `${ctx.idPrefix}_support`;
      const body = textMetricsFor(ctx, 'body');
      const w = Math.min(typeWidth, body.fontSizePx * 32);
      calls.push(...emitText(ctx, id, content.support, 'body', {
        x: textX(w, content.support[0] ?? 'A', body.fontSizePx),
        y: baselineY(ctx.grid, row),
        width: w,
        fill: palette.muted,
        align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: w, height: lineHeightPx(ctx, 'body') * 2 });
    }

    // The mark: a small accent square in the top-right, far from the type. Its
    // job is to weight the empty side so the asymmetry reads as deliberate.
    const markId = `${ctx.idPrefix}_mark`;
    const markSize = Math.round(ctx.grid.baseline * pick(rng, [6, 8, 10]));
    calls.push(
      ...emitRule(ctx, markId, {
        x: spanCenterX(ctx.grid, [ctx.grid.columns - 2, ctx.grid.columns - 1]),
        y: baselineY(ctx.grid, Math.round(rows * 0.14)),
        width: markSize,
        thickness: markSize,
        fill: palette.accent,
      }),
    );
    slots.mark = [markId];
    boxes.push({ width: markSize, height: markSize });

    return { calls, slots, boxes };
  },
};

// ── hero.vast_space ───────────────────────────────────────────────────

export const vastSpace: LayoutTemplate = {
  id: 'hero.vast_space',
  displayName: 'Vast Space',
  intent: 'Two columns of content in twelve. The emptiness is the statement.',
  tags: ['hero', 'luxury', 'minimal', 'restrained', 'space'],
  packs: ['luxury_film', 'apple_keynote'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'rule', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.72, 0.9],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    // Almost no lift: this look is about a nearly-even field, and a strong
    // gradient would compete with the emptiness.
    calls.push(...emitBackdrop(ctx, { lift: 0.035, angle: 165 }).calls);

    const rows = baselineRows(ctx.grid);
    // Which corner the content occupies is the variant. Each reads completely
    // differently despite identical content.
    const corner = pick(rng, ['bottom-left', 'top-left', 'bottom-centre'] as const);
    const span: [number, number] =
      corner === 'bottom-centre' ? [4, 7] : [1, 4];
    const width = spanWidth(ctx.grid, span);
    const cx = corner === 'bottom-centre' ? spanCenterX(ctx.grid, span) : columnLeft(ctx.grid, span[0]) + width / 2;
    const row = corner === 'top-left' ? Math.round(rows * 0.18) : Math.round(rows * 0.68);
    const align = corner === 'bottom-centre' ? 'center' : 'left';

    // A hairline, not a rule. This pack outlines rather than shouts.
    if (content.headline) {
      const ruleId = `${ctx.idPrefix}_rule`;
      calls.push(...emitRule(ctx, ruleId, {
        x: cx, y: baselineY(ctx.grid, row - 4),
        width: Math.round(width * 0.34),
        thickness: 1,
        fill: palette.accent,
      }));
      slots.rule = [ruleId];
      boxes.push({ width: Math.round(width * 0.34), height: 1 });
    }

    if (content.headline) {
      // `headline` not `display`: at this much emptiness a display size would
      // fill the space the template exists to leave empty.
      const s = textMetricsFor(ctx, 'headline');
      const lines = breakLines(content.headline, Math.max(6, Math.floor(width / (s.fontSizePx * 0.5))), 4);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        calls.push(...emitText(ctx, id, line, 'headline', {
          x: cx,
          y: baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline)),
          width,
          fill: palette.fg,
          align,
        }));
        ids.push(id);
        boxes.push({ width, height: lineHeightPx(ctx, 'headline') });
      });
      slots.headline = ids;
    }

    if (content.support) {
      const id = `${ctx.idPrefix}_support`;
      const s = textMetricsFor(ctx, 'caption');
      calls.push(...emitText(ctx, id, content.support.toUpperCase(), 'overline', {
        x: cx,
        y: baselineY(ctx.grid, row + 8),
        width,
        fill: palette.muted,
        align,
      }));
      slots.support = [id];
      boxes.push({ width, height: s.fontSizePx * 1.4 });
    }

    return { calls, slots, boxes };
  },
};

// ── editorial.split_asymmetric ────────────────────────────────────────

export const splitAsymmetric: LayoutTemplate = {
  id: 'editorial.split_asymmetric',
  displayName: 'Asymmetric Split',
  intent: 'Heavy display type on the left five columns, imagery bleeding off the right edge.',
  tags: ['editorial', 'split', 'asymmetric', 'media', 'swiss'],
  packs: ['swiss_editorial', 'saas_explainer', 'luxury_film', 'cyberpunk_kinetic'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'media', required: true, max: 1 },
  ],
  negativeSpaceRatio: [0.3, 0.5],
  variants: 4,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 90, lift: 0.05 }).calls);

    // 5/7 or 4/8 — never 6/6. An even split has no dominant side, so the eye has
    // no entry point and the layout reads as two unrelated halves.
    const typeCols = pick(rng, [4, 5] as const);
    const mediaOnRight = rng() > 0.35;
    const typeSpan: [number, number] = mediaOnRight
      ? [0, typeCols - 1]
      : [ctx.grid.columns - typeCols, ctx.grid.columns - 1];
    const typeWidth = spanWidth(ctx.grid, typeSpan);
    const typeLeft = columnLeft(ctx.grid, typeSpan[0]);

    // Media BLEEDS off its edge — it is not inset to the margin. The bleed is
    // what makes this read as editorial rather than as a two-column web page.
    const mediaId = `${ctx.idPrefix}_media`;
    const mediaWidth = ctx.width - typeLeft - typeWidth - ctx.grid.gutter + ctx.grid.margin;
    const mediaHeight = Math.round(ctx.height * pick(rng, [0.62, 0.74, 0.86]));
    const mediaX = mediaOnRight
      ? ctx.width - mediaWidth / 2 + ctx.grid.margin * 0.4
      : mediaWidth / 2 - ctx.grid.margin * 0.4;
    calls.push(...emitMedia(ctx, mediaId, {
      x: mediaX, y: ctx.height / 2, width: mediaWidth, height: mediaHeight,
    }, content.mediaAssetId, { radiusStep: ctx.pack.shape.cardRadius }));
    slots.media = [mediaId];
    boxes.push({ width: mediaWidth, height: mediaHeight });

    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.3);
    const textX = (w: number) => typeLeft + w / 2;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: textX(typeWidth), y: baselineY(ctx.grid, row), width: typeWidth, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: typeWidth, height: lineHeightPx(ctx, 'overline') });
      row += 4;
    }

    if (content.headline) {
      // A narrow measure means many short lines, which is the editorial look —
      // `headline` rather than `display` so five lines still fit.
      const s = textMetricsFor(ctx, 'headline');
      const lines = breakLines(content.headline, Math.max(5, Math.floor(typeWidth / (s.fontSizePx * 0.5))), 5);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        calls.push(...emitText(ctx, id, line, 'headline', {
          x: textX(typeWidth),
          y: baselineY(ctx.grid, row + Math.round((i * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline)),
          width: typeWidth,
          fill: palette.fg,
          align: 'left',
        }));
        ids.push(id);
        boxes.push({ width: typeWidth, height: lineHeightPx(ctx, 'headline') });
      });
      slots.headline = ids;
      row += Math.ceil((lines.length * lineHeightPx(ctx, 'headline')) / ctx.grid.baseline) + 3;
    }

    if (ctx.pack.shape.usesRules) {
      const ruleId = `${ctx.idPrefix}_rule`;
      const t = Math.max(4, Math.round(ctx.height / 180));
      calls.push(...emitRule(ctx, ruleId, {
        x: textX(typeWidth * 0.5), y: baselineY(ctx.grid, row), width: typeWidth * 0.5, thickness: t,
      }));
      slots.rule = [ruleId];
      boxes.push({ width: typeWidth * 0.5, height: t });
      row += 3;
    }

    if (content.support) {
      const id = `${ctx.idPrefix}_support`;
      calls.push(...emitText(ctx, id, content.support, 'body', {
        x: textX(typeWidth), y: baselineY(ctx.grid, row), width: typeWidth, fill: palette.muted, align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: typeWidth, height: lineHeightPx(ctx, 'body') * 3 });
    }

    return { calls, slots, boxes };
  },
};

export const HERO_TEMPLATES = [centeredStack, offsetMark, vastSpace, splitAsymmetric] as const;
