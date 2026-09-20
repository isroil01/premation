/**
 * After Effects effects → this editor's effects.
 *
 * AE identifies an effect by a **match name** — `ADBE Gaussian Blur 2`, `CC
 * Sphere` — which is stable across AE versions and across UI languages. That,
 * and not the display name, is what this maps on: a French AE calls Gaussian
 * Blur "Flou gaussien" and writes `ADBE Gaussian Blur 2` all the same.
 *
 * Parameters are identified the same way, but positionally: an effect's Nth
 * parameter is `<match name>-000N`. That numbering is the order the plug-in
 * declared its parameters in — undocumented, and not the order the Effect
 * Controls panel shows — so parameters are matched by their LABEL instead, off
 * the `pard` record the file carries for each one. See `LABEL_SYNONYMS`.
 *
 * ## What is mapped, and what is not
 *
 * Two tiers, deliberately:
 *
 *  • **Typed** — the effect maps to one of ours and the label match found its
 *    parameters, so values and keyframes come across. This is the common
 *    ground: blurs, glows, shadows, colour correction, the generators people
 *    actually key.
 *
 *  • **Recognised** — the effect maps to one of ours but nothing matched, so it
 *    is added at ITS OWN defaults and the import reports it. An effect present
 *    with default settings is a visible, fixable half-match; an effect silently
 *    dropped looks like the importer never saw it.
 *
 * Anything else is reported by name and skipped. A third-party plug-in this
 * editor has no equivalent for cannot be faked, and pretending otherwise would
 * be worse than saying so.
 *
 * Adding a mapping is deliberately cheap: one line in `EFFECT_BY_MATCH_NAME`
 * for the effect, and — only where the two products name one thing differently
 * — one line in `LABEL_SYNONYMS`.
 */

import { EFFECT_DEFS, type EffectType } from '@core/effects/effects';

/**
 * AE match name → the effect this editor uses for it.
 *
 * Where AE splits what we join (Brightness & Contrast is one AE effect and two
 * of ours) the entry points at the closer half and `EFFECT_COMPANIONS` adds
 * the other.
 */
export const EFFECT_BY_MATCH_NAME: Readonly<Record<string, EffectType>> = {
  // ── Blur & Sharpen ────────────────────────────────────────────────
  'ADBE Gaussian Blur 2': 'gaussian-blur',
  'ADBE Gaussian Blur': 'gaussian-blur',
  'ADBE Box Blur2': 'fast-box-blur',
  'ADBE Fast Blur': 'fast-box-blur',
  'ADBE Motion Blur': 'directional-blur',
  'ADBE Radial Blur': 'radial-blur',
  'ADBE Channel Blur': 'channel-blur',
  'ADBE Compound Blur': 'compound-blur',
  'ADBE Bilateral': 'bilateral-blur',
  'ADBE Smart Blur': 'smart-blur',
  'ADBE Camera Lens Blur': 'camera-lens-blur',
  'ADBE Sharpen': 'sharpen',
  'ADBE Unsharp Mask2': 'unsharp-mask',
  'CC Cross Blur': 'cross-blur',
  'CC Radial Blur': 'radial-blur',
  'CC Radial Fast Blur': 'radial-fast-blur',
  'CC Vector Blur': 'vector-blur',

  // ── Stylize ───────────────────────────────────────────────────────
  'ADBE Glo2': 'glow',
  'ADBE Drop Shadow': 'drop-shadow',
  'ADBE Radial Shadow': 'radial-shadow',
  'ADBE Bevel Alpha': 'bevel-alpha',
  'ADBE Bevel Edges': 'bevel-edges',
  'ADBE Emboss': 'emboss',
  'ADBE Color Emboss': 'color-emboss',
  'ADBE Find Edges': 'find-edges',
  'ADBE Mosaic': 'mosaic',
  'ADBE Posterize': 'posterize',
  'ADBE Threshold2': 'threshold',
  'ADBE Roughen Edges': 'roughen-edges',
  'ADBE Scatter': 'scatter',
  'ADBE Brush Strokes': 'brush-strokes',
  'ADBE Cartoon': 'cartoon',
  'ADBE Strobe Light': 'strobe-light',
  'ADBE Texturize': 'texturize',
  'ADBE MotionTile': 'motion-tile',
  'ADBE Motion Tile': 'motion-tile',
  'CC Glass': 'glass',
  'CC HexTile': 'hex-tile',
  'CC Kaleida': 'kaleidoscope',
  'CC Threads': 'threads',
  'CC Plastic': 'plastic',
  'CC RepeTile': 'cc-repetile',
  'CC Tiler': 'cc-tiler',
  'CC Burn Film': 'burn-film',
  'CC Vignette': 'vignette',

  // ── Colour correction ─────────────────────────────────────────────
  'ADBE Brightness & Contrast 2': 'brightness',
  'ADBE Easy Levels2': 'levels',
  'ADBE Pro Levels2': 'levels',
  'ADBE CurvesCustom': 'curves',
  'ADBE HUE SATURATION': 'hue-saturation',
  'ADBE Tint': 'tint',
  'ADBE Tritone': 'tritone',
  'ADBE Exposure2': 'exposure',
  'ADBE Vibrance': 'vibrance',
  'ADBE Colorama': 'colorama',
  'ADBE SelectiveColor': 'selective-color',
  'ADBE Shadow/Highlight': 'shadow-highlight',
  'ADBE PhotoFilter': 'photo-filter',
  'ADBE Black&White': 'black-and-white',
  'ADBE ChannelMixer': 'channel-mixer',
  'ADBE Shift Channels': 'shift-channels',
  'ADBE Color Balance 2': 'color-balance',
  'ADBE Color Balance (HLS)': 'color-balance',
  'ADBE Gamma/Pedestal/Gain2': 'gamma-pedestal-gain',
  'ADBE Apply Color LUT2': 'apply-color-lut',
  'ADBE Change Color': 'change-color',
  'ADBE Change To Color': 'change-to-color',
  'ADBE Leave Color': 'leave-color',
  'ADBE Equalize': 'equalize',
  'ADBE AutoLevels': 'auto-levels',
  'ADBE AutoContrast': 'auto-contrast',
  'ADBE AutoColor': 'auto-color',
  'ADBE Invert': 'invert',
  'ADBE Broadcast Colors': 'broadcast-colors',
  'ADBE Lumetri': 'lumetri',
  'APC Lumetri': 'lumetri',
  'CC Toner': 'toner',
  'CC Color Offset': 'color-offset',
  'ADBE Noise HLS': 'noise-hls',
  'ADBE Threshold RGB': 'threshold-rgb',
  'ADBE Cineon Converter2': 'cineon-converter',

  // ── Generate ──────────────────────────────────────────────────────
  'ADBE Fill': 'fill',
  'ADBE Ramp': 'gradient-ramp',
  'ADBE 4ColorGradient': 'four-color-gradient',
  'ADBE Stroke': 'stroke',
  'ADBE Laser': 'beam',
  'ADBE Lightning 2': 'lightning',
  'ADBE Radio Waves': 'radio-waves',
  'ADBE Lens Flare': 'lens-flare',
  'ADBE Checkerboard': 'checkerboard',
  'ADBE Grid': 'grid',
  'ADBE Cell Pattern': 'cell-pattern',
  'ADBE Vegas': 'vegas',
  'ADBE Write-on': 'write-on',
  'ADBE Scribble Fill': 'scribble',
  'ADBE Circle': 'circle',
  'ADBE Ellipse': 'ellipse',
  'ADBE Fractal': 'fractal',
  'ADBE Fractal Noise': 'fractal-noise',
  'ADBE Turbulent Noise': 'turbulent-noise',
  'ADBE Noise2': 'noise',
  'ADBE Noise': 'noise',
  'ADBE Noise Alpha2': 'noise-alpha',
  'ADBE Grain Add': 'add-grain',
  'ADBE Median': 'median',
  'ADBE Dust & Scratches': 'dust-scratches',
  'CC Light Rays': 'light-rays',
  'CC Light Sweep': 'light-sweep',
  'CC Light Burst 2.5': 'light-burst',
  'CC Star Burst': 'star-burst',
  'CC Snowfall': 'snowfall',
  'CC Rainfall': 'rainfall',
  'CC Drizzle': 'drizzle',
  'CC Particle World': 'particle-systems',
  'CC Bubbles': 'cc-bubbles',

  // ── Distort ───────────────────────────────────────────────────────
  'ADBE Displacement Map': 'displacement-map',
  'ADBE Turbulent Displace': 'turbulent-displace',
  'ADBE Wave Warp': 'wave-warp',
  'ADBE Bulge': 'bulge',
  'ADBE Twirl': 'twirl',
  'ADBE Spherize': 'spherize',
  'ADBE Corner Pin': 'corner-pin',
  'ADBE BezMesh': 'bezier-warp',
  'ADBE Mesh Warp': 'mesh-warp',
  'ADBE Liquify': 'liquify',
  'ADBE Mirror': 'mirror',
  'ADBE Offset': 'offset',
  'ADBE Polar Coordinates': 'polar-coordinates',
  'ADBE Optics Compensation': 'optics-compensation',
  'ADBE Ripple': 'ripple',
  'ADBE Magnify': 'magnify',
  'ADBE Warp': 'warp',
  'ADBE Geometry2': 'transform',
  'ADBE Rolling Shutter': 'rolling-shutter',
  'ADBE Bend It': 'bend',
  'CC Flo Motion': 'flo-motion',
  'CC Lens': 'lens',
  'CC Griddler': 'griddler',
  'CC Page Turn': 'page-turn',
  'CC Split': 'split',
  'CC Slant': 'slant',
  'CC Smear': 'smear',
  'CC Ball Action': 'ball-action',
  'CC Pixel Polly': 'pixel-polly',
  'CC Twister': 'twister',
  'CC Scatterize': 'cc-scatterize',
  'CC Sphere': 'sphere',
  'CC Cylinder': 'cylinder',
  'CC Composite': 'cc-composite',
  'CC Spotlight': 'spotlight',

  // ── Keying & matte ────────────────────────────────────────────────
  Keylight: 'keylight',
  'ADBE Keylight': 'keylight',
  'ADBE Linear Color Key2': 'linear-color-key',
  'ADBE Color Key': 'color-key',
  'ADBE Color Range': 'color-range',
  'ADBE Extract': 'extract',
  'ADBE Spill Suppressor': 'spill-suppressor',
  'ADBE Simple Choker': 'simple-choker',
  'ADBE Matte Choker': 'matte-choker',
  'ADBE Set Matte3': 'set-matte',
  'ADBE Luma Key': 'luma-key',
  'ADBE Color Difference Key': 'color-difference-key',
  'ADBE Minimax': 'minimax',
  'ADBE Alpha Levels2': 'alpha-levels',
  'ADBE Solid Composite': 'solid-composite',
  'ADBE Channel Combiner': 'channel-combiner',
  'ADBE Remove Color Matting': 'remove-color-matting',
  'ADBE Arithmetic': 'arithmetic',

  // ── Transitions ───────────────────────────────────────────────────
  'ADBE Linear Wipe': 'linear-wipe',
  'ADBE Radial Wipe': 'radial-wipe',
  'ADBE Venetian Blinds': 'venetian-blinds',
  'ADBE Gradient Wipe': 'gradient-wipe',
  'ADBE Card Wipe': 'card-wipe',
  'ADBE Card Dance': 'card-dance',
  'ADBE Block Dissolve': 'block-dissolve',
  'ADBE Iris Wipe': 'iris-wipe',
  'CC Glass Wipe': 'glass-wipe',
  'CC Image Wipe': 'image-wipe',
  'CC Scale Wipe': 'scale-wipe',
  'CC Radial ScaleWipe': 'radial-scale-wipe',
  'CC Light Wipe': 'light-wipe',
  'CC Line Sweep': 'line-sweep',
  'CC Grid Wipe': 'grid-wipe',
  'CC Ripple Pulse': 'ripple-pulse',

  // ── Time ──────────────────────────────────────────────────────────
  'ADBE Echo': 'echo',
  'ADBE Posterize Time': 'posterize-time',
  'ADBE Force Motion Blur': 'force-motion-blur',
  'ADBE WideTime': 'wide-time',

  // ── Text & audio ──────────────────────────────────────────────────
  'ADBE NUMBERS2': 'numbers',
  'ADBE Timecode': 'timecode',
  'ADBE AUD SPECTRUM': 'audio-spectrum',
  'ADBE AUD WAVEFORM': 'audio-waveform',
};

/**
 * Effects of AE’s that need a SECOND effect of ours to be complete.
 *
 * Brightness & Contrast is the only one so far and it is the reason this
 * exists: mapping it to `brightness` alone silently discards the contrast the
 * user set, which on a graded shot is the half that shows.
 */
const EFFECT_COMPANIONS: Readonly<Record<string, EffectType>> = {
  'ADBE Brightness & Contrast 2': 'contrast',
};

/**
 * Parameters are matched by LABEL, not by position.
 *
 * AE names an effect's parameters `<effect>-0001`, `<effect>-0002` and so on, in
 * the order the plug-in declared them — which is not the order the Effect
 * Controls panel shows and is not documented anywhere. A table of indices would
 * therefore be a list of guesses, and a wrong guess does not fail loudly: it
 * writes a feather value into a radius and produces an effect that looks like a
 * bug in the renderer.
 *
 * The file carries something better. Every parameter's `pard` record holds the
 * label AE displays for it, and our own effect definitions hold theirs.
 * Matching those — normalised, so "Blur Radius" and "blurRadius" are the same
 * thing — is self-checking in a way an index is not: a mismatch simply finds
 * nothing and the parameter keeps its default.
 *
 * `LABEL_SYNONYMS` closes the gap where the two products genuinely call one
 * thing by two names. It is global rather than per-effect because the
 * disagreements are systematic: AE qualifies a label with the effect's own name
 * ("Glow Radius", "Shadow Color", "Sharpen Amount") where this editor, already
 * inside that effect's panel, does not.
 */
const LABEL_SYNONYMS: Readonly<Record<string, string>> = {
  sharpenamount: 'amount',
  amounttotint: 'amount',
  glowradius: 'radius',
  glowintensity: 'intensity',
  glowthreshold: 'spread',
  shadowcolor: 'color',
  blurlength: 'length',
  transitioncompletion: 'completion',
  mapblackto: 'mapblack',
  mapwhiteto: 'mapwhite',
  level: 'levels',
  bulgeheight: 'height',
  twirlradius: 'radius',
  reflectionangle: 'angle',
  waveheight: 'amplitude',
  wavewidth: 'frequency',
  ripplephase: 'phase',
  displacement: 'amount',
  blurradius: 'blurradius',
};

/**
 * AE point labels whose two components feed a `…X` / `…Y` pair here.
 *
 * A point is ONE parameter in AE and TWO in this editor, so it cannot be
 * matched by label alone. The label names the pair; the splitter appends the
 * axis.
 */
const POINT_TARGETS: Readonly<Record<string, string>> = {
  center: 'center',
  bulgecenter: 'center',
  twirlcenter: 'center',
  centerofsphere: 'center',
  centerofripple: 'center',
  reflectioncenter: 'center',
  shiftcenterto: 'shift',
};

/** Lower-case, letters and digits only — "Blur Radius" and "blurRadius" agree. */
const normalize = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, '');

/** An AE parameter, as the reader found it. */
export interface AeParam {
  matchName: string;
  /** The label from the parameter's `pard`, when it had one. */
  label?: string;
  /** `PF_ParamType` — 6 is a 2-D point. */
  controlType?: number;
}

export interface MappedEffect {
  type: EffectType;
  /** Our parameter key → the AE parameter match name that supplies it. */
  params: Record<string, string>;
  /** Our `…X` / `…Y` pair → the AE point parameter whose components feed it. */
  points: Record<string, { keyX: string; keyY: string; from: string }>;
  /** True when nothing matched and the effect lands at its own defaults. */
  defaultsOnly: boolean;
}

/** AE writes an effect's Nth parameter under `<effect>-000N`. */
export const aeParamName = (effect: string, index: number): string =>
  `${effect}-${String(index).padStart(4, '0')}`;

const defsByType = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

/** `PF_Param_POINT` — the SDK's 2-D point control. */
const CONTROL_TYPE_2D_POINT = 6;

/**
 * The effects this editor should add for one AE effect, in order.
 *
 * `params` is the parameter list the reader found on the effect, labels and
 * all. An empty list is legitimate — some effects carry none this reader can
 * name — and yields an effect at its defaults rather than no effect.
 *
 * An empty RESULT means there is no equivalent here at all; the caller reports
 * that rather than inventing a substitute.
 */
export function mapEffect(matchName: string, params: readonly AeParam[] = []): MappedEffect[] {
  const primary = EFFECT_BY_MATCH_NAME[matchName];
  if (!primary) return [];

  const def = defsByType.get(primary);
  const byKey = new Map((def?.params ?? []).map((p) => [normalize(p.key), p.key]));
  const byLabel = new Map((def?.params ?? []).map((p) => [normalize(p.label), p.key]));

  const matched: Record<string, string> = {};
  const points: MappedEffect['points'] = {};

  for (const param of params) {
    const label = normalize(param.label ?? '');
    if (!label) continue;

    if (param.controlType === CONTROL_TYPE_2D_POINT) {
      const base = POINT_TARGETS[label] ?? label;
      const keyX = byKey.get(`${base}x`);
      const keyY = byKey.get(`${base}y`);
      if (keyX && keyY) points[base] = { keyX, keyY, from: param.matchName };
      continue;
    }

    // Three ways in, most specific first: our own key spelling, our label, and
    // the synonym table for the names the two products disagree on.
    const synonym = LABEL_SYNONYMS[label];
    const key =
      byKey.get(label) ??
      byLabel.get(label) ??
      (synonym ? byKey.get(synonym) ?? byLabel.get(synonym) : undefined);
    if (key) matched[key] = param.matchName;
  }

  const anyMatched = Object.keys(matched).length + Object.keys(points).length > 0;
  const out: MappedEffect[] = [{ type: primary, params: matched, points, defaultsOnly: !anyMatched }];
  const companion = EFFECT_COMPANIONS[matchName];
  if (companion) out.push({ type: companion, params: {}, points: {}, defaultsOnly: true });
  return out;
}

/** Whether this editor has any equivalent for an AE effect. */
export const isEffectKnown = (matchName: string): boolean => matchName in EFFECT_BY_MATCH_NAME;
