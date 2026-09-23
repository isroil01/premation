/**
 * D1b: the C++ engine's property catalog DATA is generated from the TypeScript
 * registries, never hand-copied: every effect definition (204 of them), the
 * property-metadata table, layer styles, shape operators, polystar, text
 * animators/selectors, paint, label colours, animation presets and the layer
 * factory's non-trivial component data. The C++ side
 * (native/engine/src/core/catalog_data.cpp) embeds the JSON this writes and
 * ports the RULES that consume it (propertyMeta.ts, propertyTree.ts,
 * props.ts…).
 *
 * `GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog` rewrites the file; without
 * it this test fails when the checked-in data is stale, exactly like the
 * engine-api codegen staleness test.
 */

import { readFileSync, writeFileSync } from 'node:fs';
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
import { listPresets } from '@core/animation/animationPresets';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { defaultPrimitiveSpec, makePrimitiveComponent } from '@core/scene/primitiveLayer';
import { defaultTextSize } from '@core/scene/textDefaults';
import { Project3D } from '@motion/scene';
import { COMMANDS } from '@motion/engine-api';
import { BLEND_MODES } from '@core/effects/blendMode';

const OUT = path.resolve(__dirname, '../../../../native/engine/src/core/generated/catalog_data.inc');

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
    // G1: the static fields of text layers, animators and selectors (fields.ts / fields.cpp).
    fields: { text: TEXT_FIELDS, animator: ANIMATOR_FIELDS, animatorOptional: ANIMATOR_OPTIONAL_FIELDS, selector: SELECTOR_FIELDS, selectorKindParams: SELECTOR_KIND_PARAMS },
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

function render(): string {
  const json = JSON.stringify(data());
  // Raw-string chunks well under every compiler's literal limit; the C++ side concatenates them.
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += 12000) chunks.push(json.slice(i, i + 12000));
  const body = chunks.map((c) => `R"PMCAT(${c})PMCAT"`).join(',\n');
  return [
    '// GENERATED by src/core/engine/__tests__/crossEngineCatalog.test.ts (GEN_NATIVE_CATALOG=1). Do not edit.',
    '// The TypeScript registries the C++ engine\'s property catalog is built from (D1b).',
    `// ${json.length} bytes of JSON in ${chunks.length} chunks.`,
    'static const char* const kCatalogJsonChunks[] = {',
    body,
    '};',
    '',
  ].join('\r\n');
}

jest.useFakeTimers();

test('the C++ catalog data is generated from the TypeScript registries and is current', () => {
  const text = render();
  if (process.env.GEN_NATIVE_CATALOG === '1') {
    writeFileSync(OUT, text);
    return;
  }
  // Compare with line endings normalised: git's autocrlf checks the generated
  // .inc out as CRLF on Windows (and LF elsewhere) — only the content matters.
  const lf = (s: string): string => s.replace(/\r\n/g, '\n');
  const have = readFileSync(OUT, 'utf8');
  expect(lf(have) === lf(text)).toBe(true);
});
