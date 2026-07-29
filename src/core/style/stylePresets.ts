/**
 * Style presets — one-click composed looks (glass, neon, soft-UI, chrome text…).
 *
 * Every preset is built ONLY from primitives the renderer already supports:
 * multi-fill (`fillPaints`), gradients, multi-stroke (`strokes`), corner radius,
 * opacity, blend mode and layer styles (drop shadow / outer glow). Several of
 * those — the multi-fill and multi-stroke stacks especially — were fully wired
 * in the engine with no UI to reach them, which is a large part of why the app
 * felt like it had no styling depth.
 *
 * A preset is a plain description, not a special node type: applying one writes
 * ordinary props, so everything stays editable afterwards and animates through
 * the normal keyframe path.
 *
 * Undo caveat: applying a preset is a handful of separate prop writes ending in
 * one `bumpScene`, and history records a debounced whole-document snapshot —
 * so it *usually* undoes in one step because those writes land inside the same
 * debounce window, NOT because it is a single command. An edit made immediately
 * before or after can be swallowed into the same step.
 *
 * `glass` and `frosted` request REAL backdrop blur (`backdropBlur`), which blurs
 * what is BEHIND the layer and shows it through the layer's alpha. A normal blur
 * effect blurs the layer itself, which is why glass was previously only a
 * translucent fill approximation.
 */

import { solidFill, linearFill, radialFill, setNodeFills, type FillPaint, type ColorStop } from '@core/paint/fill';
import { defaultStroke, setNodeStrokes, type Stroke } from '@core/paint/stroke';
import { setLayerStyles, type LayerStyles } from '@core/effects/layerStyles';
import { setNodeBlend, type LayerBlendMode } from '@core/effects/blendMode';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { setNodeSpecular, setNodeShininess } from '@core/scene/material';

export type StylePresetCategory = 'surface' | 'outline' | 'text' | 'depth' | 'material';

export interface StylePreset {
  id: string;
  label: string;
  category: StylePresetCategory;
  /** One line explaining what it does — shown as the swatch tooltip. */
  hint: string;
  /** Bottom→top fill stack. */
  fills: (accent: string) => FillPaint[];
  /** Bottom→top stroke stack (empty = no outline). */
  strokes?: (accent: string) => Stroke[];
  styles?: (accent: string) => LayerStyles;
  cornerRadius?: number;
  opacity?: number;
  blend?: LayerBlendMode;
  /** Frosted-glass backdrop blur radius (comp px). */
  backdropBlur?: number;
  /**
   * 3D material response — how the lit shader treats the surface.
   *
   * These arrived as a SIXTH hard-coded preset grid living in the Transform
   * panel ("Pro 3D Material Presets"), which also wrote the layer's fill and so
   * silently discarded whatever colour the user had chosen, from a panel that
   * does not own fill. Folding them in here puts every preset behind one
   * registry and one apply path.
   */
  specular?: number;
  shininess?: number;
}

function stops(...list: Array<[number, string]>): ColorStop[] {
  return list.map(([offset, color], i) => ({ id: `sp_${i}`, offset, color }));
}

function grad(angle: number, ...list: Array<[number, string]>): FillPaint {
  return { ...linearFill(), angle, stops: stops(...list) };
}

/** Hex + alpha → 8-digit hex, which the paint layer already understands. */
function alpha(hex: string, a: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
  return `${hex}${byte}`;
}

function stroke(color: string, width: number, extra: Partial<Stroke> = {}): Stroke {
  return { ...defaultStroke(color), width, ...extra };
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  // ── Surfaces ────────────────────────────────────────────────────
  {
    id: 'glass',
    label: 'Glass',
    category: 'surface',
    hint: 'Frosted acrylic — actually blurs the artwork behind it',
    cornerRadius: 24,
    backdropBlur: 18,
    fills: () => [
      solidFill(alpha('#ffffff', 0.10)),
      grad(160, [0, alpha('#ffffff', 0.28)], [0.45, alpha('#ffffff', 0.04)], [1, alpha('#ffffff', 0.0)]),
    ],
    strokes: () => [stroke(alpha('#ffffff', 0.45), 1.5)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.35, distance: 18, angle: 90, blur: 36 },
    }),
  },
  {
    id: 'soft-ui',
    label: 'Soft UI',
    category: 'surface',
    hint: 'Neumorphic pad — matched light and dark shadows, almost no outline',
    cornerRadius: 28,
    backdropBlur: 6,
    fills: (a) => [grad(145, [0, alpha('#ffffff', 0.14)], [1, alpha(a, 0.06)])],
    strokes: () => [stroke(alpha('#ffffff', 0.16), 1)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.55, distance: 14, angle: 115, blur: 26 },
      outerGlow: { enabled: true, color: '#ffffff', opacity: 0.20, size: 18 },
    }),
  },
  {
    id: 'input-field',
    label: 'Input Field',
    category: 'surface',
    hint: 'Recessed control surface with a crisp border — for form and UI mockups',
    cornerRadius: 12,
    fills: () => [solidFill(alpha('#000000', 0.35))],
    strokes: () => [stroke(alpha('#ffffff', 0.22), 1.5)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.45, distance: 2, angle: 90, blur: 6 },
    }),
  },
  {
    id: 'gradient-card',
    label: 'Gradient Card',
    category: 'surface',
    hint: 'Saturated two-tone card with a lifted shadow',
    cornerRadius: 20,
    fills: (a) => [grad(135, [0, a], [1, '#7b2ff7'])],
    styles: (a) => ({
      dropShadow: { enabled: true, color: a, opacity: 0.40, distance: 20, angle: 90, blur: 40 },
    }),
  },

  // ── Outlines ────────────────────────────────────────────────────
  {
    id: 'neon',
    label: 'Neon',
    category: 'outline',
    hint: 'Hollow shape with a saturated glowing rim',
    fills: () => [solidFill('#00000000')],
    strokes: (a) => [stroke(a, 3)],
    styles: (a) => ({
      outerGlow: { enabled: true, color: a, opacity: 1, size: 26 },
    }),
    blend: 'screen',
  },
  {
    id: 'outline',
    label: 'Outline',
    category: 'outline',
    hint: 'Flat hollow shape — no fill, single clean stroke',
    fills: () => [solidFill('#00000000')],
    strokes: (a) => [stroke(a, 2)],
  },
  {
    id: 'sticker',
    label: 'Sticker',
    category: 'outline',
    hint: 'Solid fill inside a thick white keyline, with a contact shadow',
    cornerRadius: 16,
    fills: (a) => [solidFill(a)],
    // Two strokes: the white keyline over a slightly wider dark edge.
    strokes: () => [stroke('#00000055', 14), stroke('#ffffff', 8)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.45, distance: 10, angle: 90, blur: 12 },
    }),
  },

  // ── Text ────────────────────────────────────────────────────────
  {
    id: 'chrome-text',
    label: 'Chrome',
    category: 'text',
    hint: 'Metallic vertical ramp with a dark edge — classic title treatment',
    fills: () => [grad(90,
      [0, '#ffffff'], [0.35, '#c9d4e0'], [0.5, '#7d8794'], [0.52, '#e8eef5'], [1, '#9aa7b4'],
    )],
    strokes: () => [stroke('#1b1f24', 2)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.5, distance: 4, angle: 90, blur: 6 },
    }),
  },
  {
    id: 'gradient-text',
    label: 'Gradient Text',
    category: 'text',
    hint: 'Accent-to-white ramp across the glyphs',
    fills: (a) => [grad(90, [0, '#ffffff'], [1, a])],
  },
  {
    id: 'glow-text',
    label: 'Glow Text',
    category: 'text',
    hint: 'Bright glyphs with a coloured bloom — reads on dark backgrounds',
    fills: () => [solidFill('#ffffff')],
    styles: (a) => ({
      outerGlow: { enabled: true, color: a, opacity: 1, size: 22 },
    }),
  },

  // ── Depth ───────────────────────────────────────────────────────
  {
    id: 'long-shadow',
    label: 'Long Shadow',
    category: 'depth',
    hint: 'Flat-design cast shadow raking off at 45°',
    fills: (a) => [solidFill(a)],
    styles: () => ({
      dropShadow: { enabled: true, color: '#000000', opacity: 0.35, distance: 120, angle: 45, blur: 0 },
    }),
  },
  {
    id: 'spotlight',
    label: 'Spotlight',
    category: 'depth',
    hint: 'Radial falloff from a hot centre — good for backdrops and vignettes',
    fills: (a) => [{ ...radialFill(), cx: 0.5, cy: 0.4, radius: 0.7, stops: stops([0, a], [1, alpha(a, 0)]) }],
  },

  // ── 3D materials ────────────────────────────────────────────────
  // Colour AND light response together: a material is a look, so it states the
  // fill like every other preset here rather than mutating it from elsewhere.
  {
    id: 'steel', label: 'Steel', category: 'material',
    hint: 'Brushed metal — cool grey with a tight highlight',
    fills: () => [solidFill('#8a99a8')],
    specular: 85, shininess: 64,
  },
  {
    id: 'gold', label: 'Gold', category: 'material',
    hint: 'Warm metal with a broad, bright highlight',
    fills: () => [solidFill('#ffd700')],
    specular: 95, shininess: 80,
  },
  {
    id: 'plastic', label: 'Plastic', category: 'material',
    hint: 'Matte body with a soft highlight — keeps the accent colour',
    fills: (accent) => [solidFill(accent)],
    specular: 30, shininess: 24,
  },
  {
    id: 'glass-3d', label: 'Glass', category: 'material',
    hint: 'Pale and highly polished — sharpest highlight',
    fills: () => [solidFill('#e0f7fa')],
    specular: 95, shininess: 96, opacity: 70,
  },
  {
    id: 'neon-3d', label: 'Neon', category: 'material',
    hint: 'Saturated and hot — the most concentrated highlight',
    fills: () => [solidFill('#ff007f')],
    specular: 100, shininess: 120,
  },
  {
    id: 'obsidian', label: 'Obsidian', category: 'material',
    hint: 'Near-black with a hard, narrow highlight',
    fills: () => [solidFill('#1a1a1e')],
    specular: 50, shininess: 70,
  },
];

export function stylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}

/**
 * Apply a preset to a node. `accent` lets one preset serve any palette — it is
 * the layer's current fill colour by default, so applying a look keeps the
 * colour the user already chose.
 */
export function applyStylePreset(nodeId: string, presetId: string, accent?: string): boolean {
  const preset = stylePreset(presetId);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!preset || !node) return false;

  const styleComp = node.components.find((c) => c.type === 'Style' || c.type === 'Text');
  const current = typeof styleComp?.props.fill === 'string' ? (styleComp.props.fill as string) : '#2b7eff';
  const a = accent ?? (current.startsWith('#') ? current.slice(0, 7) : '#2b7eff');

  // Every axis is written unconditionally, including the ones this preset does
  // not use. A preset states a COMPLETE look; leaving an axis alone means the
  // previous preset bleeds through — applying Neon (which blends 'screen') and
  // then Sticker left Sticker blending 'screen', which is not the look either
  // preset describes.
  setNodeFills(nodeId, preset.fills(a));
  setNodeStrokes(nodeId, preset.strokes ? preset.strokes(a) : []);
  setLayerStyles(nodeId, preset.styles ? preset.styles(a) : {});
  setNodeBlend(nodeId, preset.blend ?? 'normal');

  if (styleComp) {
    if (preset.cornerRadius !== undefined) {
      defaultSceneGraph.writeProp(nodeId, styleComp.id, 'cornerRadius', preset.cornerRadius);
    }
    if (preset.opacity !== undefined) {
      defaultSceneGraph.writeProp(nodeId, styleComp.id, 'opacity', preset.opacity);
    }
    // Written unconditionally — a preset states a COMPLETE look, so switching
    // away from Glass must clear the frost rather than leave it behind.
    defaultSceneGraph.writeProp(nodeId, styleComp.id, 'backdropBlur', preset.backdropBlur);
  }

  // Material response. Only touched by presets that state one, so applying a
  // surface look does not flatten a 3D layer's shading.
  if (preset.specular !== undefined) setNodeSpecular(nodeId, preset.specular);
  if (preset.shininess !== undefined) setNodeShininess(nodeId, preset.shininess);

  bumpScene();
  return true;
}
