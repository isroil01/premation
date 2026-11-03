/**
 * Write tools — the editing vocabulary.
 *
 * Two rules shaped this list:
 *
 * 1. **Batch, don't chatter.** `set_keyframes` takes an array because a single
 *    gesture ("fade in and rise") is a dozen keyframes; one call per keyframe
 *    would burn the step budget and cost a round-trip each.
 * 2. **Composition time, always.** Callers pass comp seconds; the handler
 *    converts to layer time. Splitting that responsibility is what let a value
 *    and its easing land at two different times in the old op path.
 */

import type { AiToolDef, JsonSchema } from '../types';

/** Shared enum — the engine's real EasingKind union. */
const EASING_ENUM = [
  'linear',
  'step',
  'ease',
  'easeIn',
  'easeOut',
  'easeInOut',
  'bezier',
  'hold',
  'autoBezier',
  'continuousBezier',
] as const;

const PROP_HINT =
  'Property path. Transform: x, y, rotation, scale, scaleX, scaleY, opacity. ' +
  '3D (needs the layer\'s 3D switch): z, rotationX, rotationY. ' +
  'Camera (on a camera layer, no 3D switch needed): x, y, z (dolly), focalLength (zoom), ' +
  'orbitYaw, orbitPitch (rotate around the look-at point), poiX, poiY, poiZ (look-at target), ' +
  'dofStrength, focusDistance, dofAperture (depth of field). ' +
  'Effects: effect.<effectId>. Text animators: ta.<index>.<param>. Time remap: timeRemap. ' +
  'Paint strokes (ids from paint_strokes): paint.<strokeId>.<param> — start, end (write-on, 0..100), diameter, angle, ' +
  'hardness, roundness, spacing, opacity, flow, positionX, positionY, scale, rotation, color_r/g/b/a. ' +
  'Values are numbers only — opacity is 0..100, rotation is degrees, scale is a multiplier (1 = 100%).';

// ── Structure ─────────────────────────────────────────────────────

/**
 * A caller-supplied handle for a layer that does not exist yet.
 *
 * Without this, a batch of calls cannot reference what it just created: the
 * engine assigns the real id at execution time, so `create_layer` followed by
 * `update_layer` needs a round-trip through the model just to learn the id it is
 * about to use. That is fatal for a library emitter, which produces its whole
 * `ToolCall[]` up front with no model in the loop at all.
 *
 * An alias is local to one run. The handler records `alias → real id` and every
 * later call resolves `nodeId` through that map before touching the scene, so
 * the model may also use one if it finds it convenient.
 */
export const ALIAS_PROP = {
  type: 'string',
  description:
    'Optional handle to refer to this layer in LATER calls in the same batch, before the engine ' +
    'has assigned it a real id. Must be unique within the run.',
} as const;

/**
 * The layer's first stroke (Contents ▸ Stroke 1; on text, Character ▸ Stroke),
 * as create_layer and update_layer both take it. Colour / width / opacity
 * apply to text too; everything from the cap down is AE's shape-layer Stroke
 * group (Line Cap, Line Join, Miter Limit, Dashes, Taper, Wave), which type's
 * Character stroke does not have.
 */
export const STROKE_PROPS = {
  stroke: {
    type: 'string',
    description:
      'Stroke colour, hex. Shape and solid layers (adds a stroke when the layer has none) and text layers ' +
      '(the Character stroke — with fill: "none" an outline-only title). ' +
      'Combine with set_trim_path for a line that draws itself on.',
  },
  strokeWidth: { type: 'number', minimum: 0, description: 'Stroke width in layer px. 0 draws no stroke.' },
  strokeOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Opacity of the stroke only, 0..100.' },
  strokeCap: {
    type: 'string',
    enum: ['butt', 'round', 'square'],
    description: 'Line Cap (shape/solid strokes): butt (flat at the path end), round, square (extends half a width). Round caps make dashes into dots.',
  },
  strokeJoin: {
    type: 'string',
    enum: ['miter', 'round', 'bevel'],
    description: 'Line Join (shape/solid strokes): miter (sharp corners), round, bevel (cut corners).',
  },
  miterLimit: { type: 'number', minimum: 1, description: 'Miter Limit for join "miter": a corner sharper than this ratio (miter length / width) is bevelled. Default 4.' },
  strokeDash: {
    type: 'array',
    maxItems: 6,
    items: { type: 'number', minimum: 0 },
    description:
      'Dash pattern in layer px, [dash, gap, dash, gap, …] (AE Dashes, up to 3 pairs). [] = solid. ' +
      'Animate strokeDashOffset (set_keyframes) for a marching border; a dash with round caps and gap > width is a dotted line.',
  },
  strokeDashOffset: { type: 'number', description: 'Dash Offset: how far the pattern is slid along the path, px.' },
  strokeTaper: {
    type: 'object',
    additionalProperties: false,
    description:
      'AE Taper: the stroke thins to a point at its ends. Lengths are % of the path (0..100); widths are % of the stroke width at the very ' +
      'end (0 = a point, default 0); ease is −1..1 (negative = pointy/concave, positive = round/convex). ' +
      '{ startLength: 0, endLength: 0 } removes the taper.',
    properties: {
      startLength: { type: 'number', minimum: 0, maximum: 100 },
      endLength: { type: 'number', minimum: 0, maximum: 100 },
      startWidth: { type: 'number', minimum: 0, maximum: 100 },
      endWidth: { type: 'number', minimum: 0, maximum: 100 },
      startEase: { type: 'number', minimum: -1, maximum: 1 },
      endEase: { type: 'number', minimum: -1, maximum: 1 },
    },
  },
  strokeWave: {
    type: 'object',
    additionalProperties: false,
    description:
      'AE Wave: a sine displacement of the stroke along its path. amount = peak displacement px, wavelength = period in px of path ' +
      '(or whole cycles with units "cycles" — the only way a wave meets itself on a closed outline), phase in degrees (keyframe ' +
      'strokeWavePhase to make it travel). amount 0 removes the wave.',
    properties: {
      amount: { type: 'number', minimum: 0 },
      wavelength: { type: 'number', minimum: 0 },
      phase: { type: 'number' },
      units: { type: 'string', enum: ['pixels', 'cycles'] },
    },
  },
} as const;

export const createLayerDef: AiToolDef = {
  name: 'create_layer',
  kind: 'write',
  description:
    'Create a layer and return its id. Use that id — or the `id` handle you passed — for ' +
    'subsequent calls.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name'],
    properties: {
      id: ALIAS_PROP,
      kind: {
        type: 'string',
        enum: ['shape', 'text', 'solid', 'null', 'group', 'camera', 'light', 'adjustment', 'particle', 'primitive', 'plugin'],
      },
      layerType: {
        type: 'string',
        description:
          'For kind=plugin: the plugin layer type "<pluginId>:<id>" (list_capabilities kinds → pluginLayerTypes). ' +
          'The layer is drawn by that plugin and fills the comp; its properties are its effect "layer" ' +
          '(update_effect_param / set_keyframes on effects/layer/<param>).',
      },
      primitive: {
        type: 'string',
        enum: ['sphere', 'cylinder', 'cone', 'torus', 'capsule', 'box', 'cube', 'plane'],
        description:
          'For kind=primitive: a real 3D mesh (3D on, lit, casting shadows) — a planet, a pill, a ' +
          'ring, a pedestal, a product block. Size it with radius (sphere, capsule, cylinder/cone ' +
          'base, torus ring), height (cylinder, cone, capsule, box), width/depth (box) and tube ' +
          '(torus thickness). Material via update_layer (shading "pbr", metal, roughness).',
      },
      radius: { type: 'number', minimum: 1, description: 'kind=primitive: radius in px (default 100).' },
      depth: { type: 'number', minimum: 1, description: 'kind=primitive, box: depth in px.' },
      tube: { type: 'number', minimum: 1, description: 'kind=primitive, torus: tube thickness in px.' },
      name: { type: 'string', description: 'Layer name. Make it descriptive — you will refer to it later.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
      width: { type: 'number', description: 'Layer width in px. REQUIRED for shape/solid — GPU renderer needs explicit size.' },
      height: { type: 'number', description: 'Layer height in px. REQUIRED for shape/solid — GPU renderer needs explicit size.' },
      text: { type: 'string', description: 'For kind=text: the content.' },
      shape: {
        type: 'string',
        enum: ['rect', 'ellipse', 'line', 'star', 'polygon'],
        description:
          'For kind=shape. "polygon" and "star" create a PARAMETRIC polystar (the same layer the ' +
          'Polygon / Star tools draw) — size it with outerRadius, not width/height.',
      },
      // Polystar-only. They are accepted on any call (the schema has no
      // conditionals) and ignored unless shape is polygon/star; the handler's
      // reply states the values it actually used, so a dropped one is visible.
      points: { type: 'number', minimum: 3, maximum: 64, description: 'shape=polygon|star: number of corners / spikes. Default 6 for polygon, 5 for star. A triangle is polygon with points 3.' },
      outerRadius: { type: 'number', minimum: 1, description: 'shape=polygon|star: corner / spike radius in px. Defaults to half of width/height, else 100.' },
      innerRadius: { type: 'number', minimum: 0, description: 'shape=star: valley radius in px. Defaults to half the outer radius. Smaller = spikier.' },
      roundness: { type: 'number', minimum: -100, maximum: 100, description: 'shape=polygon|star: segment bulge, percent. 0 = sharp corners, positive rounds them, negative curls them inward.' },
      fill: { type: 'string', description: 'Colour: hex (#2b7eff, #2b7eff80) or CSS (rgba(), named). "none" = no fill — a shape that is only its stroke.' },
      parent: { type: 'string', description: 'Parent layer id.' },
      // The outline, in the same call — a ring, a dashed border, a tapered
      // calligraphic line is one create_layer, not create + update.
      ...STROKE_PROPS,
    },
  },
};

export const deleteLayerDef: AiToolDef = {
  name: 'delete_layer',
  kind: 'write',
  description: 'Delete layers and their descendants.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeIds'],
    properties: {
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    },
  },
};

export const reparentLayerDef: AiToolDef = {
  name: 'reparent_layer',
  kind: 'write',
  description: 'Re-parent a layer. The layer keeps its world position.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      parentId: { type: 'string', description: 'Omit or pass null to move to the top level.' },
    },
  },
};

export const reorderLayerDef: AiToolDef = {
  name: 'reorder_layer',
  kind: 'write',
  description:
    'Move layers in the stack (AE Layer ▸ Arrange): to the top or bottom of their composition, or just ' +
    'above / below another layer. New layers are always created on top — use this instead of rebuilding a ' +
    'scene to put a silhouette behind a foreground or a backdrop under everything. Layers moved together keep ' +
    'their relative order and must share a parent.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeIds', 'position'],
    properties: {
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
      position: { type: 'string', enum: ['top', 'bottom', 'above', 'below'] },
      relativeTo: { type: 'string', description: 'position above / below: the layer to sit next to.' },
    },
  },
};

export const updateLayerDef: AiToolDef = {
  name: 'update_layer',
  kind: 'write',
  description:
    'Set static (non-animated) layer properties: name, visibility, lock, text content, colour, ' +
    'base transform. To animate a property use set_keyframes instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      name: { type: 'string' },
      visible: { type: 'boolean' },
      locked: { type: 'boolean' },
      text: { type: 'string' },
      fontSize: { type: 'number', minimum: 1 },
      fontWeight: { type: 'number' },
      fontFamily: { type: 'string' },
      tracking: {
        type: 'number',
        description:
          'Tracking in After Effects units (1/1000 em: 50 = 0.05 em, scales with the font size). NEGATIVE for ' +
          'display sizes (−20 to −40) and POSITIVE for small text (+20 to +60). A font\'s default spacing is drawn ' +
          'for body copy, so display type at 0 looks loose and unresolved — this is the single biggest "looks ' +
          'typeset" lever there is, and leaving it at 0 on a headline is the most common typographic tell.',
      },
      letterSpacing: {
        type: 'number',
        description: 'Extra letter spacing in px (keyframeable). Prefer `tracking`, which keeps its look across sizes.',
      },
      fontStyle: { type: 'string', enum: ['normal', 'italic'], description: 'The family\'s italic face (synthesized when it has none).' },
      lineHeight: {
        type: 'number',
        description:
          'Multiplier, not px. Display type sits TIGHT (0.92–1.05 — at 96px the natural gap is ' +
          'already wider than the eye wants); body copy needs 1.4–1.6. One line-height across both ' +
          'is why generated type reads as a single block.',
      },
      align: {
        type: 'string',
        enum: ['left', 'center', 'right', 'justify', 'justify-left', 'justify-center', 'justify-right', 'justify-all'],
        description:
          'Line alignment INSIDE a paragraph box (boxWidth > 0); `justify` = justified with the last line left ' +
          '(AE Justify Last Left), justify-all stretches every line. Point text (no box) is centred on x / y ' +
          'whatever this says unless textAnchor is "alignment".',
      },
      textAnchor: {
        type: 'string',
        enum: ['center', 'alignment'],
        description:
          'Point text: "alignment" puts the anchor at the alignment edge, as After Effects does — a left-aligned ' +
          'title starts at x and grows to the right (typewriter reveals, counters). Default "center": centred on x.',
      },
      boxWidth: {
        type: 'number',
        minimum: 0,
        description:
          'Text: paragraph box width in px (AE paragraph text). The text wraps inside it and `align` places each ' +
          'line; the box is centred on x / y. 0 = point text (one line per paragraph, no wrapping).',
      },
      boxHeight: { type: 'number', minimum: 0, description: 'Text: paragraph box height in px (0 = grows with the text).' },
      orientation: {
        type: 'string',
        enum: ['horizontal', 'vertical'],
        description: 'Text: vertical = tategaki (CJK upright in columns read right to left, punctuation in vertical forms).',
      },
      direction: { type: 'string', enum: ['ltr', 'rtl'], description: 'Text: paragraph direction (rtl for Arabic / Hebrew paragraphs).' },
      language: {
        type: 'string',
        enum: ['auto', 'en', 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'ar', 'he', 'hi', 'th', 'vi', 'ru'],
        description:
          'Text: the language the text is set in (default auto = from its script). Han characters take Japanese, ' +
          'Simplified or Traditional Chinese glyph forms and fallback fonts from it: set ja for kanji, zh-Hans / zh-Hant for hanzi.',
      },
      fill: { type: 'string', description: 'Colour: hex or CSS (rgba(), named). "none" = no fill (a stroke-only shape).' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number', description: 'Layer width in px. Required for GPU renderer to display the layer.' },
      height: { type: 'number', description: 'Layer height in px. Required for GPU renderer to display the layer.' },
      rotation: { type: 'number', description: 'Degrees.' },
      z: {
        type: 'number',
        description:
          'Depth, px. Needs the 3D switch. Positive is AWAY from the camera. Setting it here is a ' +
          'static placement — use set_keyframes to animate it. Separating layers in z is what gives ' +
          'a camera move parallax; with everything at 0 a push reads as a scale.',
      },
      rotationX: { type: 'number', description: 'Degrees about the horizontal axis. Needs the 3D switch.' },
      rotationY: { type: 'number', description: 'Degrees about the vertical axis. Needs the 3D switch.' },
      // ── Camera layers ──
      // These were animatable via set_keyframes (they are in CAMERA_PROPS) but
      // could not be SET. So every camera a library emitted ran on the engine's
      // default lens: `emitCamera` chose one and its `update_layer` call was
      // rejected for an unknown property, silently, on all six camera
      // techniques. A slow contemplative push (long lens, 2.6x frame) and a
      // crash zoom (wide, 0.5x) rendered identically.
      focalLength: {
        type: 'number',
        minimum: 1,
        description:
          'Camera layers only. Distance to the projection plane in px, so the ratio to the frame IS ' +
          'the focal length: ~0.5x frame is very wide (strong perspective, edges stretch), ~0.85x ' +
          'normal, ~1.5x portrait, ~2.6x long (depth collapses, planes stack). This is the first ' +
          'decision a camera operator makes and it changes a shot more than the move does.',
      },
      orbitYaw: { type: 'number', description: 'Camera layers only. Degrees around the look-at point, horizontally.' },
      orbitPitch: { type: 'number', description: 'Camera layers only. Degrees around the look-at point, vertically.' },
      poiX: { type: 'number', description: 'Camera layers only. Look-at target X in comp px.' },
      poiY: { type: 'number', description: 'Camera layers only. Look-at target Y in comp px.' },
      poiZ: { type: 'number', description: 'Camera layers only. Look-at target Z in comp px.' },
      dofStrength: { type: 'number', minimum: 0, description: 'Camera layers only. Max defocus blur, px. 0 = depth of field off.' },
      focusDistance: { type: 'number', minimum: 0, description: 'Camera layers only. In-focus distance from the camera, px.' },
      dofAperture: { type: 'number', minimum: 0, description: 'Camera layers only. How fast defocus becomes blur. Wider = shallower depth of field.' },
      scaleX: { type: 'number' },
      scaleY: { type: 'number' },
      opacity: { type: 'number', minimum: 0, maximum: 100 },
      // ── Transform extras ──
      // All four are tracks of the layer's Transform the engine addresses as
      // numbers (STATIC_PROPERTY_META), so they set like x / y. A handler that
      // finds the catalog does not address one on this layer refuses it.
      anchorX: {
        type: 'number',
        description:
          'Anchor point X, layer-local px from the layer centre. Rotation and scale pivot here: put it ' +
          'on the left edge (−width/2) for a bar that grows to the right, or on the baseline for type ' +
          'that scales up from the line it sits on.',
      },
      anchorY: { type: 'number', description: 'Anchor point Y, layer-local px from the layer centre.' },
      skew: { type: 'number', description: 'Skew, degrees. A slant that settles to 0 reads as speed.' },
      skewAxis: { type: 'number', description: 'Direction the skew acts along, degrees.' },
      fillOpacity: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description:
          'AE Blending Options ▸ Fill Opacity, 0..100: fades the layer CONTENT (on a shape that is its fill AND its ' +
          'stroke) while layer styles (drop shadow, glow, stroke style) keep theirs. For an outline-only shape set ' +
          'fill: "none" instead.',
      },
      // ── Stroke (the layer's first stroke, Contents ▸ Stroke 1; on text, Character ▸ Stroke) ──
      ...STROKE_PROPS,
      cornerRadius: {
        type: 'number',
        minimum: 0,
        description:
          'Corner radius in px, for shape/solid layers. Use a SCALE — 0 / 2 / 6 / 12 / 24 — not ' +
          'arbitrary values; one radius everywhere is as much a tell as a random radius on each.',
      },
      backdropBlur: {
        type: 'number',
        minimum: 0,
        description:
          'Blur what is BEHIND this layer, in px — a frosted-glass panel. Different from the blur ' +
          'effect, which blurs the layer itself. This is how you do a glass card, a translucent ' +
          'sheet, or an iOS-style toolbar; pair it with a low-opacity light fill. It blurs only: for ' +
          'refraction, a rim light, tint and grain use apply_layer_style { styleType: "glass" }, which ' +
          'includes its own backdrop blur (do not stack both). Keyframeable as `backdropBlur`.',
      },
      threeD: { type: 'boolean', description: 'Enable the 3D switch (required before z/rotationX/rotationY).' },
      acceptsLights: {
        type: 'boolean',
        description:
          'Let scene lights shade this layer. OFF by default, and until it is on a light layer ' +
          'changes NOTHING about how this layer renders — the shading path is gated on the 3D ' +
          'switch AND this flag. Turn both on for any layer a set_light call is meant to affect.',
      },
      ambient: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Percent of the layer\'s own colour that survives with no light on it. 100 = unlit look.',
      },
      diffuse: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Percent of scene light this surface scatters. The main lighting response.',
      },
      specular: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Percent highlight strength. 0 for matte paper, high for glass or metal.',
      },
      shininess: {
        type: 'number',
        minimum: 1,
        description: 'Highlight tightness. Low = broad sheen, high = a small hot spot.',
      },
      // Material Options beyond Phong (3D layers): the engine's PBR, toon and
      // glass response, and AE's shadow switches.
      shading: {
        type: 'string',
        enum: ['phong', 'pbr', 'toon'],
        description: 'Shading model (3D). pbr: physically based — metal + roughness decide the surface (chrome, brushed steel, plastic, clay). toon: flat cel bands (toonBands). phong: the classic AE look (ambient/diffuse/specular/shininess).',
      },
      metal: { type: 'number', minimum: 0, maximum: 100, description: 'Percent metal (3D). 100 = the surface takes its own colour into its reflections (gold, chrome); 0 = dielectric (plastic, paint).' },
      roughness: { type: 'number', minimum: 0, maximum: 100, description: 'Percent roughness (3D, pbr). Low = mirror-sharp highlights, high = matte. Default 50.' },
      reflectionIntensity: { type: 'number', minimum: 0, maximum: 100, description: 'Percent of the environment and other layers reflected (3D). Needs an environment light to have something to reflect.' },
      reflectionSharpness: { type: 'number', minimum: 0, maximum: 100, description: 'Percent: 100 = mirror reflections, 0 = blurred.' },
      transparency: { type: 'number', minimum: 0, maximum: 100, description: 'Percent see-through (3D glass). What is behind shows through unrefracted; `ior` sets how strongly the surface REFLECTS at grazing angles (Fresnel), not refraction.' },
      ior: { type: 'number', minimum: 1, maximum: 4, description: 'Index of refraction for the surface\'s Fresnel reflectance (F0): 1.0 air (no reflection), 1.33 water, 1.52 glass, 2.4 diamond. It does not bend what is seen through a transparent layer — for refracting, frosted glass use apply_layer_style { styleType: "glass" } on a 2D layer.' },
      lightTransmission: { type: 'number', minimum: 0, maximum: 100, description: 'Percent of light passing through the layer (back-lit paper, leaves).' },
      castsShadows: {
        type: 'string',
        enum: ['off', 'on', 'only'],
        description: 'Whether this 3D layer casts shadows from lights that cast shadows. only = invisible, shadow only.',
      },
      acceptsShadows: { type: 'boolean', description: 'Whether shadows fall on this 3D layer (a floor, a wall). On by default.' },
      toonBands: { type: 'number', minimum: 2, maximum: 8, description: 'Number of cel bands with shading "toon".' },
      // Geometry Options (3D shape and text layers): real extruded meshes.
      extrusionDepth: { type: 'number', minimum: 0, maximum: 1000, description: 'Px of real 3D depth (3D shape or text layer): extruded type, a logo slab, a coin. 0 = flat card.' },
      bevelDepth: { type: 'number', minimum: 0, maximum: 200, description: 'Px of bevel on the extrusion\'s front edges (catches highlights). Needs extrusionDepth > 0.' },
      bevelStyle: { type: 'string', enum: ['angular', 'concave', 'convex'], description: 'Bevel profile: angular (chamfer), convex (rounded), concave (cove).' },
      motionBlur: { type: 'boolean', description: 'Enable/disable motion blur for smooth movement.' },
      blendMode: {
        type: 'string',
        enum: [
          'normal', 'add', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
          'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
          'exclusion', 'hue', 'saturation', 'color', 'luminosity'
        ],
        description: 'Set layer blend mode for advanced composite overlays.'
      },
      matte: {
        type: 'object',
        description: 'Configure track matte using the layer directly above this layer.',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['alpha', 'luma', 'alpha-inv', 'luma-inv'] },
          sourceId: { type: 'string', description: 'The layer id of the matte source layer.' }
        }
      },
      removeMatte: { type: 'boolean', description: 'Set true to remove any track matte.' }
    },
  },
};

// ── Animation ─────────────────────────────────────────────────────

export const setKeyframesDef: AiToolDef = {
  name: 'set_keyframes',
  kind: 'write',
  description:
    'Author keyframes. Batch EVERY keyframe for a gesture into ONE call — do not call once per ' +
    'keyframe. Times are COMPOSITION seconds (layer-time conversion is automatic). ' +
    'A property needs at least 2 keyframes at different times to animate. ' +
    'Easing applies to the segment STARTING at that keyframe.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['keyframes'],
    properties: {
      keyframes: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop', 't', 'value'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string', description: PROP_HINT },
            t: { type: 'number', minimum: 0, description: 'Composition seconds.' },
            value: { type: 'number' },
            easing: { type: 'string', enum: EASING_ENUM, default: 'linear' },
            bezier: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'number' },
              description:
                'Only with easing="bezier". [x1,y1,x2,y2]; x must be 0..1, y may overshoot ' +
                '(e.g. [0.34,1.56,0.64,1] for a bounce).',
            },
          },
        },
      },
    },
  },
};

export const removeKeyframesDef: AiToolDef = {
  name: 'remove_keyframes',
  kind: 'write',
  description:
    'Remove keyframes. Pass t to remove one, or omit t to clear the whole property track.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['targets'],
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string', description: PROP_HINT },
            t: { type: 'number', minimum: 0, description: 'Composition seconds. Omit to clear the track.' },
          },
        },
      },
    },
  },
};

export const setEasingDef: AiToolDef = {
  name: 'set_easing',
  kind: 'write',
  description:
    'Change easing on keyframes that already exist. Also sets roving. ' +
    'Prefer passing easing inline to set_keyframes when authoring; use this to adjust afterwards.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['targets'],
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop', 't'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string' },
            t: { type: 'number', minimum: 0, description: 'Composition seconds of an EXISTING keyframe.' },
            easing: { type: 'string', enum: EASING_ENUM },
            bezier: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
            roving: { type: 'boolean' },
          },
        },
      },
    },
  },
};

export const setExpressionDef: AiToolDef = {
  name: 'set_expression',
  kind: 'write',
  description:
    'Attach an After Effects-style expression to a property. A program of statements is fine ' +
    '(var/let/const, if/else, for/while, functions, arrows); its LAST expression statement is the value, ' +
    'as in AE. Available: time, value, wiggle(freq,amp), loopOut("cycle"|"pingpong"|"offset"|"continue"), ' +
    'loopIn, valueAtTime(t), velocity, speed, linear/ease/easeIn/easeOut, clamp, random, seedRandom, noise, ' +
    'Math, posterizeTime, thisComp.layer("Name").transform.position, effect("Name")("Param"), ' +
    'thisLayer, inPoint/outPoint, index, parent, marker, audio, ctrl(name). ' +
    'Expressions OVERRIDE keyframed values. Pass an empty string to remove.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'prop', 'expression'],
    properties: {
      nodeId: { type: 'string' },
      prop: { type: 'string', description: PROP_HINT },
      expression: { type: 'string', description: 'e.g. wiggle(2, 30)  or  var f = 4; value + Math.sin(time * f) * 10' },
    },
  },
};

/**
 * Layer bars — when a layer exists on the timeline at all.
 *
 * Without this every authored layer spans the whole comp, so a "scene" was
 * only ever an opacity fade over layers that are still there, still
 * evaluated, and still under every later scene. A beat that owns its time
 * needs its layers to start and end with it.
 */
export const setAudioDef: AiToolDef = {
  name: 'set_audio',
  kind: 'write',
  description:
    'Sound of an audio layer (or a video layer\'s own track): loop the clip (Interpret Footage ▸ Loop — a 4 s ' +
    'ambience under a 30 s scene: loop it, then stretch the layer\'s bar with set_layer_timing outSec), its level ' +
    'in dB, and a fade in / out at the ends of its bar (level keys down to −60 dB).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      loop: {
        type: 'integer',
        minimum: 0,
        maximum: 1000,
        description: 'How many times the source plays: 0 = forever (as long as the bar lasts), 1 = once (no loop).',
      },
      levelDb: { type: 'number', minimum: -60, maximum: 24, description: 'Static level in dB (0 = as recorded).' },
      fadeInSec: { type: 'number', minimum: 0.01, maximum: 60 },
      fadeOutSec: { type: 'number', minimum: 0.01, maximum: 60 },
    },
  },
};

export const paintStrokesDef: AiToolDef = {
  name: 'paint_strokes',
  kind: 'write',
  description:
    'Paint brush strokes on a layer (AE Paint ▸ Brush): calligraphy, ink marks, hand-drawn lines. Each stroke is a ' +
    'list of points in layer px from the layer\'s top-left; a third number per point is pen PRESSURE 0..1, which ' +
    'scales the tip down to minSize — that is the brush taper (press hard in the belly of a stroke, lift at its ' +
    'ends). `reveal` draws the stroke on between two composition times (AE Write On). onTransparent: the layer ' +
    'shows ONLY its paint (paint on a transparent solid over other layers). The brush tip is AE\'s: angle + roundness ' +
    'make a flat calligraphy nib (roundness 20–40 with angle 45 is a broad-nib pen), spacing turns the stroke into dabs, ' +
    'flow builds paint up per dab under the opacity cap. mode "erase" cuts the layer\'s content away; "clone" paints ' +
    'the layer\'s own content from an offset. Every numeric option animates as paint.<strokeId>.<param> (set_keyframes).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'strokes'],
    properties: {
      nodeId: { type: 'string' },
      onTransparent: { type: 'boolean' },
      strokes: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['points'],
          properties: {
            points: {
              type: 'array',
              minItems: 1,
              maxItems: 2000,
              items: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'number' } },
              description: '[[x, y], …] or [[x, y, pressure], …] in layer px (top-left origin). Pressure 0..1.',
            },
            color: { type: 'string', description: 'Hex. Default #000000.' },
            size: { type: 'number', minimum: 1, maximum: 2500, description: 'Brush diameter px at full pressure. Default 12.' },
            hardness: { type: 'number', minimum: 0, maximum: 100, description: '% — 100 a crisp edge, 0 a soft wash. Default 80.' },
            opacity: { type: 'number', minimum: 0, maximum: 100, description: '%. Default 100.' },
            minSize: { type: 'number', minimum: 0, maximum: 100, description: '% of size at zero pressure (AE Minimum Size). Default 10.' },
            angle: { type: 'number', minimum: -180, maximum: 180, description: 'Brush tip angle, degrees (AE Angle). Only visible with roundness < 100. Default 0.' },
            roundness: { type: 'number', minimum: 1, maximum: 100, description: '% — 100 a round tip, lower a flatter ellipse (a nib). Default 100.' },
            spacing: { type: 'number', minimum: 1, maximum: 1000, description: '% of the diameter between dabs (AE Spacing). Omit for a continuous stroke; 25 is AE\'s brush default, > 100 leaves separate dots.' },
            flow: { type: 'number', minimum: 0, maximum: 100, description: '% paint laid per dab, accumulating up to opacity (AE Flow). Default 100.' },
            mode: { type: 'string', enum: ['paint', 'erase', 'clone'], description: 'paint (default) composites colour; erase cuts the layer away; clone paints the layer\'s own content from cloneOffsetX/Y.' },
            cloneOffsetX: { type: 'number', description: 'mode "clone": where to sample from, layer px right of where the stroke paints. Default 0.' },
            cloneOffsetY: { type: 'number', description: 'mode "clone": layer px below where the stroke paints. Default 0.' },
            reveal: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'to'],
              properties: { from: { type: 'number', minimum: 0 }, to: { type: 'number', minimum: 0 } },
              description: 'Composition seconds: the stroke draws itself on from `from` to `to`.',
            },
          },
        },
      },
    },
  },
};

export const setLayerTimingDef: AiToolDef = {
  name: 'set_layer_timing',
  kind: 'write',
  description:
    'Set when layers exist on the timeline (their bars). Times are COMPOSITION seconds. ' +
    'inSec / outSec are where the bar starts and ends; outside them the layer does not render. ' +
    'startSec is where the layer\'s own time 0 (a clip\'s first frame) sits — omit it for shapes ' +
    'and text. Batch every layer of a beat into ONE call. Keyframes keep their composition times.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId'],
          properties: {
            nodeId: { type: 'string' },
            startSec: { type: 'number', description: 'Composition seconds at which the layer\'s source time 0 plays.' },
            inSec: { type: 'number', minimum: 0, description: 'Composition seconds the bar starts.' },
            outSec: { type: 'number', minimum: 0, description: 'Composition seconds the bar ends. Must be after inSec.' },
          },
        },
      },
    },
  },
};

// ── Effects + text ────────────────────────────────────────────────

/**
 * Effects that exist in `EFFECT_DEFS` and are deliberately NOT offered to the AI,
 * each with the reason. An entry here is a claim that the effect cannot WORK from
 * a tool call, not that nobody got round to listing it.
 *
 * This exists because the enum below was a silent subset for three rounds — the
 * absent effects looked exactly like a curated allowlist and were nothing of the
 * kind. So the two cases are now spelled apart: everything in `EFFECT_DEFS` is
 * either in the enum or in here with a reason, and
 * `src/core/effects/aiAddEffectEnum.test.ts` fails if anything is in neither.
 *
 * Keep this list SHORT and justify each entry against what the AI can actually
 * reach. "Takes a layer reference" is NOT a reason: `update_effect_param` types
 * its `value` as unconstrained JSON and `toolContext` passes it through
 * uncoerced, so a `type: 'layer'` param takes a nodeId from `describe_scene`
 * perfectly well — which is why set-matte, compound-blur, displacement-map and
 * audio-spectrum are all in the enum rather than here.
 */
export const AI_EXCLUDED_EFFECTS: Readonly<Record<string, string>> = {
  'apply-color-lut':
    'Its `lut` param is a parsed .cube FILE (type "resolved"), and no AI tool loads ' +
    'one — there is no file-picker equivalent on the tool surface. `applyColorLut` ' +
    'returns early when the LUT is absent ("no file loaded — render unchanged"), so ' +
    'an AI-added instance is a guaranteed silent no-op: it would occupy a slot in the ' +
    'effect stack and change no pixels. Offering it would be worse than omitting it. ' +
    'Delete this entry the moment a tool can supply a LUT.',
};

export const addEffectDef: AiToolDef = {
  name: 'add_effect',
  kind: 'write',
  description:
    'Add an effect to a layer and return its effectId. Effects have named params ' +
    '(see list_capabilities for each type\'s params, types and ranges). Animate any ' +
    'numeric param by keyframing the prop path "effect.<effectId>.<paramKey>" (or the ' +
    'legacy "effect.<effectId>" for the primary param). Set static param values here with ' +
    '`params` ({ "blurriness": 40, "color": "#ff0000" }), or later with update_effect_param.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'type'],
    properties: {
      nodeId: { type: 'string' },
      type: {
        type: 'string',
        // EVERY effect in EFFECT_DEFS (src/core/effects/effects.ts) except those
        // in AI_EXCLUDED_EFFECTS above. This package cannot import from the app,
        // so the list is hand-written and a comment claiming lockstep is worth
        // nothing — the previous one said exactly that while listing 45 of 92.
        // The guard is `src/core/effects/aiAddEffectEnum.test.ts`, which imports
        // both sides and fails NAMING whatever drifted. Grouped by the panel's
        // category purely for review; order is not semantic.
        //
        // list_capabilities reads the live registry and remains the source of
        // truth for each type's PARAMS; this enum is only the gate on the type.
        enum: [
          // Blur & Sharpen
          'blur', 'compound-blur', 'sharpen', 'directional-blur', 'gaussian-blur',
          'fast-box-blur', 'radial-blur', 'channel-blur', 'unsharp-mask',
          // Stylize
          'glow', 'drop-shadow', 'noise', 'inner-shadow', 'inner-glow', 'satin', 'bevel',
          'mosaic', 'find-edges', 'roughen-edges', 'turbulent-noise', 'add-grain', 'median',
          'threshold', 'emboss', 'scatter',
          // Color Correction
          'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate',
          'hue-saturation', 'invert', 'levels', 'curves', 'posterize', 'tint', 'channel-mixer',
          'exposure', 'vibrance', 'colorama', 'lumetri', 'selective-color', 'shadow-highlight',
          'color-balance', 'gamma-pedestal-gain', 'photo-filter', 'black-and-white', 'tritone',
          // Generate
          'gradient-ramp', 'fractal-noise', 'fill', 'image-fill', 'four-color-gradient', 'stroke', 'beam',
          'checkerboard', 'grid', 'cell-pattern', 'vegas', 'lens-flare', 'numbers', 'timecode',
          'audio-spectrum',
          // Distort
          'displacement-map', 'motion-tile', 'bend', 'wide-time', 'force-motion-blur',
          'bevel-alpha', 'bevel-edges', 'spotlight', 'sphere', 'cylinder', 'arithmetic',
          'wave-warp', 'turbulent-displace', 'curl-noise', 'transform',
          'bulge', 'twirl', 'spherize', 'corner-pin', 'bezier-warp', 'polar-coordinates', 'optics-compensation', 'mesh-warp', 'liquify',
          'mirror', 'offset',
          // Keying
          'keylight', 'set-matte', 'simple-choker', 'linear-color-key', 'shift-channels',
          'luma-key', 'minimax',
          // Time
          'echo', 'posterize-time',
          // Transition
          'linear-wipe', 'venetian-blinds', 'gradient-wipe', 'card-wipe', 'radial-wipe',
          'block-dissolve',

          // ── Round four ──
          //
          // `optics-compensation` is here rather than with the round-three
          // distorts because it landed separately and the guard test caught its
          // absence — which is the drift this whole arrangement exists to stop.
          'optics-compensation',
          // Blur & Sharpen
          'bilateral-blur', 'smart-blur', 'camera-lens-blur',
          // Distort
          'ripple', 'magnify', 'warp', 'page-turn', 'split', 'slant', 'smear', 'rolling-shutter',
          // Perspective
          'radial-shadow',
          // Generate
          'circle', 'ellipse', 'radio-waves', 'lightning', 'plexus', 'light-rays', 'light-sweep',
          'audio-waveform',
          // Stylize
          'cartoon', 'brush-strokes', 'strobe-light', 'color-emboss', 'halftone',
          'kaleidoscope', 'vignette', 'burn-film',
          // Color Correction
          'equalize', 'auto-levels', 'auto-contrast', 'auto-color', 'change-color',
          'change-to-color', 'leave-color', 'toner',
          // Keying & Channel
          'color-key', 'color-range', 'extract', 'spill-suppressor', 'matte-choker', 'refine-soft-matte', 'refine-hard-matte',
          'advanced-spill-suppressor', 'key-cleaner', 'remove-grain', 'reshape',
          'alpha-levels', 'solid-composite', 'channel-combiner', 'remove-color-matting',
          // Transition
          'iris-wipe', 'light-wipe', 'line-sweep', 'grid-wipe',
          // Noise & Grain
          'dust-scratches', 'noise-alpha',
          // Round five — Generate / weather
          'star-burst', 'snowfall', 'rainfall', 'write-on', 'light-burst',
          // Round five — Stylize & Blur
          'deep-glow', 'beam-path', 'glass', 'texturize', 'threads', 'chromatic-aberration', 'hex-tile', 'vector-blur',
          // Program F1–F3: the ink set
          'ink-bleed', 'paper', 'ink-splatter',
          // Round five — Distort
          'flo-motion', 'lens', 'griddler', 'ball-action', 'drizzle',
          // Round five — Transition
          'jaws', 'pixel-polly', 'twister', 'card-dance',
          // Round six — Iconic AE & CC effects
          'unmult', 'cc-composite', 'cc-repetile', 'cc-scatterize',
          'radial-fast-blur', 'cross-blur', 'scale-wipe', 'plastic',
          // Round seven — Distort / Transition
          'cc-tiler', 'ripple-pulse', 'radial-scale-wipe', 'glass-wipe', 'image-wipe',
          // Round seven — Keying / Colour (incl. the three LUT effects)
          'color-difference-key', 'wire-removal', 'broadcast-colors', 'noise-hls',
          'color-offset', 'threshold-rgb', 'cineon-converter',
          // Round seven — Stylize / Perspective / Generate / Simulation
          'block-load', 'kernel', '3d-glasses', 'fractal', 'particle-systems', 'cc-bubbles',
          // Stroke-like paint effects (2026-09-15) — AE Stroke and Scribble
          'path-stroke', 'scribble',
          // fx60:b12:begin
          'brightness-contrast', 'color-balance-hls', 'calculations', 'set-channels', 'blend', 'difference-matte',
          'color-neutralizer', 'blobbylize', 'cc-split-2', 'eyedropper-fill', 'noise-hls-auto', 'caustics', 'shatter',
          'wave-world', 'warpomatic', 'overbrights', 'hdr-compander', 'hdr-highlight-compression',
          'reduce-interlace-flicker', 'basic-3d', 'digital-glitch', 'vr-rotate-sphere', 'color-gradients', 'vhs',
          'crt', 'pixel-sort', 'long-shadow', 'halation', 'light-leaks', 'tilt-shift', 'gradient-map', 'duotone',
          'soft-glow', 'neon', 'hologram', 'dither', 'ascii', 'led-screen', 'pencil-sketch', 'oil-paint',
          'camera-shake', 'flicker', 'prism', 'frosted-glass', 'bleach-bypass', 'cross-process', 'split-toning',
          'old-film', 'anamorphic-streaks', 'starglow', 'sparkle', 'white-balance', 'clarity', 'lens-distortion',
          'heat-haze', 'color-halftone', 'crystallize', 'fog', 'chrome', 'night-vision',
          // fx60:b12:end
          'depth-matte', 'depth-fog', 'depth-extract',
          // deepfx:ai:begin
          'lens-bloom', 'shine', 'image-flares', 'painterly', 'watercolor', 'ink-outline', 'detail-upscale',
          'paint-bucket', 'light-wrap', 'refraction', 'compound-arithmetic', 'color-link', 'inner-outer-key',
          'energy-saber', 'ps-arbitrary-map', 'edge-rays', 'vr-blur', 'vr-chromatic-aberrations', 'vr-converter',
          'vr-denoise', 'vr-fractal-noise', 'vr-glow', 'vr-plane-to-sphere', 'vr-sharpen', 'volumetric-lights',
          'relight', 'volumetric-clouds', 'starfield', 'cc-environment', 'ocean', 'aurora', 'stroke-3d', 'timewarp',
          'pixel-motion-blur', 'time-displacement', 'time-difference', 'time-blend', 'light-trails', 'datamosh',
          'temporal-denoise', 'fluid-ink', 'reaction-diffusion', 'crystal-growth', 'mr-mercury', 'foam', 'hair',
          'rain-on-glass', 'particle-world', 'warp-stabilizer', 'match-grain', 'color-stabilizer',
          'camera-shake-deblur', 'burn-dissolve', 'liquid-morph', 'bend-it', 'bender', 'matte-stroke',
          'selective-color-ai', 'object-matte', 'goo',
          // deepfx:ai:end
        ],
      },
      amount: {
        type: 'number',
        description:
          'Initial value for the primary param. Omit for the effect default. For type "blur" this is the ' +
          'Gaussian sigma in px, 0..250 — 40+ is what a large soft glow needs. Past ~60 the kernel strides ' +
          'between samples: invisible on shapes, glows and gradients, but fine detail (footage, small text) ' +
          'can shimmer in motion, so keep detailed layers under that. gaussian-blur (blurriness 0..500) and ' +
          'fast-box-blur (blurRadius 0..500) share the same kernel and add per-axis control.',
      },
      id: {
        type: 'string',
        description:
          'Name the effect rather than taking the generated id. Use this when the ' +
          'keyframes animating it are authored in the same batch and so cannot read ' +
          "this call's result. Ignored if the node already has an effect with this id.",
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          'Initial static values by param key (numbers, colour strings, booleans), the keys ' +
          'list_capabilities gives for this type. Unknown keys are reported, not applied.',
      },
    },
  },
};

export const updateEffectDef: AiToolDef = {
  name: 'update_effect',
  kind: 'write',
  description: 'Change or remove an effect on a layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'effectId'],
    properties: {
      nodeId: { type: 'string' },
      effectId: { type: 'string' },
      amount: { type: 'number' },
      remove: { type: 'boolean', default: false },
    },
  },
};

export const textAnimatorDef: AiToolDef = {
  name: 'text_animator',
  kind: 'write',
  description:
    'Add or update a per-character text animator — how you do "type on", "letters fly in", ' +
    '"wave". Only valid on text layers. A range selector [start,end]+offset (percentages) sweeps ' +
    'across characters/words/lines with a falloff shape, applying the transform deltas. ' +
    'Animate the sweep by keyframing "ta.<index>.offset". Returns the animator index.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      index: { type: 'integer', minimum: 0, description: 'Omit to add a new animator; pass to update one.' },
      basedOn: { type: 'string', enum: ['characters', 'words', 'lines'], default: 'characters' },
      shape: { type: 'string', enum: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] },
      start: { type: 'number', description: 'Range start, percent.' },
      end: { type: 'number', description: 'Range end, percent.' },
      offset: { type: 'number', description: 'Range offset, percent. Keyframe this to sweep.' },
      x: { type: 'number' },
      y: { type: 'number' },
      scale: { type: 'number' },
      scaleY: { type: 'number', description: 'Non-uniform per-glyph scale. Falls back to scale when omitted.' },
      rotation: { type: 'number' },
      opacity: { type: 'number' },
      tracking: { type: 'number' },
      lineSpacing: { type: 'number', description: 'Extra leading between lines, px.' },
      blur: { type: 'number', minimum: 0, description: 'Per-character blur in px — this is how you do a blur-resolve type-on.' },
      skew: { type: 'number', description: 'Per-character skew in degrees — an italic lean that settles out.' },
      fillOpacity: { type: 'number', description: 'Fade the glyph FILL but not its stroke — an outline-to-solid reveal.' },
      characterOffset: {
        type: 'number',
        description:
          'Shift each covered character N places through its alphabet. A staggered offset that ' +
          'rolls back to 0 is the scramble / decode reveal, and it cannot be faked with transforms.',
      },
      color: { type: 'string', description: 'Hex colour the covered glyphs blend toward.' },
      sweep: {
        type: 'object',
        additionalProperties: false,
        description:
          'Animate the range selector in THIS call instead of a follow-up set_keyframes on ' +
          '"ta.<index>.offset". Sweeping the selector is what makes a text animator animate at ' +
          'all — an animator with a static selector is a static style. The selector is Start 0 / ' +
          'End 100, so Offset o covers the characters in [o%, o% + 100%]: 0 covers them all, ±100 ' +
          'none. The default 0 → 100 uncovers the text once, left to right (a reveal when the ' +
          'animator hides what it covers); 100 → 0 covers it once. Do NOT sweep −100 → 100: that ' +
          'covers the text only mid-sweep and leaves it uncovered at both ends.',
        required: ['fromSec', 'toSec'],
        properties: {
          fromSec: { type: 'number', minimum: 0, description: 'Composition seconds the sweep starts.' },
          toSec: { type: 'number', minimum: 0, description: 'Composition seconds the sweep ends.' },
          fromOffset: { type: 'number', default: 0, description: 'Selector offset at fromSec, percent (0 = every character covered).' },
          toOffset: { type: 'number', default: 100, description: 'Selector offset at toSec, percent (100 = none covered).' },
          easing: { type: 'string', enum: EASING_ENUM, default: 'bezier' },
          bezier: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
        },
      },
      remove: { type: 'boolean', default: false },
    },
  },
};

// ── Media ─────────────────────────────────────────────────────────

export const createMediaDef: AiToolDef = {
  name: 'create_media',
  kind: 'write',
  description:
    'Place an already-imported media asset (image / video / audio) on the canvas as a new layer, ' +
    'and return its id. Call list_assets first to get a real assetId — you cannot import new files, ' +
    'only place ones the user already added. Image/video layers appear at native size, centred; ' +
    'pass x/y to position. Animate the result like any other layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assetId'],
    properties: {
      id: ALIAS_PROP,
      assetId: { type: 'string', description: 'An asset id from list_assets.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

// ── Masks ─────────────────────────────────────────────────────────

export const createMaskDef: AiToolDef = {
  name: 'create_mask',
  kind: 'write',
  description:
    'Add a vector mask to a layer, clipping what it draws to a rectangle or ellipse — how you do ' +
    'a spotlight, a vignette, a shaped reveal, or "show only part of this". The mask fills the ' +
    "layer's bounds by default; pass width/height to size it smaller. Returns the maskId. " +
    'For a reveal, animate an effect or the layer instead — mask-shape animation is not yet a tool.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'shape'],
    properties: {
      nodeId: { type: 'string' },
      shape: { type: 'string', enum: ['rectangle', 'ellipse'] },
      mode: {
        type: 'string',
        enum: ['add', 'subtract', 'intersect'],
        default: 'add',
        description: 'add = keep inside; subtract = cut a hole; intersect = keep overlap of masks.',
      },
      width: { type: 'number', minimum: 1, description: 'Mask width in layer px. Defaults to the layer width.' },
      height: { type: 'number', minimum: 1, description: 'Mask height in layer px. Defaults to the layer height.' },
      feather: { type: 'number', minimum: 0, description: 'Edge softness in px. 0 is a hard edge.' },
      opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Mask strength, 0..1. Default 1.' },
      expansion: { type: 'number', description: 'Grow (+) or shrink (−) the shape in px.' },
      inverted: { type: 'boolean', description: 'Clip to the OUTSIDE of the shape instead of the inside.' },
      x: { type: 'number', description: 'Mask centre offset from the layer centre, layer px (+ right). Default 0.' },
      y: { type: 'number', description: 'Mask centre offset from the layer centre, layer px (+ down). Default 0.' },
    },
  },
};

const MASK_SHAPE_PROPS = {
  shape: { type: 'string', enum: ['rectangle', 'ellipse'] },
  width: { type: 'number', minimum: 1, description: 'Layer px. Defaults to the layer width.' },
  height: { type: 'number', minimum: 1, description: 'Layer px. Defaults to the layer height.' },
  x: { type: 'number', description: 'Centre offset from the layer centre, layer px (+ right).' },
  y: { type: 'number', description: 'Centre offset from the layer centre, layer px (+ down).' },
} as const;

export const updateMaskDef: AiToolDef = {
  name: 'update_mask',
  kind: 'write',
  description:
    'Change, animate or delete a mask create_mask made (maskId from its result). Pass shape (with width / height / ' +
    'x / y) to replace the outline, feather / opacity / expansion / mode / inverted to restyle it, keys for an ' +
    'animated Mask Path (a reveal that grows, a window that slides — each key is a whole outline at comp ' +
    'seconds t), or remove: true to delete it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'maskId'],
    properties: {
      nodeId: { type: 'string' },
      maskId: { type: 'string' },
      remove: { type: 'boolean' },
      ...MASK_SHAPE_PROPS,
      mode: { type: 'string', enum: ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'] },
      feather: { type: 'number', minimum: 0 },
      opacity: { type: 'number', minimum: 0, maximum: 1 },
      expansion: { type: 'number' },
      inverted: { type: 'boolean' },
      keys: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        description: 'Mask Path keyframes. Each key\'s shape / size / offset fall back to the call\'s, then the layer box.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['t'],
          properties: { t: { type: 'number', minimum: 0 }, ...MASK_SHAPE_PROPS },
        },
      },
    },
  },
};

// ── Composition + presets ─────────────────────────────────────────

export const updateCompositionDef: AiToolDef = {
  name: 'update_composition',
  kind: 'write',
  description:
    'Change composition settings the user can adjust: duration, frame rate, background. ' +
    'Only do this when the user asks. NOTE: composition WIDTH and HEIGHT are fixed at creation ' +
    'and cannot be changed — design for the frame stated in the context instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fps: { type: 'number', minimum: 1, maximum: 240 },
      durationSeconds: { type: 'number', minimum: 0.1 },
      background: { type: 'string', description: 'Hex colour.' },
    },
  },
};

export const applyPresetDef: AiToolDef = {
  name: 'apply_preset',
  kind: 'write',
  description:
    'Apply a built-in animation preset to a layer at a time. Presets adapt to the layer\'s current ' +
    'position, and 3D presets enable the 3D switch automatically. Call list_presets for names.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'preset'],
    properties: {
      nodeId: { type: 'string' },
      preset: { type: 'string' },
      atTime: { type: 'number', minimum: 0, default: 0, description: 'Composition seconds.' },
    },
  },
};

export const createMediaFromAttachmentDef: AiToolDef = {
  name: 'create_media_from_attachment',
  kind: 'write',
  description:
    'Place a reference image attached to the user prompt directly onto the canvas as a new image layer, ' +
    'and return its id. Pass index (0 for first attachment). ' +
    'This automatically uploads the image as a project asset and adds it to the composition.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['index'],
    properties: {
      id: ALIAS_PROP,
      index: { type: 'integer', minimum: 0, description: 'Index of the image in the prompt attachments (0-based).' },
      name: { type: 'string', description: 'Descriptive name for the new layer.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

/** One puppet pin keyframe: a moment, the pin's position, and optionally how the key eases and bends the path. */
const PUPPET_PIN_KEY: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['timeSec', 'x', 'y'],
  properties: {
    timeSec: { type: 'number', minimum: 0, description: 'Time of this keyframe in seconds.' },
    x: { type: 'number', description: 'Local X of the pin at this time.' },
    y: { type: 'number', description: 'Local Y of the pin at this time.' },
    easing: { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'bezier'], description: 'Temporal ease of the segment that starts at this key (default linear). "bezier" uses `bezier`.' },
    bezier: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'Cubic-bezier ease [x1, y1, x2, y2] for this key (sets easing "bezier").' },
    tangentIn: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'SPATIAL tangent into the key, layer px relative to the pin position: bends the pin\'s path (an arc instead of a corner).' },
    tangentOut: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Spatial tangent out of the key, layer px relative to the pin position.' },
  },
};

export const createPuppetRigDef: AiToolDef = {
  name: 'create_puppet_rig',
  kind: 'write',
  description:
    'Puppet-pin a shape or image layer (After Effects\' Puppet tools): pins in LAYER-LOCAL px centred on the ' +
    'origin (x from −width/2 to width/2, y from −height/2 to height/2 — read positions off render_rig_view). Pin ' +
    'kinds: "position" (moves a point of the mesh), "advanced" (position + rotation + scale, the default), "bend" ' +
    '(rotates and scales a region carried by the other pins — a wrist, a tail tip), "starch" (keeps a region ' +
    'rigid), "overlap" (which part draws in front where the mesh folds). Mesh settings shape the deformation ' +
    '(`mesh`). Returns the pin ids. Animate: set_puppet_pin_keyframes for pin positions (with eases and path ' +
    'tangents); set_keyframes on puppet.<pinId>.rotation (degrees) / .stiffness / .scale. By default the call ' +
    'REPLACES the layer\'s rig; append: true keeps the existing pins and adds these.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'pins'],
    properties: {
      layerId: { type: 'string', description: 'ID of the layer to rig.' },
      pins: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'x', 'y'],
          properties: {
            name: { type: 'string', description: 'Descriptive name for the pin.' },
            x: { type: 'number', description: 'Local X coordinate of the pin.' },
            y: { type: 'number', description: 'Local Y coordinate of the pin.' },
            kind: { type: 'string', enum: ['position', 'advanced', 'bend', 'starch', 'overlap'], default: 'advanced' },
            rotation: { type: 'number', description: 'Static rotation in degrees — rotates the deformation rigidly around the pin (advanced / bend).' },
            scale: { type: 'number', minimum: 0.01, maximum: 10, description: 'Static uniform scale around the pin (1 = unchanged; advanced / bend).' },
            stiffness: { type: 'number', minimum: 0, description: 'Static stiffness >= 0 — sharpens this pin\'s influence falloff (a starch pin defaults to 8).' },
            overlap: { type: 'number', minimum: -100, maximum: 100, description: 'Overlap depth: + in front, − behind where the mesh folds (overlap pins; default 50).' },
          },
        },
        description: 'Placements of puppet pins.',
      },
      mesh: {
        type: 'object',
        additionalProperties: false,
        properties: {
          density: { type: 'integer', minimum: 2, maximum: 50, description: 'Triangles across the layer (AE Triangles; default about 12). More = smoother bends, slower.' },
          expansion: { type: 'number', minimum: 0, maximum: 200, description: 'Mesh padding past the artwork\'s edge, px (AE Expansion).' },
          mode: { type: 'string', enum: ['grid', 'silhouette'], description: 'silhouette (default): the mesh hugs the artwork\'s outline / alpha; grid: a uniform lattice over the box.' },
          solver: { type: 'string', enum: ['arap', 'lbs'], description: 'arap (default) bends rigidly like AE\'s Advanced engine; lbs is the legacy linear blend.' },
          maxRotationDeg: { type: 'number', minimum: 0, maximum: 180, description: 'Mesh Rotation Refinement: the most any one pin may twist the mesh.' },
          traceAccuracy: { type: 'number', minimum: 0, maximum: 100, description: 'Image layers: how finely the silhouette mesh traces the bitmap\'s alpha, % (cells ≈ 16 px at 0 … 2 px at 100; default 60).' },
          alphaThreshold: { type: 'number', minimum: 0, maximum: 255, description: 'Image layers: the alpha (0–255) a pixel must reach to count as artwork for the mesh (default 32).' },
        },
        description: 'Mesh settings (the Puppet effect\'s Mesh group). Omitted fields keep the layer\'s current ones, or the defaults on a new rig.',
      },
      append: { type: 'boolean', default: false, description: 'Keep the pins the layer already has and add these.' },
    },
  },
};

export const setPuppetPinKeyframesDef: AiToolDef = {
  name: 'set_puppet_pin_keyframes',
  kind: 'write',
  description:
    'Animate puppet pins\' POSITIONS over time (the puppet.<pinId>.position track) — wave an arm, bounce a ' +
    'character, swing a tail. Give several pins in one call (`pins`), each with its keys in time order; every key ' +
    'may carry a temporal ease (easing or a cubic `bezier`) and SPATIAL tangents (tangentIn / tangentOut, layer px ' +
    'relative to the pin) so the pin travels an arc. Coordinates are layer-local, centred on the origin (the space ' +
    'create_puppet_rig and render_rig_view use). Rotation / stiffness / scale animate with set_keyframes on ' +
    'puppet.<pinId>.rotation / .stiffness / .scale. The old single-pin form (pinId + keyframes) still works.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string', description: 'ID of the rigged layer.' },
      pins: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pinId', 'keyframes'],
          properties: {
            pinId: { type: 'string', description: 'A pin id from create_puppet_rig.' },
            keyframes: { type: 'array', minItems: 1, maxItems: 400, items: PUPPET_PIN_KEY, description: 'Position keys for this pin, in time order.' },
          },
        },
        description: 'Several pins at once.',
      },
      pinId: { type: 'string', description: 'Single-pin form: the pin to animate.' },
      keyframes: { type: 'array', minItems: 1, maxItems: 400, items: PUPPET_PIN_KEY, description: 'Single-pin form: its keys in time order.' },
    },
  },
};

export const mergePathsDef: AiToolDef = {
  name: 'merge_paths',
  kind: 'write',
  description: 'Perform boolean path operations (union, subtract, intersect, exclude) on two or more shape layers.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'nodeIds'],
    properties: {
      op: {
        type: 'string',
        enum: ['union', 'subtract', 'intersect', 'exclude'],
        description: 'Boolean operation to apply.',
      },
      nodeIds: {
        type: 'array',
        minItems: 2,
        maxItems: 50,
        items: { type: 'string' },
        description: 'Shape layer IDs to merge (first selected is the base layer).',
      },
    },
  },
};

/**
 * A caller-supplied handle for a shape operator the engine has not minted yet.
 *
 * The engine names operators itself (`addPropertyGroup` returns the id), so a
 * batch emitted up front cannot spell `pathop.<opId>.end` for a trim it creates
 * in the same batch. With `id` the handler binds `handle → real op id` in the
 * run's alias map, and the registry rewrites `pathop.<handle>.…` in every later
 * `prop` (and `opId`) before a handler sees it — the `add_effect { id }` fix,
 * for operators.
 */
export const OP_ALIAS_PROP = {
  type: 'string',
  description:
    'Optional handle for the operator this call creates, so LATER calls in the same batch can keyframe ' +
    '"pathop.<handle>.<param>" (or pass it as opId) before the engine has assigned the real id. ' +
    'Unique within the run.',
} as const;

export const setTrimPathDef: AiToolDef = {
  name: 'set_trim_path',
  kind: 'write',
  description:
    'Configure trim path properties (start, end, offset) on a SHAPE layer and return the opId to ' +
    'keyframe (`pathop.<opId>.end` 0→100 is a stroke draw-on). Only shape layers have a path to cut: ' +
    'text, image and group layers are rejected, and an SVG layer must be converted first — pass ' +
    'convertSvg: true.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      id: OP_ALIAS_PROP,
      start: { type: 'number', minimum: 0, maximum: 100, description: 'Trim start percentage (0..100).' },
      end: { type: 'number', minimum: 0, maximum: 100, description: 'Trim end percentage (0..100).' },
      offset: {
        type: 'number',
        description: 'Rotate the visible window around the path, PERCENT of its length (wraps). Not degrees.',
      },
      convertSvg: {
        type: 'boolean',
        default: false,
        description:
          'Only for an SVG layer. An SVG layer is a rasterized document with no path to trim, so this ' +
          'first converts it into a GROUP of editable shape layers — one per SVG path, masks and filters ' +
          'flattened — then trims every one. The original id stops existing; the reply returns the group ' +
          'id and the opId of each shape.',
      },
    },
  },
};

/**
 * Note the absence of `scaleY`.
 *
 * The engine's repeater carries ONE per-copy scale multiplier (`offsetScale`),
 * so a schema offering two offered a control that cannot exist. With
 * `additionalProperties: false` everywhere else in this file, a parameter that
 * is accepted and then silently dropped is the worse of the two failures.
 */
export const addRepeaterDef: AiToolDef = {
  name: 'add_repeater',
  kind: 'write',
  description:
    'Add an AE-style Repeater shape operator: N copies, each offset from the last in ' +
    'position, rotation, scale and opacity. A radial burst is copies × rotation = 360 with a ' +
    'non-zero anchorX; a linear array is rotation 0 with a positionX step. ' +
    'Repeaters STACK: every call APPENDS a new one that repeats the output of those before it, ' +
    'so a dot grid is two calls (a row, then that row down the columns). To CHANGE an existing ' +
    'repeater instead, pass the opId an earlier call returned.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      id: OP_ALIAS_PROP,
      opId: { type: 'string', description: 'Update THIS existing repeater (an opId a previous add_repeater returned) instead of appending a new one. Only the fields you pass change.' },
      copies: { type: 'number', minimum: 1, maximum: 100, description: 'Number of copies, including the original.' },
      positionX: { type: 'number', description: 'X offset per copy, in px.' },
      positionY: { type: 'number', description: 'Y offset per copy, in px.' },
      rotation: { type: 'number', description: 'Rotation offset per copy, in degrees. 360/copies closes a ring.' },
      scale: { type: 'number', description: 'Scale multiplier per copy (1 = no change, 0.9 = each copy 10% smaller).' },
      anchorX: { type: 'number', description: 'Pivot for the per-copy rotation/scale, layer-local px. Set this to the ring RADIUS for a true radial burst — at 0 every copy spins about its own origin and the ring collapses.' },
      anchorY: { type: 'number', description: 'Pivot Y, layer-local px.' },
      startOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Opacity of the first copy, 0..100.' },
      endOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Opacity of the LAST copy, 0..100. The per-copy falloff is derived from these two.' },
    },
  },
};

/**
 * The enum is the ENGINE's operator set, not a hand-written subset of it.
 *
 * It listed four names, one of which (`puckerBloat`) is not an operator the
 * engine has — its name is `pucker` — while `offset` and `roughen`, which it
 * does have, were unreachable. `puckerBloat` stays as an accepted alias because
 * it is the name in the assistant's own quick presets and in the system prompt;
 * the handler is the single translation point.
 */
export const addPathOperatorDef: AiToolDef = {
  name: 'add_path_operator',
  kind: 'write',
  description:
    'Push a procedural path-distortion operator onto a shape layer. Operators STACK — call this ' +
    'twice to chain two — and each one is independently keyframeable at ' +
    '`pathop.<opId>.amount`. The returned opId is how you reach it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'op'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      id: OP_ALIAS_PROP,
      op: {
        type: 'string',
        enum: ['zigzag', 'pucker', 'puckerBloat', 'twist', 'roundCorners', 'offset', 'roughen', 'wiggleTransform'],
        description:
          'zigzag: sawtooth the outline. pucker: negative amount pulls corners in, positive bloats them ' +
          '(puckerBloat is an alias). twist: rotate proportionally to distance from centre. ' +
          'roundCorners: corner radius. offset: grow/shrink the outline. roughen: noise displacement. ' +
          'wiggleTransform: random position wander per run — placed AFTER a repeater, every copy ' +
          'wanders independently (amount = max px).',
      },
      amount: { type: 'number', description: 'Strength/radius of the deformation. For wiggleTransform: max position wander in px.' },
      detail: { type: 'number', description: 'Segment count for zigzag / roughen. Higher is finer.' },
      wigglesPerSecond: { type: 'number', minimum: 0, description: 'Roughen and wiggleTransform — animates the noise with no keyframe. 0 is static (wiggleTransform defaults to 2 when omitted).' },
    },
  },
};

/*
 * `set_text_on_path` stood here and is DELETED, not disabled.
 *
 * It wrote `pathNodeId` / `pathAlign` onto a text layer's Text component, and
 * **nothing in this repository reads either key** — not the renderer, not
 * `buildSnapshot`, not the text system. (`motionPath` / `autoOrient` are a
 * different feature: a whole layer following a motion path, not glyphs laid
 * along a curve.) So the tool reported success, changed nothing, and taught the
 * model that the type had been shaped — after which it moved on and never
 * revisited it.
 *
 * A tool the engine cannot honour is worse than a missing one: it costs a turn,
 * it consumes the model's belief, and it is invisible in the output because the
 * layer still renders, just straight. Same reasoning as the desktop key vault
 * refusing to store a key the local proxy cannot spend.
 *
 * Type on a path is a real gap and it is on the Phase B.5 list. When the
 * renderer can lay glyphs along a curve, this comes back with a reader behind
 * it — and `propWriteSurvival.test.ts` is where that gets asserted.
 */

export const createSkeletonRigDef: AiToolDef = {
  name: 'create_skeleton_rig',
  kind: 'write',
  description:
    'Create a 2D skeleton bone hierarchy on a layer for character rigging and kinematics. Bone x/y/rotation are ' +
    'PARENT-local (a root: layer-local); for a character from joint positions, rig_character solves them for you. ' +
    'Optional IK goals (`ik`) make a chain reach for a point: animate ikTarget.<boneId>.x / .y (pose_skeleton). ' +
    '`mesh` shapes the skin: density, expansion, grid or silhouette, how an image\'s alpha is traced, and ' +
    'preserveVolume (dual-quaternion skinning — joints bend on an arc instead of pinching).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'bones'],
    properties: {
      layerId: { type: 'string', description: 'ID of the layer to rig.' },
      mesh: {
        type: 'object',
        additionalProperties: false,
        properties: {
          density: { type: 'integer', minimum: 2, maximum: 50, description: 'Triangles across the layer.' },
          expansion: { type: 'number', minimum: 0, maximum: 200, description: 'Mesh padding past the artwork\'s edge, px.' },
          mode: { type: 'string', enum: ['grid', 'silhouette'], description: 'silhouette hugs the artwork\'s outline / alpha; grid is a uniform lattice.' },
          traceAccuracy: { type: 'number', minimum: 0, maximum: 100, description: 'Image layers: how finely the silhouette traces the alpha, % (default 60).' },
          alphaThreshold: { type: 'number', minimum: 0, maximum: 255, description: 'Image layers: the alpha a pixel must reach to count as artwork (default 32).' },
          preserveVolume: { type: 'boolean', description: 'Dual-quaternion skinning: joints keep their volume when they bend (no candy-wrapper pinch). Default off.' },
        },
        description: 'Skin mesh settings. Omitted fields take the defaults.',
      },
      bones: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'length'],
          properties: {
            id: { type: 'string', description: 'Bone ID.' },
            parentId: { type: 'string', description: 'Parent bone ID, or null if root bone.' },
            length: { type: 'number', minimum: 1, description: 'Bone length in px.' },
            x: { type: 'number', description: 'Bone local root X.' },
            y: { type: 'number', description: 'Bone local root Y.' },
            rotation: { type: 'number', description: 'Bone local rotation in degrees.' },
          },
        },
        description: 'Hierarchy of bones defining the skeleton.',
      },
      ik: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['boneId', 'x', 'y'],
          properties: {
            boneId: { type: 'string', description: 'The END bone of the chain: its tip reaches for (x, y).' },
            x: { type: 'number', description: 'Goal X, layer-local px.' },
            y: { type: 'number', description: 'Goal Y, layer-local px.' },
            chainLength: { type: 'integer', minimum: 1, maximum: 8, default: 2, description: 'Bones solved (the end bone and its ancestors). A joint keeps the side it bends to in the rest pose.' },
            pole: {
              type: 'object',
              additionalProperties: false,
              required: ['x', 'y'],
              properties: {
                x: { type: 'number', description: 'Pole X, layer-local px.' },
                y: { type: 'number', description: 'Pole Y, layer-local px.' },
              },
              description:
                'Optional pole for a two-bone chain: the middle joint (elbow / knee) bends to the SIDE of the root→goal line the pole is on. ' +
                'Animate it with ikPole.<boneId>.x / .y. Without one the joint keeps the side it already bends to.',
            },
          },
        },
        description: 'IK goals.',
      },
    },
  },
};

export const poseSkeletonDef: AiToolDef = {
  name: 'pose_skeleton',
  kind: 'write',
  description:
    'Pose a skeleton over time: FK keys on bones (bone.<boneId>.rotation in degrees, .x / .y translation — each ' +
    'optional, keyed only when given), IK keys on goals (ikTarget.<boneId>.x / .y, layer px; ikPole for the ' +
    'elbow / knee side; ikMode 0 = FK, 1 = IK), each key with an ease. Read the rest pose and joint positions ' +
    'off render_rig_view first; check the result with it afterwards. rig_cycle writes an idle / wave / walk for you. ' +
    'ikMode.<boneId> is a 0..1 blend (FK → IK); `ik` keys it per IK pose.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string', description: 'ID of the rigged layer.' },
      bonePoses: {
        type: 'array',
        maxItems: 400,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['boneId', 'timeSec'],
          properties: {
            boneId: { type: 'string', description: 'ID of the bone to pose.' },
            timeSec: { type: 'number', minimum: 0, description: 'Time of keyframe in seconds.' },
            rotation: { type: 'number', description: 'Rotation angle in degrees (parent-local).' },
            x: { type: 'number', description: 'X translation offset, px.' },
            y: { type: 'number', description: 'Y translation offset, px.' },
            easing: { type: 'string', enum: ['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'hold'], default: 'easeInOut', description: 'Ease of the segment starting at this key.' },
          },
        },
        description: 'FK bone keys in time order.',
      },
      ikPoses: {
        type: 'array',
        maxItems: 400,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['boneId', 'timeSec'],
          properties: {
            boneId: { type: 'string', description: 'The chain\'s END bone (the one create_skeleton_rig / rig_character gave the IK goal).' },
            timeSec: { type: 'number', minimum: 0 },
            x: { type: 'number', description: 'Goal X, layer px.' },
            y: { type: 'number', description: 'Goal Y, layer px.' },
            poleX: { type: 'number', description: 'Pole X, layer px (the side the joint bends to).' },
            poleY: { type: 'number' },
            ik: { type: 'boolean', description: 'IK (true) or FK (false) from this key on — keys the chain\'s ikMode blend to 1 / 0.' },
            ikBlend: { type: 'number', minimum: 0, maximum: 1, description: 'The chain\'s IK/FK BLEND at this key, 0 = FK … 1 = IK (0.5 = half way), keyed with the key\'s easing so a chain hands over between IK and FK over a few frames. Wins over `ik`.' },
            easing: { type: 'string', enum: ['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'hold'], default: 'easeInOut' },
          },
        },
        description: 'IK goal / pole / switch keys in time order.',
      },
    },
  },
};

export const WRITE_TOOL_DEFS: readonly AiToolDef[] = [
  createLayerDef,
  deleteLayerDef,
  reparentLayerDef,
  reorderLayerDef,
  updateLayerDef,
  setKeyframesDef,
  removeKeyframesDef,
  setEasingDef,
  setExpressionDef,
  setLayerTimingDef,
  setAudioDef,
  paintStrokesDef,
  addEffectDef,
  updateEffectDef,
  textAnimatorDef,
  createMediaDef,
  createMediaFromAttachmentDef,
  createMaskDef,
  updateMaskDef,
  updateCompositionDef,
  applyPresetDef,
  createPuppetRigDef,
  setPuppetPinKeyframesDef,
  mergePathsDef,
  setTrimPathDef,
  addRepeaterDef,
  addPathOperatorDef,
  createSkeletonRigDef,
  poseSkeletonDef,
];

