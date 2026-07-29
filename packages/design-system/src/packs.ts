/**
 * Look Packs — the unit of taste.
 *
 * A pack is a curated slice of everything: palettes, a type pairing, a shape
 * vocabulary, a surface style, a pacing bias, a motion signature, and — crucially
 * — **allow/forbid lists over the technique libraries**.
 *
 * The allow/forbid lists are what keep the two motion vocabularies from
 * contaminating each other. Editorial motion and product-UI motion have rules
 * that directly contradict (bezier vs spring, 400–900ms vs 200–300ms, heavy blur
 * vs no blur), so "editorial technique applied to a card" produces output that
 * anyone who has shipped a product reads as wrong immediately. The pack is where
 * that separation is declared, and the UI-motion linter enforces it.
 *
 * Eight packs: six editorial/broadcast, two product.
 *
 * Pure.
 */

import type { HarmonyKind, Palette } from './color';
import { buildPalette } from './color';
import { pairing, type TypePairing, type ScaleRatio } from './type';
import { shapeLanguage, type ShapeLanguage, type ShapeVocabulary } from './shape';
import { treatment, type SurfaceStyle, type SurfaceTreatment } from './surface';

/** Which motion vocabulary a pack speaks. */
export type MotionVocabulary = 'editorial' | 'product';

export interface Pacing {
  /** The beat, ms. Everything else is a multiple or fraction of this. */
  baseBeatMs: number;
  /**
   * Stagger curve exponent. 1 = uniform (the amateur default), <1 = decelerating
   * (elements bunch at the start), >1 = accelerating.
   *
   * Never 1. A fixed interval between siblings is the single most recognisable
   * "generated" timing signature, and the timing linter errors on it.
   */
  staggerCurve: number;
  /** 0 = everything cross-dissolves, 1 = everything hard-cuts. */
  cutBias: number;
}

export interface MotionSignature {
  /** 0..1 — how much overshoot the pack's moves carry. */
  overshootBias: number;
  /** 0..1 — how readily it reaches for motion blur. */
  blurBias: number;
  /** Named bezier family the pack's entrances favour. */
  easeFamily: 'sharp' | 'smooth' | 'elastic' | 'mechanical' | 'organic';
}

export interface LookPack {
  id: string;
  displayName: string;
  /** One line, shown to the caster. Evocative, not exhaustive. */
  intent: string;
  vocabulary: MotionVocabulary;
  /** Accent colours this pack reads as. First is the default. */
  accents: readonly string[];
  mode: 'dark' | 'light';
  harmony: HarmonyKind;
  typePairingId: string;
  shapeVocabulary: ShapeVocabulary;
  surfaceStyle: SurfaceStyle;
  pacing: Pacing;
  motionSignature: MotionSignature;
  /** Technique ids this pack reaches for first. Empty = no preference. */
  prefer: readonly string[];
  /** Technique ids that must never be cast in this pack. */
  forbid: readonly string[];
  /**
   * Whole technique CATEGORIES this pack refuses, by id prefix.
   *
   * The `forbid` list alone does not scale. It named every editorial technique a
   * product pack must refuse, by hand — so the moment the technique library grew
   * from 22 entries to 39, both product packs silently started offering
   * `kinetic_type.line_push_stack` and `exit.scatter_out` for a dashboard.
   * Nobody forgot to update a list; the list was the wrong mechanism.
   *
   * A category is a rule, and a rule covers techniques that do not exist yet.
   */
  forbidCategories?: readonly string[];
  /**
   * Refuse any technique whose peak energy reaches this.
   *
   * The other half of the same rule. "Product UI never does anything at energy
   * 0.9" is true of every product interface, including the ones this library has
   * not modelled.
   */
  forbidAboveEnergy?: number;
  /** Layout template ids allowed. Empty = all templates whose `packs` include this pack. */
  layoutPrefer: readonly string[];
}

export const LOOK_PACKS: readonly LookPack[] = [
  {
    id: 'apple_keynote',
    displayName: 'Keynote',
    intent: 'Calm, confident product reveal. Deep space, one hero object, unhurried moves.',
    vocabulary: 'editorial',
    accents: ['#2b7eff', '#30d158', '#bf5af2'],
    mode: 'dark',
    harmony: 'analogous',
    typePairingId: 'grotesque',
    shapeVocabulary: 'soft',
    surfaceStyle: 'clean',
    pacing: { baseBeatMs: 520, staggerCurve: 0.72, cutBias: 0.15 },
    motionSignature: { overshootBias: 0.25, blurBias: 0.5, easeFamily: 'smooth' },
    prefer: ['entrance.rise_settle', 'camera.push_in_slow', 'emphasis.spec_reveal', 'background.aurora_drift',
      'entrance.depth_arrive', 'camera.handheld_float', 'background.spotlight_sweep',
      'camera.orbit_reveal', 'entrance.unfold'],
    forbid: ['kinetic_type.hard_cut_stack', 'transition.glitch_slam', 'kinetic_type.scramble_decode'],
    layoutPrefer: ['hero.centered_stack', 'stat.trio', 'endcard.mark_and_line'],
  },
  {
    id: 'swiss_editorial',
    displayName: 'Swiss Editorial',
    intent: 'Asymmetric grid, brutal type contrast, hard cuts. Nothing is centred.',
    vocabulary: 'editorial',
    accents: ['#ff3b1f', '#0a0a0c', '#f5f2eb'],
    mode: 'light',
    harmony: 'complementary',
    typePairingId: 'swiss',
    shapeVocabulary: 'hard',
    surfaceStyle: 'print',
    pacing: { baseBeatMs: 340, staggerCurve: 0.62, cutBias: 0.85 },
    motionSignature: { overshootBias: 0.35, blurBias: 0.7, easeFamily: 'sharp' },
    prefer: ['kinetic_type.hard_cut_stack', 'transition.rule_wipe', 'entrance.mask_rise', 'emphasis.rule_underline',
      'entrance.wipe_columns', 'kinetic_type.line_push_stack', 'emphasis.highlight_sweep',
      'entrance.unfold', 'exit.wipe_off'],
    forbid: ['camera.crash_zoom', 'background.aurora_drift', 'entrance.scale_pop_soft'],
    layoutPrefer: ['editorial.split_asymmetric', 'editorial.rule_stack', 'quote.oversized'],
  },
  {
    id: 'broadcast_sports',
    displayName: 'Broadcast Sports',
    intent: 'High-energy, angular, unapologetically loud. Lower thirds and speed.',
    vocabulary: 'editorial',
    accents: ['#ffd60a', '#ff375f', '#0a84ff'],
    mode: 'dark',
    harmony: 'split',
    typePairingId: 'geometric',
    shapeVocabulary: 'clipped',
    surfaceStyle: 'screen',
    pacing: { baseBeatMs: 240, staggerCurve: 1.35, cutBias: 0.95 },
    motionSignature: { overshootBias: 0.7, blurBias: 1, easeFamily: 'mechanical' },
    prefer: ['transition.streak_wipe', 'kinetic_type.slam_in', 'emphasis.flash_pop', 'camera.crash_zoom',
      'entrance.stamp_impact', 'camera.whip_pan', 'exit.scatter_out',
      'entrance.shutter_bands', 'transition.push_through', 'emphasis.scale_punch'],
    forbid: ['camera.push_in_slow', 'entrance.blur_resolve_slow'],
    layoutPrefer: ['lowerthird.bar_and_name', 'stat.trio', 'hero.offset_mark'],
  },
  {
    id: 'cyberpunk_kinetic',
    displayName: 'Cyberpunk Kinetic',
    intent: 'Neon on near-black, glitch, scanlines, monospace data. Deliberately noisy.',
    vocabulary: 'editorial',
    accents: ['#00f0ff', '#ff2d95', '#c6ff00'],
    mode: 'dark',
    harmony: 'complementary',
    typePairingId: 'technical',
    shapeVocabulary: 'clipped',
    surfaceStyle: 'crt',
    pacing: { baseBeatMs: 200, staggerCurve: 1.5, cutBias: 0.9 },
    motionSignature: { overshootBias: 0.5, blurBias: 0.85, easeFamily: 'mechanical' },
    prefer: ['kinetic_type.scramble_decode', 'transition.glitch_slam', 'background.grid_scan', 'emphasis.chromatic_pulse',
      'entrance.type_writer_block', 'kinetic_type.marquee_band', 'entrance.split_flap',
      'background.contour_drift', 'kinetic_type.vertical_ticker'],
    forbid: ['entrance.rise_settle', 'camera.push_in_slow'],
    layoutPrefer: ['data.terminal_block', 'editorial.rule_stack', 'hero.offset_mark'],
  },
  {
    id: 'luxury_film',
    displayName: 'Luxury Film',
    intent: 'Enormous negative space, hairline strokes, slow reveals. Restraint as the message.',
    vocabulary: 'editorial',
    accents: ['#c8a862', '#1a1a18', '#e8e4dc'],
    mode: 'dark',
    harmony: 'mono',
    typePairingId: 'editorial',
    shapeVocabulary: 'hard',
    surfaceStyle: 'film',
    pacing: { baseBeatMs: 760, staggerCurve: 0.6, cutBias: 0.1 },
    motionSignature: { overshootBias: 0.1, blurBias: 0.4, easeFamily: 'organic' },
    prefer: ['entrance.mask_rise', 'camera.drift_parallax', 'emphasis.hairline_draw', 'transition.slow_dissolve',
      'background.noise_field', 'transition.iris', 'camera.handheld_float',
      'camera.orbit_reveal'],
    forbid: ['kinetic_type.slam_in', 'transition.glitch_slam', 'emphasis.flash_pop', 'camera.crash_zoom'],
    layoutPrefer: ['hero.vast_space', 'quote.oversized', 'endcard.mark_and_line'],
  },
  {
    id: 'saas_explainer',
    displayName: 'SaaS Explainer',
    intent: 'Friendly, bright, information-dense. Cards, stats, a clear reading order.',
    vocabulary: 'editorial',
    accents: ['#5b5bd6', '#12a594', '#e5484d'],
    mode: 'light',
    harmony: 'triad',
    typePairingId: 'humanist',
    shapeVocabulary: 'soft',
    surfaceStyle: 'clean',
    pacing: { baseBeatMs: 400, staggerCurve: 0.8, cutBias: 0.3 },
    motionSignature: { overshootBias: 0.3, blurBias: 0.35, easeFamily: 'smooth' },
    prefer: ['entrance.rise_settle', 'emphasis.count_up', 'background.soft_mesh', 'kinetic_type.word_cascade',
      'kinetic_type.stack_collapse', 'entrance.wipe_columns', 'exit.fall_away',
      'background.contour_drift', 'emphasis.scale_punch'],
    forbid: ['transition.glitch_slam', 'camera.crash_zoom'],
    layoutPrefer: ['grid.feature_tiles', 'stat.trio', 'hero.centered_stack', 'list.numbered_steps'],
  },

  // ── Product packs — the `product` motion vocabulary ──────────────────
  {
    id: 'saas_product',
    displayName: 'SaaS Product UI',
    intent: 'Real interface, real spring physics. Fast, small moves, shared-element transitions.',
    vocabulary: 'product',
    accents: ['#5b5bd6', '#0a84ff', '#12a594'],
    mode: 'light',
    harmony: 'analogous',
    typePairingId: 'humanist',
    shapeVocabulary: 'soft',
    surfaceStyle: 'clean',
    // Product pacing is a different regime entirely: the "beat" is one UI
    // transition, not a musical bar.
    pacing: { baseBeatMs: 260, staggerCurve: 0.85, cutBias: 0.2 },
    motionSignature: { overshootBias: 0.15, blurBias: 0, easeFamily: 'smooth' },
    prefer: ['ui.shared_element_expand', 'ui.list_stagger_in', 'ui.press_feedback', 'ui.toast_slide', 'ui.chart_draw_on'],
    // Every editorial technique is forbidden here, and this is the single most
    // important field in the file. It is what makes acceptance criterion 6b —
    // "a product-UI prompt never emits an editorial technique" — checkable.
    forbid: [
      // EVERY kinetic-type technique. Type that performs is editorial by
      // definition; a product interface's type is read, not watched.
      'kinetic_type.hard_cut_stack', 'kinetic_type.slam_in', 'kinetic_type.scramble_decode',
      'kinetic_type.word_cascade',
      'transition.glitch_slam', 'transition.streak_wipe', 'transition.rule_wipe',
      'camera.crash_zoom', 'emphasis.flash_pop', 'background.grid_scan',
      // Crosses most of the frame. UI moves 8–24px; the editorial slide is a
      // title-card entrance wearing an interface's clothes.
      'entrance.slide_in_edge',
    ],
    // Categories, not a list of ids — see `forbidCategories`. Type that performs,
    // camera work, full-frame transitions and choreographed exits are all
    // editorial by construction: a product interface has no camera and its type
    // is read, not watched.
    forbidCategories: ['kinetic_type', 'camera', 'transition', 'exit'],
    // Nothing in a real interface peaks this hard.
    forbidAboveEnergy: 0.85,
    layoutPrefer: ['ui.dashboard_frame', 'ui.browser_window', 'ui.card_detail_pair'],
  },
  {
    id: 'mobile_app',
    displayName: 'Mobile App',
    intent: 'Phone frame, safe areas, gesture-driven. Sheets, tabs, momentum scroll.',
    vocabulary: 'product',
    accents: ['#0a84ff', '#30d158', '#ff9f0a'],
    mode: 'dark',
    harmony: 'analogous',
    typePairingId: 'grotesque',
    shapeVocabulary: 'pill',
    surfaceStyle: 'clean',
    pacing: { baseBeatMs: 240, staggerCurve: 0.85, cutBias: 0.2 },
    motionSignature: { overshootBias: 0.2, blurBias: 0, easeFamily: 'smooth' },
    prefer: ['ui.sheet_present', 'ui.shared_element_expand', 'ui.tab_switch', 'ui.momentum_scroll', 'ui.press_feedback'],
    forbid: [
      // EVERY kinetic-type technique. Type that performs is editorial by
      // definition; a product interface's type is read, not watched.
      'kinetic_type.hard_cut_stack', 'kinetic_type.slam_in', 'kinetic_type.scramble_decode',
      'kinetic_type.word_cascade',
      'transition.glitch_slam', 'transition.streak_wipe', 'transition.rule_wipe',
      'camera.crash_zoom', 'emphasis.flash_pop', 'background.grid_scan',
      'entrance.slide_in_edge',
    ],
    // Categories, not a list of ids — see `forbidCategories`. Type that performs,
    // camera work, full-frame transitions and choreographed exits are all
    // editorial by construction: a product interface has no camera and its type
    // is read, not watched.
    forbidCategories: ['kinetic_type', 'camera', 'transition', 'exit'],
    // Nothing in a real interface peaks this hard.
    forbidAboveEnergy: 0.85,
    layoutPrefer: ['ui.phone_frame', 'ui.sheet_stack', 'ui.card_detail_pair'],
  },
] as const;

export function lookPack(id: string): LookPack {
  return LOOK_PACKS.find((p) => p.id === id) ?? LOOK_PACKS[0]!;
}

/** Packs that speak a given motion vocabulary. */
export function packsFor(vocabulary: MotionVocabulary): readonly LookPack[] {
  return LOOK_PACKS.filter((p) => p.vocabulary === vocabulary);
}

// ── Resolution ────────────────────────────────────────────────────────

/**
 * A pack with everything concrete: palette built, type pairing loaded, shape and
 * surface resolved.
 *
 * This is what a template or technique receives. Resolving here rather than in
 * each emitter is what guarantees two templates in the same pack agree about the
 * palette down to the hex.
 */
export interface ResolvedPack {
  pack: LookPack;
  palette: Palette;
  typePairing: TypePairing;
  ratio: ScaleRatio;
  shape: ShapeLanguage;
  surface: SurfaceTreatment;
}

export interface ResolveOptions {
  /** Override the pack's default accent — a brand colour from the brief. */
  accent?: string;
  /** Override light/dark. */
  mode?: 'dark' | 'light';
  /** Index into `pack.accents` when no explicit accent is given. */
  accentIndex?: number;
}

export function resolvePack(id: string, o: ResolveOptions = {}): ResolvedPack {
  const pack = lookPack(id);
  const accent = o.accent ?? pack.accents[(o.accentIndex ?? 0) % pack.accents.length]!;
  const mode = o.mode ?? pack.mode;
  const tp = pairing(pack.typePairingId);
  return {
    pack,
    palette: buildPalette({ accent, mode, harmony: pack.harmony }),
    typePairing: tp,
    ratio: tp.ratio,
    shape: shapeLanguage(pack.shapeVocabulary),
    surface: treatment(pack.surfaceStyle),
  };
}

/**
 * Would this pack allow that technique/template id?
 *
 * `meta` is optional because layout template ids have no category or energy —
 * for those the id list is the whole rule. For techniques, pass it: without the
 * category and energy this can only check the hand-written list, which is the
 * failure mode the rules exist to close.
 */
export function packAllows(
  pack: LookPack,
  id: string,
  meta?: { category?: string; maxEnergy?: number },
): boolean {
  if (pack.forbid.includes(id)) return false;
  // Fall back to the id prefix. Technique ids are category-prefixed by
  // convention and a test enforces it, so this is reliable even when the caller
  // has only the string.
  const category = meta?.category ?? (id.includes('.') ? id.slice(0, id.indexOf('.')) : undefined);
  if (category && pack.forbidCategories?.includes(category)) return false;
  if (
    pack.forbidAboveEnergy !== undefined &&
    meta?.maxEnergy !== undefined &&
    meta.maxEnergy >= pack.forbidAboveEnergy
  ) {
    return false;
  }
  return true;
}
