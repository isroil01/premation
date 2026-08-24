/**
 * Which browser folder each effect lives in.
 *
 * Its own module, not a constant inside the Effects panel, because the panel
 * stopped being its only reader: Quick Apply in the command palette files a
 * hit under the same folder name the panel shows, and a palette that imported
 * a React panel to learn a string would drag the whole panel into every
 * palette test.
 */

import type { EffectType } from '@core/effects/effects';

/**
 * Browser folders, following After Effects' own grouping so the names are the
 * ones users already know.
 *
 * A `Record` keyed by `EffectType`, NOT an if-chain with a catch-all: the
 * previous version routed two named lists and dropped EVERYTHING else into a
 * single "Stylize, Keying & Utility" bucket — 24 of the 38 effects in one
 * accordion, which is the folder users open most. Typing it this way means a
 * new effect type is a compile error until it is filed somewhere.
 */
export const EFFECT_CATEGORY: Record<EffectType, string> = {
  // Blur & Sharpen
  blur: 'Blur & Sharpen',
  sharpen: 'Blur & Sharpen',
  'directional-blur': 'Blur & Sharpen',
  'gaussian-blur': 'Blur & Sharpen',
  'fast-box-blur': 'Blur & Sharpen',
  'radial-blur': 'Blur & Sharpen',
  'compound-blur': 'Blur & Sharpen',
  mosaic: 'Stylize',
  'find-edges': 'Stylize',
  'roughen-edges': 'Stylize',
  exposure: 'Color Correction',
  vibrance: 'Color Correction',
  colorama: 'Color Correction',
  lumetri: 'Color Correction',
  'selective-color': 'Color Correction',
  'shadow-highlight': 'Color Correction',
  /*
    AE files Apply Color LUT under Utility. There is no Utility folder here, and
    a one-item folder is worse than a slightly wrong one: this IS a colour tool
    and Color Correction is where someone looks for it. Revisit if the rest of
    AE's Utility family (Cineon Converter, Grow Bounds, HDR Compander) lands.
  */
  'apply-color-lut': 'Color Correction',
  'set-matte': 'Keying',
  'simple-choker': 'Keying',
  'linear-color-key': 'Keying',
  'shift-channels': 'Keying',
  'venetian-blinds': 'Transition',
  'gradient-wipe': 'Transition',
  'card-wipe': 'Transition',
  'lens-flare': 'Generate',
  numbers: 'Generate',
  timecode: 'Generate',
  'audio-spectrum': 'Generate',
  // Color Correction
  brightness: 'Color Correction',
  contrast: 'Color Correction',
  saturate: 'Color Correction',
  grayscale: 'Color Correction',
  sepia: 'Color Correction',
  'hue-rotate': 'Color Correction',
  'hue-saturation': 'Color Correction',
  invert: 'Color Correction',
  levels: 'Color Correction',
  curves: 'Color Correction',
  posterize: 'Color Correction',
  tint: 'Color Correction',
  'channel-mixer': 'Color Correction',
  // Generate
  checkerboard: 'Generate',
  grid: 'Generate',
  'cell-pattern': 'Generate',
  vegas: 'Generate',
  // Noise — filed under Stylize beside the existing `noise`, which is where AE
  // puts Add Grain and Median too.
  'turbulent-noise': 'Stylize',
  'add-grain': 'Stylize',
  median: 'Stylize',
  fill: 'Generate',
  stroke: 'Generate',
  beam: 'Generate',
  'four-color-gradient': 'Generate',
  'gradient-ramp': 'Generate',
  'fractal-noise': 'Generate',
  // Stylize (incl. the Photoshop-style layer styles)
  glow: 'Stylize',
  'drop-shadow': 'Stylize',
  'inner-shadow': 'Stylize',
  'inner-glow': 'Stylize',
  satin: 'Stylize',
  bevel: 'Stylize',
  noise: 'Stylize',
  // Distort
  transform: 'Distort',
  bulge: 'Distort',
  twirl: 'Distort',
  spherize: 'Distort',
  'corner-pin': 'Distort',
  'bezier-warp': 'Distort',
  'wave-warp': 'Distort',
  'turbulent-displace': 'Distort',
  'curl-noise': 'Distort',
  'displacement-map': 'Distort',
  'motion-tile': 'Distort',
  bend: 'Distort',
  // Keying / Time / Transition
  keylight: 'Keying',
  echo: 'Time',
  'posterize-time': 'Time',
  'wide-time': 'Time',
  'force-motion-blur': 'Time',
  // Perspective — a new folder. AE files bevels and the 3D-surface effects
  // here rather than under Stylize, which is where a user looks for them.
  'bevel-alpha': 'Perspective',
  'bevel-edges': 'Perspective',
  spotlight: 'Perspective',
  sphere: 'Perspective',
  cylinder: 'Perspective',
  // Channel — a new folder. AE files the per-channel maths here rather than
  // under Color Correction, which is about grading rather than arithmetic.
  arithmetic: 'Channel',
  'linear-wipe': 'Transition',
  // ── Round three ──
  // AE's own folder for each, with one deliberate exception: Minimax is a
  // Channel effect in AE, and there is no Channel folder here. It is filed under
  // Keying because that is where its work is — growing and shrinking a matte —
  // and a one-item folder is worse than a well-reasoned neighbour, the same call
  // already made above for Apply Color LUT.
  'color-balance': 'Color Correction',
  'gamma-pedestal-gain': 'Color Correction',
  'photo-filter': 'Color Correction',
  'black-and-white': 'Color Correction',
  tritone: 'Color Correction',
  threshold: 'Stylize',
  'polar-coordinates': 'Distort',
  'optics-compensation': 'Distort',
  'mesh-warp': 'Distort',
  liquify: 'Distort',
  mirror: 'Distort',
  offset: 'Distort',
  emboss: 'Stylize',
  scatter: 'Stylize',
  'radial-wipe': 'Transition',
  'block-dissolve': 'Transition',
  'luma-key': 'Keying',
  minimax: 'Keying',
  'channel-blur': 'Blur & Sharpen',
  'unsharp-mask': 'Blur & Sharpen',

  // ── Round four ──
  //
  // This map is `Record<EffectType, string>`, so every entry below was forced
  // by the compiler the moment its type joined the union — which is exactly the
  // property `effectRegistryComplete.test.ts` leans on to enumerate the union
  // without anyone maintaining a second list.
  //
  // The four Channel effects follow the Minimax precedent noted above: AE files
  // them under Channel, there is still no Channel folder, and their work is
  // matte work, so they sit with Keying rather than earning a folder of four.
  'bilateral-blur': 'Blur & Sharpen',
  'smart-blur': 'Blur & Sharpen',
  'camera-lens-blur': 'Blur & Sharpen',
  ripple: 'Distort',
  magnify: 'Distort',
  warp: 'Distort',
  'page-turn': 'Distort',
  split: 'Distort',
  slant: 'Distort',
  smear: 'Distort',
  'rolling-shutter': 'Distort',
  // AE files this under Perspective. One effect does not earn a folder, and its
  // neighbours here are the other shadow/relief effects.
  'radial-shadow': 'Stylize',
  circle: 'Generate',
  ellipse: 'Generate',
  'radio-waves': 'Generate',
  lightning: 'Generate',
  'light-rays': 'Generate',
  'light-sweep': 'Generate',
  'audio-waveform': 'Generate',
  cartoon: 'Stylize',
  'brush-strokes': 'Stylize',
  'strobe-light': 'Stylize',
  'color-emboss': 'Stylize',
  halftone: 'Stylize',
  kaleidoscope: 'Stylize',
  vignette: 'Stylize',
  'burn-film': 'Stylize',
  equalize: 'Color Correction',
  'auto-levels': 'Color Correction',
  'auto-contrast': 'Color Correction',
  'auto-color': 'Color Correction',
  'change-color': 'Color Correction',
  'change-to-color': 'Color Correction',
  'leave-color': 'Color Correction',
  toner: 'Color Correction',
  'color-key': 'Keying',
  'color-range': 'Keying',
  extract: 'Keying',
  'spill-suppressor': 'Keying',
  'matte-choker': 'Keying',
  'alpha-levels': 'Keying',
  'solid-composite': 'Keying',
  'channel-combiner': 'Keying',
  'remove-color-matting': 'Keying',
  'iris-wipe': 'Transition',
  'light-wipe': 'Transition',
  'line-sweep': 'Transition',
  'grid-wipe': 'Transition',
  'dust-scratches': 'Stylize',
  'noise-alpha': 'Stylize',
  // ── Round five ── AE/Cycore's own folders, with the standing exceptions:
  // no Simulation folder exists, so the weather generators (which DRAW, like
  // Lens Flare) sit in Generate where a user hunting "snow" will look.
  'star-burst': 'Generate',
  snowfall: 'Generate',
  rainfall: 'Generate',
  'write-on': 'Generate',
  'light-burst': 'Generate',
  glass: 'Stylize',
  texturize: 'Stylize',
  threads: 'Stylize',
  'chromatic-aberration': 'Stylize',
  'hex-tile': 'Stylize',
  'vector-blur': 'Blur & Sharpen',
  'flo-motion': 'Distort',
  lens: 'Distort',
  griddler: 'Distort',
  'ball-action': 'Distort',
  drizzle: 'Distort',
  jaws: 'Transition',
  'pixel-polly': 'Transition',
  twister: 'Transition',
  'card-dance': 'Transition',
  // ── Round six ──
  unmult: 'Keying',
  'cc-composite': 'Keying',
  'cc-repetile': 'Stylize',
  'cc-scatterize': 'Stylize',
  'radial-fast-blur': 'Blur & Sharpen',
  'cross-blur': 'Blur & Sharpen',
  'scale-wipe': 'Transition',
  plastic: 'Stylize',
};
