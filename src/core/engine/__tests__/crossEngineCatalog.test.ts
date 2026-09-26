/**
 * The C++ engine's property catalog is engine-owned data —
 * native/engine/catalog/*.json (embedded by catalog/embed_catalog.cmake, read
 * by native/engine/src/core/catalog_data.cpp) plus the schema's command table
 * (native/protocol/generated/commands.json). It was frozen from the TypeScript
 * registries below: every effect definition, the property-metadata table,
 * layer styles, shape operators, polystar, text animators/selectors, paint,
 * label colours, animation presets and the layer factory's component data.
 *
 * Until the TypeScript engine is deleted (docs/TS_ENGINE_REMOVAL.md phase 4,
 * which deletes this test with it) the two copies must not drift: this test
 * fails when a TS registry and the C++ catalog disagree. Fix it by editing
 * the JSON (the engine is the owner) or the registry — never by regenerating.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EFFECT_DEFS } from '@core/effects/effects';
import { resolvePropertyMeta, staticPropertyPaths } from '@core/inspector/propertyMeta';
import {
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  LAYER_STYLE_EFFECT_TYPE,
  LAYER_STYLE_LABEL,
  defaultGlassStyle,
  DEFAULT_DROP_SHADOW,
  DEFAULT_OUTER_GLOW,
  DEFAULT_INNER_SHADOW,
  DEFAULT_INNER_GLOW,
  DEFAULT_SATIN,
  DEFAULT_BEVEL,
  DEFAULT_COLOR_OVERLAY,
  DEFAULT_GRADIENT_OVERLAY,
  DEFAULT_STROKE_STYLE,
} from '@core/effects/layerStyles';
import { PATH_OP_CATALOG, pathOpParamSpecs, defaultPathOpOf, PATHOP_PARAMS } from '@core/scene/pathOps';
import { polystarParamSpecs, POLYSTAR_PARAMS, defaultPolystar } from '@core/scene/polystar';
import { ANIMATOR_PARAMS, SELECTOR_PARAMS, OPTIONAL_ANIMATOR_PROPERTIES, defaultAnimator } from '@core/text/textAnimators';
import { defaultSelector } from '@core/text/textSelectors';
import { PAINT_OPTION_KEYS, PAINT_CLONE_KEYS, PAINT_TRANSFORM_KEYS, PAINT_KEY_LABEL, PAINT_KEY_UNIT, PAINT_PERCENT_KEYS } from '@core/paint/paintProps';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { STROKE_TRACK_PARAMS, STROKE_DASH_PARAMS } from '@core/rendering/strokeTracks';
import { MASK_PROPERTY_KEYS } from '@core/effects/mask';
import { TEXT_PATH_PARAMS } from '@core/text/textPath';
import { TEXT_FIELDS, ANIMATOR_FIELDS, ANIMATOR_OPTIONAL_FIELDS, SELECTOR_FIELDS, SELECTOR_KIND_PARAMS } from '@core/text/textFields';
import { LAYER_FIELDS } from '../layerFieldSpecs';
import { LATENT_PROPS } from '../latentPropSpecs';
import { EFFECT_FIELDS, STYLE_FIELDS, GLASS_PROPERTIES } from '../effectFieldSpecs';
import { RIG_PROPS } from '../rigSpecs';
import { CONTROL_SPECS } from '../controlSpecs';
import { listPresets } from '@core/animation/animationPresets';
import { DEFAULT_PARTICLE_CONFIG, PARTICLE_COLOR_KEYS, PARTICLE_NUMERIC_KEYS } from '@core/particles/particleSim';
import { PATHOP_FIELDS, POLYSTAR_FIELDS } from '../shapeFieldSpecs';
import { defaultPrimitiveSpec, makePrimitiveComponent } from '@core/scene/primitiveLayer';
import { defaultTextSize } from '@core/scene/textDefaults';
import { Project3D } from '@motion/scene';
import { COMMANDS } from '@motion/engine-api';
import { BLEND_MODES } from '@core/effects/blendMode';

/** A deep copy without any `id` field (random ids in the TypeScript defaults). */
function noIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(noIds);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'id') out[k] = noIds(x);
    return out;
  }
  return v;
}

/** JSON with functions dropped and numbers exact (JSON.stringify is shortest-round-trip). */
function data(): unknown {
  const effects = EFFECT_DEFS.map((d) => ({
    type: d.type,
    label: d.label,
    ...(d.gpuOnly ? { gpuOnly: true } : {}),
    params: d.params.map((p) => ({
      key: p.key, label: p.label, type: p.type,
      ...(p.options ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
      ...(p.group !== undefined ? { group: p.group } : {}),
      ...(p.unit !== undefined ? { unit: p.unit } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.precision !== undefined ? { precision: p.precision } : {}),
      ...(p.noneLabel !== undefined ? { noneLabel: p.noneLabel } : {}),
      // Absent stays absent: `defaultParams` copies an undefined default, which
      // JSON.stringify then drops — a null would be written out.
      ...(p.default !== undefined ? { default: p.default } : {}),
    })),
    ...(d.newInstanceParams ? { newInstanceParams: d.newInstanceParams } : {}),
  }));
  const staticMeta: Record<string, unknown> = {};
  for (const p of staticPropertyPaths()) {
    const m = resolvePropertyMeta(p);
    staticMeta[p] = {
      label: m.label, group: m.group, type: m.type, unit: m.unit,
      ...(m.min !== undefined ? { min: m.min } : {}),
      ...(m.max !== undefined ? { max: m.max } : {}),
      defaultValue: m.defaultValue,
      ...(m.keyframeable === false ? { keyframeable: false } : {}),
      ...(m.displayScale !== undefined ? { displayScale: m.displayScale } : {}),
    };
  }
  const pathOps: Record<string, unknown> = {};
  for (const entry of PATH_OP_CATALOG as ReadonlyArray<{ type: string }>) {
    const t = entry.type;
    let def: Record<string, unknown> | null = null;
    try {
      def = { ...(defaultPathOpOf(t as never) as unknown as Record<string, unknown>) };
      delete def.id;
    } catch {
      def = null;
    }
    pathOps[t] = { params: pathOpParamSpecs(t as never), default: def };
  }
  return {
    effects,
    staticMeta,
    layerStyles: {
      numberParams: LAYER_STYLE_NUMBER_PARAMS,
      colorParams: LAYER_STYLE_COLOR_PARAMS,
      effectType: LAYER_STYLE_EFFECT_TYPE,
      label: LAYER_STYLE_LABEL,
      defaults: {
        glass: defaultGlassStyle(),
        dropShadow: DEFAULT_DROP_SHADOW,
        outerGlow: DEFAULT_OUTER_GLOW,
        innerShadow: DEFAULT_INNER_SHADOW,
        innerGlow: DEFAULT_INNER_GLOW,
        satin: DEFAULT_SATIN,
        bevel: DEFAULT_BEVEL,
        colorOverlay: DEFAULT_COLOR_OVERLAY,
        gradientOverlay: DEFAULT_GRADIENT_OVERLAY,
        stroke: DEFAULT_STROKE_STYLE,
      },
    },
    pathOps,
    pathOpParams: PATHOP_PARAMS,
    polystar: {
      params: POLYSTAR_PARAMS,
      star: polystarParamSpecs('star'),
      polygon: polystarParamSpecs('polygon'),
      default: defaultPolystar('star'),
    },
    animators: {
      animatorParams: ANIMATOR_PARAMS,
      selectorParams: SELECTOR_PARAMS,
      optional: OPTIONAL_ANIMATOR_PROPERTIES,
      // Ids are minted by the engine; the TypeScript defaults carry random ones.
      defaultAnimator: noIds(defaultAnimator()),
      selectors: {
        range: noIds(defaultSelector('range')),
        wiggly: noIds(defaultSelector('wiggly')),
        expression: noIds(defaultSelector('expression')),
      },
    },
    paint: {
      optionKeys: PAINT_OPTION_KEYS, cloneKeys: PAINT_CLONE_KEYS, transformKeys: PAINT_TRANSFORM_KEYS,
      label: PAINT_KEY_LABEL, unit: PAINT_KEY_UNIT, percentKeys: [...PAINT_PERCENT_KEYS],
    },
    strokeTracks: { params: STROKE_TRACK_PARAMS, dash: STROKE_DASH_PARAMS },
    // B3z: the latent numeric properties (latentPropSpecs.ts).
    latent: LATENT_PROPS,
    // G1: the static fields of text layers, animators and selectors (fields.ts / fields.cpp).
    fields: {
      text: TEXT_FIELDS, animator: ANIMATOR_FIELDS, animatorOptional: ANIMATOR_OPTIONAL_FIELDS, selector: SELECTOR_FIELDS, selectorKindParams: SELECTOR_KIND_PARAMS,
      // B3z: the layer fields (layerFieldSpecs.ts).
      layer: LAYER_FIELDS,
      // B3z WS-R: puppet / skeleton properties (rigSpecs.ts ⇄ rig.cpp).
      rig: RIG_PROPS,
      // B3: expression controls (controlSpecs.ts ⇄ controls.cpp).
      control: CONTROL_SPECS,
      // B3z-a: effect Compositing Options fields, layer-style switches, Glass (effectFieldSpecs.ts).
      effect: EFFECT_FIELDS, style: STYLE_FIELDS, glass: GLASS_PROPERTIES,
      // B3z-a (E1): path-operator / Polystar fields (shapeFieldSpecs.ts), the particle emitter's keys (particleProps.ts).
      pathOp: PATHOP_FIELDS, polystar: POLYSTAR_FIELDS,
      particle: { numeric: PARTICLE_NUMERIC_KEYS, color: PARTICLE_COLOR_KEYS },
    },
    maskKeys: MASK_PROPERTY_KEYS,
    textPathParams: TEXT_PATH_PARAMS,
    labels: LABEL_COLORS,
    // The schema's command classes (edit / control / io), by wire id.
    commands: Object.entries(COMMANDS).map(([type, c]) => ({ id: c.id, kind: c.kind, type })),
    // The blend modes the renderer implements (blendMode.ts `isBlendMode`).
    blendModes: BLEND_MODES.map((b) => b.mode),
    presets: listPresets().map((p) => {
      const { applyFn, animators, ...rest } = p;
      return { ...rest, ...(animators ? { animators: noIds(animators) } : {}), ...(applyFn ? { hasApplyFn: true } : {}) };
    }),
    factory: {
      particle: DEFAULT_PARTICLE_CONFIG,
      primitive: makePrimitiveComponent('@ID@', defaultPrimitiveSpec('box')),
      textSize: defaultTextSize(),
      camera1920: Project3D.defaultCamera(1920, 1080),
    },
  };
}

const CATALOG_DIR = path.resolve(__dirname, '../../../../native/engine/catalog');
const COMMANDS_JSON = path.resolve(__dirname, '../../../../native/protocol/generated/commands.json');

/** The catalog the C++ engine embeds, composed the way embed_catalog.cmake composes it. */
function engineCatalog(keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const file = k === 'commands' ? COMMANDS_JSON : path.join(CATALOG_DIR, `${k}.json`);
    out[k] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return out;
}

jest.useFakeTimers();

test('the TypeScript registries still match the C++ catalog (native/engine/catalog)', () => {
  const ts = data() as Record<string, unknown>;
  const engine = engineCatalog(Object.keys(ts));
  // Part by part, so a failure names the part that drifted.
  for (const k of Object.keys(ts)) expect({ [k]: engine[k] }).toEqual({ [k]: JSON.parse(JSON.stringify(ts[k])) });
  // Same bytes once serialised: key order matters to the C++ side (menus, row order).
  expect(JSON.stringify(engine)).toBe(JSON.stringify(ts));
});
