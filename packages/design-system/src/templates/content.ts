/**
 * Content layouts: data, quote, tiles, steps, end-cards, lower thirds.
 *
 * These are the templates a piece spends its middle on. Two things they all do
 * that generated layouts usually do not:
 *
 *  • **Sizes come from the type scale, spacing from the baseline grid.** A stat
 *    value and its label differ by a full scale ratio AND a weight step, so the
 *    pair reads as a hierarchy rather than as two numbers.
 *  • **Nothing is evenly distributed by accident.** A three-up row of tiles is
 *    evenly spaced because that is correct for a grid; a stack of list rows is
 *    NOT, because a uniform vertical rhythm across differently-sized rows is
 *    what makes a list look auto-generated.
 */

import { breakLines } from '../type';
import { columnLeft, spanCenterX, spanWidth, baselineY, baselineRows } from '../grid';
import { radius } from '../shape';
import { elevation } from '../depth';
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

// ── stat.trio ─────────────────────────────────────────────────────────

export const statTrio: LayoutTemplate = {
  id: 'stat.trio',
  displayName: 'Stat Trio',
  intent: 'Two to four big numbers across the frame, each with a small caption beneath.',
  tags: ['stat', 'data', 'row', 'proof'],
  packs: ['apple_keynote', 'saas_explainer', 'broadcast_sports', 'swiss_editorial', 'cyberpunk_kinetic', 'mobile_app', 'saas_product'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'stat', required: true, max: 4 },
  ],
  negativeSpaceRatio: [0.5, 0.75],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { stat: [] };
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: pick(rng, [90, 120]) }).calls);

    const items = (content.items ?? []).slice(0, 4);
    if (!items.length) return { calls, slots, boxes };

    const rows = baselineRows(ctx.grid);
    const rowY = Math.round(rows * pick(rng, [0.42, 0.46, 0.5]));

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: ctx.width / 2, y: baselineY(ctx.grid, Math.round(rows * 0.24)),
        width: spanWidth(ctx.grid, [0, ctx.grid.columns - 1]), fill: palette.accentText,
      }));
      slots.overline = [id];
    }

    // Each stat gets an equal column span. Evenness is correct HERE: a row of
    // peer values that were unevenly spaced would imply a hierarchy that does not
    // exist.
    const per = Math.floor(ctx.grid.columns / items.length);
    items.forEach((item, i) => {
      const span: [number, number] = [i * per, i * per + per - 1];
      const cx = spanCenterX(ctx.grid, span);
      const w = spanWidth(ctx.grid, span);

      const valueId = `${ctx.idPrefix}_stat_${i}`;
      const labelId = `${ctx.idPrefix}_statlabel_${i}`;
      // display for the number, overline for the caption: five scale rungs apart
      // AND a large weight gap, so the pair can never fail the hierarchy-contrast
      // rule.
      calls.push(...emitText(ctx, valueId, item.value ?? '—', 'display', {
        x: cx, y: baselineY(ctx.grid, rowY), width: w,
        fill: i === 0 ? palette.accent : palette.fg,
      }));
      calls.push(...emitText(ctx, labelId, (item.label ?? '').toUpperCase(), 'overline', {
        x: cx,
        y: baselineY(ctx.grid, rowY + Math.ceil(lhPx(ctx, 'display') / ctx.grid.baseline) + 2),
        width: w,
        fill: palette.muted,
      }));
      slots.stat!.push(valueId, labelId);
      boxes.push({ width: w, height: lhPx(ctx, 'display') + lhPx(ctx, 'overline') });

      // A hairline between stats, not around them. Dividers between peers read as
      // structure; boxes around peers read as a table.
      if (i > 0 && ctx.pack.shape.usesRules) {
        const dividerId = `${ctx.idPrefix}_statdiv_${i}`;
        calls.push(...emitRule(ctx, dividerId, {
          x: columnLeft(ctx.grid, span[0]) - ctx.grid.gutter / 2,
          y: baselineY(ctx.grid, rowY) + lhPx(ctx, 'display') * 0.2,
          width: 1,
          thickness: lhPx(ctx, 'display') * 1.1,
          fill: palette.line,
        }));
      }
    });

    return { calls, slots, boxes };
  },
};

// ── grid.feature_tiles ────────────────────────────────────────────────

export const featureTiles: LayoutTemplate = {
  id: 'grid.feature_tiles',
  displayName: 'Feature Tiles',
  intent: 'Two or three elevated cards in a row, each a small title over a line of body copy.',
  tags: ['grid', 'cards', 'features', 'saas'],
  packs: ['saas_explainer', 'apple_keynote', 'swiss_editorial', 'cyberpunk_kinetic'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 4 },
  ],
  negativeSpaceRatio: [0.32, 0.55],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 100 }).calls);

    const items = (content.items ?? []).slice(0, 4);
    const rows = baselineRows(ctx.grid);
    let topRow = Math.round(rows * 0.2);

    if (content.headline) {
      const s = textMetricsFor(ctx, 'headline');
      const w = spanWidth(ctx.grid, [1, 10]);
      const lines = breakLines(content.headline, Math.floor(w / (s.fontSizePx * 0.5)), 2);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        calls.push(...emitText(ctx, id, line, 'headline', {
          x: ctx.width / 2,
          y: baselineY(ctx.grid, topRow + Math.round((i * lhPx(ctx, 'headline')) / ctx.grid.baseline)),
          width: w, fill: palette.fg,
        }));
        ids.push(id);
        boxes.push({ width: w, height: lhPx(ctx, 'headline') });
      });
      slots.headline = ids;
      topRow += Math.ceil((lines.length * lhPx(ctx, 'headline')) / ctx.grid.baseline) + 5;
    }

    if (!items.length) return { calls, slots, boxes };

    const per = Math.floor(ctx.grid.columns / items.length);
    const cardH = Math.round(ctx.height * pick(rng, [0.26, 0.3, 0.34]));
    const cardY = baselineY(ctx.grid, topRow) + cardH / 2;
    // Elevation varies by index — a middle card lifted above its neighbours is
    // the standard "recommended tier" device, and one uniform elevation across a
    // row is a wasted signal.
    const liftIndex = items.length >= 3 ? 1 : -1;

    items.forEach((item, i) => {
      const span: [number, number] = [i * per, i * per + per - 1];
      const cx = spanCenterX(ctx.grid, span);
      const w = spanWidth(ctx.grid, span);
      const cardId = `${ctx.idPrefix}_tile_${i}`;

      calls.push(...emitPanel(ctx, cardId, { x: cx, y: cardY, width: w, height: cardH }, {
        level: i === liftIndex ? 4 : 2,
        glassy: ctx.pack.shape.prefersOutline,
      }));
      boxes.push({ width: w, height: cardH });

      const padded = w - ctx.grid.gutter * 2;
      const titleId = `${ctx.idPrefix}_tiletitle_${i}`;
      const bodyId = `${ctx.idPrefix}_tilebody_${i}`;
      const titleY = cardY - cardH / 2 + ctx.grid.gutter * 2;

      calls.push(...emitText(ctx, titleId, item.title ?? '', 'title', {
        x: cx, y: titleY, width: padded,
        fill: i === liftIndex ? palette.accent : palette.fg,
        weight: 600, align: 'left',
      }));
      const body = textMetricsFor(ctx, 'body');
      const bodyLines = breakLines(item.body ?? '', Math.floor(padded / (body.fontSizePx * 0.5)), 4);
      calls.push(...emitText(ctx, bodyId, bodyLines.join('\n'), 'body', {
        x: cx, y: titleY + lhPx(ctx, 'title') + ctx.grid.baseline * 2, width: padded,
        fill: palette.muted, align: 'left',
      }));
      slots.list!.push(cardId, titleId, bodyId);
    });

    return { calls, slots, boxes };
  },
};

// ── quote.oversized ───────────────────────────────────────────────────

export const quoteOversized: LayoutTemplate = {
  id: 'quote.oversized',
  displayName: 'Oversized Quote',
  intent: 'A pull quote at display size with a hanging open-quote and a small attribution.',
  tags: ['quote', 'editorial', 'testimonial'],
  packs: ['swiss_editorial', 'luxury_film', 'saas_explainer', 'apple_keynote'],
  slots: [
    { role: 'quote', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.45, 0.7],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 135, lift: 0.05 }).calls);

    const span: [number, number] = pick(rng, [[1, 9], [2, 10], [1, 8]] as [number, number][]);
    const w = spanWidth(ctx.grid, span);
    const left = columnLeft(ctx.grid, span[0]);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.32);

    // The oversized quote mark is set OUTSIDE the text measure and much larger
    // than the quote itself, so it reads as a graphic element. A quote mark inline
    // at text size is just punctuation.
    const markId = `${ctx.idPrefix}_quotemark`;
    const markStyle = textMetricsFor(ctx, 'display');
    // The mark hangs into the margin — that overhang is the point of a hanging
    // quote — but its BOX still starts on the column, so it is anchored to the
    // grid rather than floating. `opticalLeftX` supplies the overhang; passing
    // the width is what lets the linter see the anchored edge.
    const markW = markStyle.fontSizePx;
    calls.push(...emitText(ctx, markId, '“', 'display', {
      x: left + markW / 2,
      y: baselineY(ctx.grid, row - 3),
      width: markW,
      fill: palette.accent, weight: 700, align: 'left',
    }));
    boxes.push({ width: markW, height: markStyle.fontSizePx });

    if (content.quote) {
      const s = textMetricsFor(ctx, 'headline');
      const lines = breakLines(content.quote, Math.max(8, Math.floor(w / (s.fontSizePx * 0.5))), 5);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_quote_${i}`;
        calls.push(...emitText(ctx, id, line, 'headline', {
          x: left + w / 2,
          y: baselineY(ctx.grid, row + Math.round((i * lhPx(ctx, 'headline')) / ctx.grid.baseline)),
          width: w, fill: palette.fg, align: 'left',
        }));
        ids.push(id);
        boxes.push({ width: w, height: lhPx(ctx, 'headline') });
      });
      slots.quote = ids;
      row += Math.ceil((lines.length * lhPx(ctx, 'headline')) / ctx.grid.baseline) + 4;
    }

    const attribution = content.attribution ?? content.support;
    if (attribution) {
      // Rule and attribution BOTH start on the column left, stacked rather than
      // set side-by-side at an arbitrary offset. The earlier version placed the
      // attribution a fixed distance from the rule, which left its box anchored
      // to nothing — the OFF_GRID rule reported it in every pack, correctly.
      const ruleId = `${ctx.idPrefix}_attrrule`;
      const ruleW = ctx.grid.baseline * 6;
      calls.push(...emitRule(ctx, ruleId, {
        x: left + ruleW / 2, y: baselineY(ctx.grid, row), width: ruleW, thickness: 2,
      }));
      const id = `${ctx.idPrefix}_support`;
      const attrW = Math.round(w / 2);
      calls.push(...emitText(ctx, id, attribution.toUpperCase(), 'overline', {
        x: left + attrW / 2, y: baselineY(ctx.grid, row + 3), width: attrW,
        fill: palette.muted, align: 'left',
      }));
      slots.support = [ruleId, id];
      boxes.push({ width: attrW, height: lhPx(ctx, 'overline') });
    }

    return { calls, slots, boxes };
  },
};

// ── list.numbered_steps ───────────────────────────────────────────────

export const numberedSteps: LayoutTemplate = {
  id: 'list.numbered_steps',
  displayName: 'Numbered Steps',
  intent: 'A vertical sequence of numbered rows, each a title and a line of detail.',
  tags: ['list', 'steps', 'sequence', 'process'],
  packs: ['saas_explainer', 'swiss_editorial', 'apple_keynote', 'cyberpunk_kinetic', 'mobile_app', 'saas_product'],
  slots: [
    { role: 'headline', required: false, max: 1 },
    { role: 'list', required: true, max: 5 },
  ],
  negativeSpaceRatio: [0.35, 0.6],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 80 }).calls);

    const items = (content.items ?? []).slice(0, 5);
    const span: [number, number] = pick(rng, [[1, 8], [2, 9], [1, 7]] as [number, number][]);
    const left = columnLeft(ctx.grid, span[0]);
    const w = spanWidth(ctx.grid, span);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.22);

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: left + w / 2, y: baselineY(ctx.grid, row), width: w, fill: palette.fg, align: 'left',
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'headline') });
      row += Math.ceil(lhPx(ctx, 'headline') / ctx.grid.baseline) + 4;
    }

    const numberW = ctx.grid.baseline * 7;
    // Row pitch is NOT uniform: it grows slightly down the list. A perfectly even
    // pitch across rows of different content length is the clearest signal a list
    // was generated rather than laid out.
    const basePitch = Math.ceil((lhPx(ctx, 'title') + lhPx(ctx, 'body')) / ctx.grid.baseline) + 3;

    items.forEach((item, i) => {
      const y = baselineY(ctx.grid, row);
      const numId = `${ctx.idPrefix}_num_${i}`;
      const titleId = `${ctx.idPrefix}_listtitle_${i}`;
      const bodyId = `${ctx.idPrefix}_listbody_${i}`;

      calls.push(...emitText(ctx, numId, String(i + 1).padStart(2, '0'), 'title', {
        x: left + numberW / 2, y, width: numberW, fill: palette.accent, weight: 700, align: 'left',
      }));
      calls.push(...emitText(ctx, titleId, item.title ?? '', 'title', {
        x: left + numberW + (w - numberW) / 2, y, width: w - numberW,
        fill: palette.fg, weight: 600, align: 'left',
      }));
      if (item.body) {
        const body = textMetricsFor(ctx, 'body');
        calls.push(...emitText(ctx, bodyId, breakLines(item.body, Math.floor((w - numberW) / (body.fontSizePx * 0.5)), 2).join('\n'), 'body', {
          x: left + numberW + (w - numberW) / 2,
          y: y + lhPx(ctx, 'title') + ctx.grid.baseline,
          width: w - numberW, fill: palette.muted, align: 'left',
        }));
        slots.list!.push(numId, titleId, bodyId);
      } else {
        slots.list!.push(numId, titleId);
      }
      boxes.push({ width: w, height: lhPx(ctx, 'title') + (item.body ? lhPx(ctx, 'body') : 0) });
      row += basePitch + i; // the deliberate non-uniformity
    });

    return { calls, slots, boxes };
  },
};

// ── endcard.mark_and_line ─────────────────────────────────────────────

export const endcardMarkAndLine: LayoutTemplate = {
  id: 'endcard.mark_and_line',
  displayName: 'End Card',
  intent: 'A mark centred high, a single line of type beneath, everything else empty.',
  tags: ['endcard', 'cta', 'logo', 'closing'],
  packs: ['apple_keynote', 'luxury_film', 'saas_explainer', 'swiss_editorial', 'broadcast_sports'],
  slots: [
    { role: 'mark', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'cta', required: false, max: 1 },
  ],
  negativeSpaceRatio: [0.68, 0.9],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    // A radial lift centred behind the mark — the end card's one job is to make
    // the mark the only thing in the frame.
    calls.push(...emitBackdrop(ctx, { kind: 'radial', lift: 0.09 }).calls);

    const rows = baselineRows(ctx.grid);
    const markRow = Math.round(rows * pick(rng, [0.36, 0.4, 0.44]));
    const markSize = Math.round(ctx.grid.baseline * pick(rng, [9, 11, 13]));

    const markId = `${ctx.idPrefix}_mark`;
    calls.push(...emitRule(ctx, markId, {
      x: ctx.width / 2, y: baselineY(ctx.grid, markRow), width: markSize, thickness: markSize, fill: palette.accent,
    }));
    calls.push({ name: 'set_shadow_stack', args: {
      nodeId: markId,
      shadows: elevation(3, { background: palette.bg, angle: 90, scale: ctx.height / 1080 }),
    } });
    slots.mark = [markId];
    boxes.push({ width: markSize, height: markSize });

    if (content.headline) {
      const id = `${ctx.idPrefix}_headline`;
      const w = spanWidth(ctx.grid, [2, 9]);
      calls.push(...emitText(ctx, id, content.headline, 'headline', {
        x: ctx.width / 2,
        y: baselineY(ctx.grid, markRow + Math.ceil(markSize / ctx.grid.baseline) + 5),
        width: w, fill: palette.fg,
      }));
      slots.headline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'headline') });
    }

    if (content.cta) {
      const id = `${ctx.idPrefix}_cta`;
      const w = spanWidth(ctx.grid, [3, 8]);
      calls.push(...emitText(ctx, id, content.cta.toUpperCase(), 'overline', {
        x: ctx.width / 2, y: baselineY(ctx.grid, Math.round(rows * 0.78)), width: w, fill: palette.muted,
      }));
      slots.cta = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'overline') });
    }

    return { calls, slots, boxes };
  },
};

// ── lowerthird.bar_and_name ───────────────────────────────────────────

export const lowerThirdBar: LayoutTemplate = {
  id: 'lowerthird.bar_and_name',
  displayName: 'Lower Third',
  intent: 'Broadcast name plate in the lower left: accent bar, name, role.',
  tags: ['lowerthird', 'broadcast', 'name', 'caption'],
  packs: ['broadcast_sports', 'cyberpunk_kinetic', 'saas_explainer', 'swiss_editorial'],
  slots: [
    { role: 'headline', required: true, max: 1 },
    { role: 'support', required: false, max: 1 },
    { role: 'rule', required: false, max: 1 },
  ],
  // A lower third leaves the frame almost entirely empty by definition — it is an
  // overlay, not a full layout, so the usual space rule does not apply.
  negativeSpaceRatio: [0.8, 0.97],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = {};
    const boxes: ComposeResult['boxes'] = [];

    // Deliberately NO backdrop: a lower third overlays existing footage. Emitting
    // a background here would cover whatever it is captioning.
    const rows = baselineRows(ctx.grid);
    const row = Math.round(rows * pick(rng, [0.74, 0.78]));
    const span: [number, number] = [0, 4];
    const left = columnLeft(ctx.grid, span[0]);
    const w = spanWidth(ctx.grid, span);

    const nameStyle = textMetricsFor(ctx, 'title');
    const barW = Math.max(4, Math.round(ctx.height / 200));
    const barH = lhPx(ctx, 'title') + (content.support ? lhPx(ctx, 'caption') : 0);

    // The bar opens FIRST in motion, so it is emitted first and given its own id —
    // the technique that animates this looks for `rule`.
    const barId = `${ctx.idPrefix}_bar`;
    calls.push(...emitRule(ctx, barId, {
      x: left, y: baselineY(ctx.grid, row) + barH / 2, width: barW, thickness: barH,
    }));
    slots.rule = [barId];
    boxes.push({ width: barW, height: barH });

    const textLeft = left + barW + ctx.grid.baseline * 2;
    const textW = w - barW - ctx.grid.baseline * 2;

    const nameId = `${ctx.idPrefix}_headline`;
    calls.push(...emitText(ctx, nameId, content.headline ?? '', 'title', {
      x: textLeft + textW / 2, y: baselineY(ctx.grid, row), width: textW,
      fill: palette.fg, weight: 700, align: 'left',
    }));
    slots.headline = [nameId];
    boxes.push({ width: textW, height: lhPx(ctx, 'title') });

    if (content.support) {
      const id = `${ctx.idPrefix}_support`;
      calls.push(...emitText(ctx, id, content.support.toUpperCase(), 'overline', {
        x: textLeft + textW / 2,
        y: baselineY(ctx.grid, row) + lhPx(ctx, 'title'),
        width: textW, fill: palette.accentText, align: 'left',
      }));
      slots.support = [id];
      boxes.push({ width: textW, height: lhPx(ctx, 'overline') });
    }

    void nameStyle;
    return { calls, slots, boxes };
  },
};

// ── data.terminal_block ───────────────────────────────────────────────

export const terminalBlock: LayoutTemplate = {
  id: 'data.terminal_block',
  displayName: 'Terminal Block',
  intent: 'Monospaced data panel with a header rule and aligned rows. Technical, dense.',
  tags: ['data', 'mono', 'technical', 'terminal', 'cyberpunk'],
  packs: ['cyberpunk_kinetic', 'swiss_editorial', 'saas_explainer'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'list', required: true, max: 6 },
  ],
  negativeSpaceRatio: [0.3, 0.55],
  variants: 2,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { list: [] };
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 90, lift: 0.04 }).calls);

    const items = (content.items ?? []).slice(0, 6);
    const span: [number, number] = pick(rng, [[1, 7], [2, 8]] as [number, number][]);
    const left = columnLeft(ctx.grid, span[0]);
    const w = spanWidth(ctx.grid, span);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * 0.26);

    const mono = textMetricsFor(ctx, 'mono');
    const panelH = (items.length + 2) * mono.fontSizePx * mono.lineHeight + ctx.grid.baseline * 6;
    const panelId = `${ctx.idPrefix}_panel`;
    calls.push(...emitPanel(ctx, panelId, {
      x: left + w / 2, y: baselineY(ctx.grid, row) + panelH / 2 - ctx.grid.baseline * 2,
      width: w, height: panelH,
    }, { level: 3, glassy: true, radiusStep: 1 }));
    boxes.push({ width: w, height: panelH });

    const pad = ctx.grid.baseline * 3;
    const innerW = w - pad * 2;

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: left + pad + innerW / 2, y: baselineY(ctx.grid, row), width: innerW,
        fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      row += 3;
      const ruleId = `${ctx.idPrefix}_headrule`;
      calls.push(...emitRule(ctx, ruleId, {
        x: left + pad + innerW / 2, y: baselineY(ctx.grid, row), width: innerW, thickness: 1, fill: palette.line,
      }));
      row += 2;
    }

    // Monospaced rows in a fixed pitch. Uniformity is CORRECT here and nowhere
    // else in this file: a terminal's whole visual grammar is a fixed character
    // cell, and breaking it would read as a rendering bug rather than as craft.
    const pitch = Math.ceil((mono.fontSizePx * mono.lineHeight) / ctx.grid.baseline) + 1;
    items.forEach((item, i) => {
      const y = baselineY(ctx.grid, row + i * pitch);
      const keyId = `${ctx.idPrefix}_key_${i}`;
      const valId = `${ctx.idPrefix}_val_${i}`;
      calls.push(...emitText(ctx, keyId, item.label ?? item.title ?? '', 'mono', {
        x: left + pad + innerW * 0.3, y, width: innerW * 0.6, fill: palette.muted, align: 'left',
      }));
      calls.push(...emitText(ctx, valId, item.value ?? item.body ?? '', 'mono', {
        x: left + pad + innerW * 0.8, y, width: innerW * 0.4, fill: palette.fg, weight: 600, align: 'right',
      }));
      slots.list!.push(keyId, valId);
      boxes.push({ width: innerW, height: mono.fontSizePx * mono.lineHeight });
    });

    return { calls, slots, boxes };
  },
};

// ── editorial.rule_stack ──────────────────────────────────────────────

export const ruleStack: LayoutTemplate = {
  id: 'editorial.rule_stack',
  displayName: 'Rule Stack',
  intent: 'Heavy horizontal rules separating stacked type bands. Swiss poster structure.',
  tags: ['editorial', 'swiss', 'rules', 'bands', 'poster'],
  packs: ['swiss_editorial', 'cyberpunk_kinetic', 'luxury_film'],
  slots: [
    { role: 'overline', required: false, max: 1 },
    { role: 'headline', required: true, max: 1 },
    { role: 'list', required: false, max: 4 },
    { role: 'rule', required: false, max: 4 },
  ],
  negativeSpaceRatio: [0.38, 0.62],
  variants: 3,
  compose(ctx, content, seed): ComposeResult {
    const rng = mulberry32(seed);
    const { palette } = ctx.pack;
    const calls: ToolCall[] = [];
    const slots: ComposeResult['slots'] = { rule: [], list: [] };
    const boxes: ComposeResult['boxes'] = [];

    calls.push(...emitBackdrop(ctx, { angle: 90, lift: 0.03 }).calls);

    const span: [number, number] = [0, ctx.grid.columns - 1];
    const left = columnLeft(ctx.grid, 0);
    const w = spanWidth(ctx.grid, span);
    const rows = baselineRows(ctx.grid);
    let row = Math.round(rows * pick(rng, [0.14, 0.18]));
    const ruleT = Math.max(4, Math.round(ctx.height / 150));

    const addRule = (thickness: number): void => {
      const id = `${ctx.idPrefix}_rule_${slots.rule!.length}`;
      calls.push(...emitRule(ctx, id, {
        x: left + w / 2, y: baselineY(ctx.grid, row), width: w, thickness, fill: palette.fg,
      }));
      slots.rule!.push(id);
      boxes.push({ width: w, height: thickness });
      row += Math.ceil(thickness / ctx.grid.baseline) + 2;
    };

    addRule(ruleT);

    if (content.overline) {
      const id = `${ctx.idPrefix}_overline`;
      calls.push(...emitText(ctx, id, content.overline.toUpperCase(), 'overline', {
        x: left + w / 2, y: baselineY(ctx.grid, row), width: w, fill: palette.accentText, align: 'left',
      }));
      slots.overline = [id];
      boxes.push({ width: w, height: lhPx(ctx, 'overline') });
      row += 3;
    }

    if (content.headline) {
      const s = textMetricsFor(ctx, 'display');
      const lines = breakLines(content.headline, Math.max(6, Math.floor(w / (s.fontSizePx * 0.48))), 3);
      const ids: string[] = [];
      lines.forEach((line, i) => {
        const id = `${ctx.idPrefix}_headline_${i}`;
        calls.push(...emitText(ctx, id, line.toUpperCase(), 'display', {
          x: left + w / 2,
          y: baselineY(ctx.grid, row + Math.round((i * lhPx(ctx, 'display')) / ctx.grid.baseline)),
          width: w, fill: palette.fg, align: 'left',
        }));
        ids.push(id);
        boxes.push({ width: w, height: lhPx(ctx, 'display') });
      });
      slots.headline = ids;
      row += Math.ceil((lines.length * lhPx(ctx, 'display')) / ctx.grid.baseline) + 2;
    }

    // A thinner rule under the headline than above it: two rules of equal weight
    // read as a border, and a border is not structure.
    addRule(Math.max(1, Math.round(ruleT / 3)));

    const items = (content.items ?? []).slice(0, 4);
    if (items.length) {
      const per = Math.floor(ctx.grid.columns / items.length);
      items.forEach((item, i) => {
        const s2: [number, number] = [i * per, i * per + per - 1];
        const id = `${ctx.idPrefix}_band_${i}`;
        calls.push(...emitText(ctx, id, (item.label ?? item.title ?? '').toUpperCase(), 'overline', {
          x: spanCenterX(ctx.grid, s2), y: baselineY(ctx.grid, row),
          width: spanWidth(ctx.grid, s2), fill: palette.muted, align: 'left',
        }));
        slots.list!.push(id);
        boxes.push({ width: spanWidth(ctx.grid, s2), height: lhPx(ctx, 'overline') });
      });
    }

    void radius;
    return { calls, slots, boxes };
  },
};

export const CONTENT_TEMPLATES = [
  statTrio,
  featureTiles,
  quoteOversized,
  numberedSteps,
  endcardMarkAndLine,
  lowerThirdBar,
  terminalBlock,
  ruleStack,
] as const;
