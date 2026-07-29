/**
 * The design linter.
 *
 * ## Why this is not a critic
 *
 * Every rule here is mechanical and free. A vision model asked "is this design
 * good?" answers with the mean of design discourse; asked to spot a pure-black
 * background it may or may not notice, because it is looking at a JPEG where
 * `#000000` and `#0A0A0C` are visually identical. These are *arithmetic*
 * questions about the scene graph, and arithmetic is exactly what a critic should
 * not be spending a render and a model turn on.
 *
 * ## Errors block; warnings inform
 *
 * An error means the output has a defect that is objectively present and
 * mechanically fixable — a flat fill, pure black, a single shadow, untracked
 * display type. Those go back through a deterministic repair pass, not to an LLM.
 *
 * Warnings are the judgement calls: how much negative space is right, whether
 * everything being centred is a choice. They are reported and not enforced,
 * because a lower third legitimately leaves 95% of the frame empty and a Keynote
 * hero legitimately centres everything.
 *
 * ## Read the false-positive discipline in `verify.ts`
 *
 * The motion verifier in the app grew five rules that all fired on known-good
 * output. The lesson carried here: every rule below documents what it must NOT
 * fire on, and those exemptions are structural rather than commented.
 *
 * Pure — operates on a description of the scene, not on the scene itself, so it
 * runs in the caster before execution AND in the editor after it.
 */

import { contrast, isPureBlackOrWhite, requiredContrast } from './color';
import { isOnGrid, MIN_NEGATIVE_SPACE, negativeSpaceRatio, type GridSpec } from './grid';
import { isDisplaySize, hasHierarchyContrast, MIN_SIZE_RATIO, MIN_WEIGHT_CONTRAST } from './type';
import { hasUniformRadius } from './shape';

export type DesignRule =
  | 'FLAT_FILL'
  | 'PURE_BLACK_WHITE'
  | 'SINGLE_SHADOW'
  | 'OFF_GRID'
  | 'WEAK_TYPE_CONTRAST'
  | 'DEFAULT_TRACKING'
  | 'NO_TEXTURE_LAYER'
  | 'CONTRAST_FAIL'
  | 'SPACE_STARVED'
  | 'ACCENT_OVERUSE'
  | 'EVERYTHING_CENTERED'
  | 'PRIMITIVE_ONLY'
  | 'DEFAULT_RADIUS';

export type Severity = 'error' | 'warn';

export interface DesignFinding {
  rule: DesignRule;
  severity: Severity;
  nodeIds: string[];
  /** Addressed to whoever fixes it — a repair instruction, not an observation. */
  message: string;
}

/**
 * What the linter needs to know about a layer.
 *
 * Deliberately a flat description rather than an engine node: the caster can
 * build one from `ToolCall[]` before anything executes, and the editor can build
 * one from the live graph after. Same rules, both sides.
 */
export interface LintLayer {
  id: string;
  name?: string;
  kind: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fill?: string;
  /** Set when the layer carries a gradient, image, or procedural fill. */
  hasGradient?: boolean;
  /** Effect types on the layer. */
  effects?: readonly string[];
  /** Number of shadow layers. */
  shadowCount?: number;
  cornerRadius?: number;
  /** Text only. */
  fontSizePx?: number;
  fontWeight?: number;
  letterSpacingPx?: number;
  /** True for imported/generated assets — media, SVG, image. */
  isAsset?: boolean;
  /** Text alignment, for the everything-centred check. */
  align?: string;
  /** Whether this layer is a frame-wide adjustment/treatment layer. */
  isTreatment?: boolean;
  /**
   * The surface this element actually sits on, when it is not the composition
   * background — a button fill, a card fill.
   *
   * Without it the contrast rule reports a false positive on every piece of text
   * inside a coloured control: white label on an accent button is correct and
   * scores terribly against the *frame* background. Only the template knows what
   * an element sits on, so only the template can supply this.
   */
  onSurface?: string;
}

export interface LintScene {
  grid: GridSpec;
  background: string;
  accent: string;
  layers: readonly LintLayer[];
  /** Set when the caster knows the layout template's declared space target. */
  negativeSpaceTarget?: [number, number];
}

/** Rules that are treated as errors. Everything else is a warning. */
const ERROR_RULES: ReadonlySet<DesignRule> = new Set([
  'FLAT_FILL',
  'PURE_BLACK_WHITE',
  'SINGLE_SHADOW',
  'OFF_GRID',
  'WEAK_TYPE_CONTRAST',
  'DEFAULT_TRACKING',
  'NO_TEXTURE_LAYER',
  'CONTRAST_FAIL',
]);

/** Effect types that count as texture. */
const TEXTURE_EFFECTS: ReadonlySet<string> = new Set([
  'noise', 'fractal-noise', 'gradient-ramp', 'four-color-gradient', 'turbulent-displace',
]);

/** Layers that fill (almost) the whole frame. */
function fillsFrame(l: LintLayer, g: GridSpec): boolean {
  return (l.width ?? 0) >= g.width * 0.95 && (l.height ?? 0) >= g.height * 0.95;
}

/**
 * Layer kinds that are not visual elements and must not be design-linted.
 *
 * A camera, a null and a light have no box, no fill and no place on the grid —
 * they are rig, not design. Including them reported a camera created by
 * `camera.drift_parallax` as `OFF_GRID`, which is a rule firing on something the
 * rule does not apply to and exactly the false-positive class that makes a linter
 * worse than none.
 */
const NON_VISUAL_KINDS: ReadonlySet<string> = new Set(['camera', 'null', 'light', 'audio']);

function isVisual(l: LintLayer): boolean {
  return !NON_VISUAL_KINDS.has(l.kind);
}

/** Fraction of the frame a layer covers. */
function areaFraction(l: LintLayer, g: GridSpec): number {
  const frame = g.width * g.height;
  if (frame <= 0) return 0;
  return ((l.width ?? 0) * (l.height ?? 0)) / frame;
}

/**
 * Is this element sitting inside another (non-full-frame) element?
 *
 * Computed from geometry rather than declared parentage, so it cannot be gamed:
 * a template claiming a container it does not actually sit inside gains nothing.
 * The container must be meaningfully larger, or a text layer and the rule beneath
 * it would each count as containing the other.
 */
function isInsideAPanel(l: LintLayer, layers: readonly LintLayer[], g: GridSpec): boolean {
  const w = l.width ?? 0;
  const h = l.height ?? 0;
  const left = l.x - w / 2;
  const right = l.x + w / 2;
  const top = l.y - h / 2;
  const bottom = l.y + h / 2;

  return layers.some((p) => {
    if (p.id === l.id || p.isTreatment || fillsFrame(p, g)) return false;
    const pw = p.width ?? 0;
    const ph = p.height ?? 0;
    if (pw * ph < w * h * 1.4) return false; // not meaningfully bigger
    return (
      left >= p.x - pw / 2 - 1 &&
      right <= p.x + pw / 2 + 1 &&
      top >= p.y - ph / 2 - 1 &&
      bottom <= p.y + ph / 2 + 1
    );
  });
}

/**
 * A one- or two-character text layer is an ornament, not a hierarchy level.
 *
 * A hanging quote mark, a bullet, an arrow, a numeral badge — these are set at
 * display size for graphic effect and are *supposed* to sit close in size to the
 * type they decorate. Counting them as hierarchy levels made `quote.oversized`
 * fail `WEAK_TYPE_CONTRAST` against its own quote in three packs, which is the
 * linter mistaking the design for the defect.
 */
function isOrnament(l: LintLayer): boolean {
  const text = l.name?.replace(/^[a-z]+: /, '') ?? '';
  return l.fontSizePx !== undefined && text.trim().length <= 2;
}

const find = (rule: DesignRule, nodeIds: string[], message: string): DesignFinding => ({
  rule,
  severity: ERROR_RULES.has(rule) ? 'error' : 'warn',
  nodeIds,
  message,
});

export function lintDesign(scene: LintScene): DesignFinding[] {
  const out: DesignFinding[] = [];
  const { grid: g } = scene;
  // Rig layers — cameras, nulls, lights — are filtered out once, here, rather
  // than remembered in each rule.
  const layers = scene.layers.filter(isVisual);

  // ── FLAT_FILL ─────────────────────────────────────────────────────────────
  // A full-frame layer with a single solid colour and nothing on it. Only
  // full-frame layers count: a flat-filled CARD is correct and extremely common,
  // and flagging those would fire on every well-built layout.
  //
  // A real IMAGE is exempt, and that exemption is not a loophole: the rule
  // exists because a single flat colour has no light source, and a photograph is
  // nothing but light source. Without this, a full-bleed hero — the most
  // ordinary layout in the medium — was reported as the very defect the rule was
  // written to catch.
  const backdrops = layers.filter((l) => fillsFrame(l, g) && !l.isTreatment && !l.isAsset);
  for (const l of backdrops) {
    const textured = (l.effects ?? []).some((e) => TEXTURE_EFFECTS.has(e));
    if (!l.hasGradient && !textured) {
      out.push(find('FLAT_FILL', [l.id],
        `'${l.name ?? l.id}' is a flat full-frame fill. Every background needs a light source: ` +
        `use create_gradient with OKLCH-computed stops, or add a gradient-ramp. A truly flat ` +
        `background is the most common single tell in generated design.`));
    }
  }

  // ── PURE_BLACK_WHITE ──────────────────────────────────────────────────────
  const pureIds = layers.filter((l) => l.fill && isPureBlackOrWhite(l.fill)).map((l) => l.id);
  if (isPureBlackOrWhite(scene.background)) pureIds.push('(composition background)');
  if (pureIds.length) {
    out.push(find('PURE_BLACK_WHITE', pureIds,
      `${pureIds.length} element(s) use pure #000000 or #FFFFFF. Physical surfaces reach neither. ` +
      `Use near-values instead — #0A0A0C and #FAFAF7 — which the palette builder already produces.`));
  }

  // ── SINGLE_SHADOW ─────────────────────────────────────────────────────────
  // A shadow COUNT of exactly 1. Zero is fine: a flush element should have no
  // shadow at all, and demanding one from every layer would be worse than the bug.
  const singles = layers.filter((l) => l.shadowCount === 1).map((l) => l.id);
  if (singles.length) {
    out.push(find('SINGLE_SHADOW', singles,
      `${singles.length} element(s) have exactly one shadow, which reads as a CSS default. ` +
      `Real depth is a stack: a tight contact shadow, a mid shadow, and a wide ambient one. ` +
      `Use set_shadow_stack with the output of elevation().`));
  }

  // ── OFF_GRID ──────────────────────────────────────────────────────────────
  // Full-frame layers and treatment layers are exempt: a backdrop is centred on
  // the frame, which is a legitimate position that no column span describes.
  // `width` is passed so a left-aligned or bleeding element is judged on the edge
  // that is actually anchored — see isOnGrid.
  //
  // Content INSIDE a panel is exempt too, and this is not a loophole: a card's
  // contents are inset by the card's padding and are aligned to the *card*, not
  // to the frame's columns. Requiring both is requiring the card to have zero
  // padding. Containment is computed geometrically rather than declared, so a
  // template cannot opt out of the rule by claiming a container it does not have.
  const offGrid = layers
    .filter((l) => !fillsFrame(l, g) && !l.isTreatment)
    .filter((l) => !isOnGrid(g, l.x, l.y, { width: l.width }))
    .filter((l) => !isInsideAPanel(l, layers, g))
    .map((l) => l.id);
  if (offGrid.length) {
    out.push(find('OFF_GRID', offGrid,
      `${offGrid.length} element(s) are not aligned to a column centre or a baseline row. ` +
      `"Nearly aligned" is the most reliable amateur signal in visual design — place elements ` +
      `with grid.place() rather than choosing x/y directly.`));
  }

  // ── WEAK_TYPE_CONTRAST ────────────────────────────────────────────────────
  // Adjacent levels by size. Two text layers at the SAME size are peers (a row of
  // labels), not a failed hierarchy — so identical sizes are skipped.
  const texts = layers
    .filter((l) => l.fontSizePx !== undefined && l.fontWeight !== undefined)
    .sort((a, b) => b.fontSizePx! - a.fontSizePx!);
  // Ornaments are excluded from the LADDER but still checked for contrast and
  // tracking below — they are decoration, not a rung.
  const ladder = texts.filter((l) => !isOrnament(l));
  for (let i = 1; i < ladder.length; i++) {
    const a = ladder[i - 1]!;
    const b = ladder[i]!;
    if (Math.abs(a.fontSizePx! - b.fontSizePx!) < 0.5) continue; // peers
    if (!hasHierarchyContrast(
      { fontSizePx: a.fontSizePx!, fontWeight: a.fontWeight! },
      { fontSizePx: b.fontSizePx!, fontWeight: b.fontWeight! },
    )) {
      out.push(find('WEAK_TYPE_CONTRAST', [a.id, b.id],
        `'${a.name ?? a.id}' (${a.fontSizePx}px/${a.fontWeight}) and '${b.name ?? b.id}' ` +
        `(${b.fontSizePx}px/${b.fontWeight}) differ by less than ${MIN_SIZE_RATIO}× in size AND ` +
        `less than ${MIN_WEIGHT_CONTRAST} in weight, so they read as one block. Widen either ` +
        `lever — two weights of one family beat two families.`));
    }
  }

  // ── DEFAULT_TRACKING ──────────────────────────────────────────────────────
  const untracked = texts
    .filter((l) => isDisplaySize(l.fontSizePx!) && Math.abs(l.letterSpacingPx ?? 0) < 0.5)
    .map((l) => l.id);
  if (untracked.length) {
    out.push(find('DEFAULT_TRACKING', untracked,
      `${untracked.length} display-size text layer(s) are at zero tracking. A font's default ` +
      `spacing is drawn for body copy; at display sizes it looks loose and unresolved. Tighten ` +
      `to −2% to −4% of the font size — use type.tracking(), which is already curve-correct.`));
  }

  // ── NO_TEXTURE_LAYER ──────────────────────────────────────────────────────
  // Only for compositions that own their frame. A lower third, a caption, a
  // watermark — anything with no full-frame backdrop — is an OVERLAY on footage
  // it did not create, and adding a grain pass over someone else's shot is not a
  // fix, it is damage. This rule fired on every lower third in every pack before
  // the exemption, which is the classic linter failure: correct rule, wrong scope.
  const ownsTheFrame = backdrops.length > 0;
  const hasTexture = layers.some(
    (l) => l.isTreatment || (l.effects ?? []).some((e) => TEXTURE_EFFECTS.has(e)),
  );
  if (ownsTheFrame && !hasTexture && layers.length > 0) {
    out.push(find('NO_TEXTURE_LAYER', [],
      `The composition has no grain, vignette or light source anywhere. Perfectly flat vector ` +
      `output is the clearest single signal nobody touched this. add_surface_treatment costs one ` +
      `adjustment layer — grain 2–5%, vignette 4–8%.`));
  }

  // ── CONTRAST_FAIL ─────────────────────────────────────────────────────────
  // Against the surface the text ACTUALLY sits on. Checking everything against
  // the composition background reported a white label on an accent button as a
  // failure — the classic false positive that makes a linter worse than none,
  // because the fix it demands would break the button.
  for (const t of texts) {
    if (!t.fill) continue;
    const surface = t.onSurface ?? scene.background;
    const required = requiredContrast(t.fontSizePx!, t.fontWeight!);
    const ratio = contrast(t.fill, surface);
    if (ratio < required) {
      out.push(find('CONTRAST_FAIL', [t.id],
        `'${t.name ?? t.id}' is ${ratio.toFixed(2)}:1 against ${surface} but needs ` +
        `${required}:1 at ${t.fontSizePx}px/${t.fontWeight}. Run the colour through ` +
        `color.enforceContrast(), which walks its own lightness rather than falling back to ` +
        `black or white.`));
    }
  }

  // ── SPACE_STARVED (warn) ──────────────────────────────────────────────────
  // Backdrops and treatment layers excluded — they cover the frame by definition,
  // so counting them would make every composition read as 0% empty.
  const contentBoxes = layers
    .filter((l) => !fillsFrame(l, g) && !l.isTreatment)
    .map((l) => ({ width: l.width ?? 0, height: l.height ?? 0 }));
  const space = negativeSpaceRatio(g, contentBoxes);
  const floor = scene.negativeSpaceTarget?.[0] ?? MIN_NEGATIVE_SPACE;
  if (space < floor) {
    out.push(find('SPACE_STARVED', [],
      `Only ${(space * 100).toFixed(0)}% of the frame is empty (target ≥ ${(floor * 100).toFixed(0)}%). ` +
      `Amateur layouts fill the frame; professional ones are commonly 40–60% empty. Narrow the ` +
      `column spans or drop an element.`));
  }

  // ── ACCENT_OVERUSE (warn) ─────────────────────────────────────────────────
  const accentArea = layers
    .filter((l) => l.fill === scene.accent && !l.isTreatment)
    .reduce((sum, l) => sum + areaFraction(l, g), 0);
  if (accentArea > 0.15) {
    out.push(find('ACCENT_OVERUSE', [],
      `The accent covers ${(accentArea * 100).toFixed(0)}% of the frame. Above about 15% an accent ` +
      `stops reading as emphasis and starts reading as noise — the 60/30/10 split exists for this. ` +
      `Move the bulk to the support colour.`));
  }

  // ── EVERYTHING_CENTERED (warn) ────────────────────────────────────────────
  const alignable = layers.filter((l) => l.align !== undefined);
  if (alignable.length >= 4) {
    const centred = alignable.filter((l) => l.align === 'center').length;
    if (centred / alignable.length > 0.8) {
      out.push(find('EVERYTHING_CENTERED', [],
        `${centred} of ${alignable.length} elements are centred. A centred stack is the mean of ` +
        `all layouts, which is to say the absence of a layout decision. Consider an asymmetric ` +
        `template — hero.offset_mark or editorial.split_asymmetric.`));
    }
  }

  // ── PRIMITIVE_ONLY (warn) ─────────────────────────────────────────────────
  if (layers.length > 2 && !layers.some((l) => l.isAsset)) {
    out.push(find('PRIMITIVE_ONLY', [],
      `Nothing in this composition is an imported or generated asset — it is entirely rectangles ` +
      `and text. That is the ceiling on how designed it can look. Place real imagery, an SVG mark, ` +
      `or an image used as a luma matte for a text reveal.`));
  }

  // ── DEFAULT_RADIUS (warn) ─────────────────────────────────────────────────
  const radii = layers.map((l) => l.cornerRadius).filter((r): r is number => r !== undefined && r > 0);
  if (hasUniformRadius(radii)) {
    out.push(find('DEFAULT_RADIUS', [],
      `All ${radii.length} rounded elements share one radius (${radii[0]}px). Real systems ` +
      `differentiate a card from a chip — use the radius scale (0/2/6/12/24) at two different steps.`));
  }

  return out;
}

/**
 * Weighted pass rate over the rules that ran, 0..1.
 *
 * Errors weigh three times a warning, so a piece with one flat fill scores worse
 * than a piece with three debatable warnings — which is the right ordering,
 * because the flat fill is objectively wrong and the warnings might not be.
 */
export function designScore(findings: readonly DesignFinding[]): number {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const penalty = errors * 3 + warns;
  // 13 rules; the worst realistic case trips most of them.
  return Math.max(0, 1 - penalty / 24);
}

/** Findings as a repair brief, or null when clean. */
export function formatDesignFindings(findings: readonly DesignFinding[]): string | null {
  if (!findings.length) return null;
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const lines: string[] = [];
  if (errors.length) {
    lines.push(`${errors.length} design error(s) — these block:`);
    lines.push(...errors.map((f) => `  [${f.rule}] ${f.message}`));
  }
  if (warns.length) {
    lines.push(`${warns.length} design warning(s) — judgement calls:`);
    lines.push(...warns.map((f) => `  [${f.rule}] ${f.message}`));
  }
  return lines.join('\n');
}
