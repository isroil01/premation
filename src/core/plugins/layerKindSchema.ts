/**
 * Layer kinds a plugin invents, declared in its manifest.
 *
 * This is the mechanism by which a plugin adds something the editor was never
 * designed for — by DECLARING into the system rather than reaching past it. A
 * declared kind gets real animatable properties: they appear in the timeline
 * and the graph editor, they take keyframes and expressions, and they are
 * driven by the same machinery native properties are. The plugin ships a
 * schema, not a widget.
 *
 * ── The render story is part of the schema, deliberately ─────────────────────
 *
 * A layer that cannot draw is either a controller or a puppeteer of real
 * layers, and which one it is changes everything downstream — what the document
 * stores, what happens when the plugin is missing, what the viewport shows. So
 * `render` is required and has exactly three supported values:
 *
 *   `"none"`   A controller. It draws nothing itself; its animatable properties
 *              exist to drive other layers through expressions or the plugin's
 *              own logic. Shown as a null-style gizmo, present in the layer
 *              tree, selectable, keyframable.
 *
 *   `"proxy"`  The plugin maintains a subtree of NATIVE layers as children, and
 *              the host renders those. The custom layer is the authored,
 *              animatable interface; the children are its output. This is what
 *              makes a document survive the plugin being uninstalled — the
 *              children are ordinary layers and keep rendering.
 *
 *   `"shader"` The kind draws itself, from an effect the plugin also declares.
 *              Live as of API 4 — it was a reserved value refused with a
 *              VERSION message before that, which is why an author who tried it
 *              early was told "not supported in this version" rather than
 *              "unknown render strategy". Those are different problems.
 *
 *              What a document stores for one of these is the kind and its
 *              props, exactly as for `"none"`. The difference from `"proxy"` is
 *              what survives an uninstall: a proxy leaves ordinary layers
 *              behind and keeps rendering, a shader kind does not draw at all
 *              without the plugin that provides its shader. That is a real cost
 *              and authors should pick `"proxy"` when the output can be
 *              expressed as native layers.
 *
 * ── Why only some types animate ──────────────────────────────────────────────
 *
 * `number`, `color` and `boolean` may be `animatable`. A string keyframe is not
 * something the interpolator can do, and accepting one here would push the
 * failure to the graph editor — at which point the author has already shipped a
 * plugin whose property silently refuses to animate.
 *
 * Everything here is validated WITHOUT executing anything, and validated on
 * both sides: this host and `motion-back`'s publish-time validator, against one
 * shared fixture corpus.
 */

/** How a kind gets on screen. See the module comment. */
export type LayerRenderStrategy = 'none' | 'proxy' | 'shader';

/**
 * Reserved render strategies, refused with a VERSION message rather than an
 * unknown-value one — those are different problems with different fixes.
 *
 * Empty as of API 4, when 'shader' became real. Kept as the mechanism, for the
 * same reason RESERVED_CONTRIBUTION_KEYS is.
 */
export const RESERVED_RENDER_STRATEGIES: readonly string[] = [];

export const RENDER_STRATEGIES = ['none', 'proxy', 'shader'] as const;

/** What a declared property may be. */
export type LayerPropType = 'number' | 'string' | 'boolean' | 'enum' | 'color' | 'asset';

export const LAYER_PROP_TYPES = ['number', 'string', 'boolean', 'enum', 'color', 'asset'] as const;

/**
 * Types the animation engine can interpolate.
 *
 * `color` is here because the engine already animates colour channels; `string`
 * and `enum` are not, and `asset` is a reference rather than a value.
 */
export const ANIMATABLE_PROP_TYPES = ['number', 'color', 'boolean'] as const;

export interface LayerPropSchema {
  type: LayerPropType;
  /** Required, and validated against its own constraints at INSTALL time. */
  default: unknown;
  /** Shown in the inspector. Falls back to a humanised prop name. */
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Required for `enum`, forbidden otherwise. */
  values?: string[];
  /** Only `number`, `color` and `boolean` may set this. */
  animatable?: boolean;
  /** Only for `asset`: which kind of asset this slot takes. */
  assetKind?: 'image';
}

export interface LayerKindContribution {
  /** Plugin-local. The host namespaces it as `<pluginId>.<id>`. */
  id: string;
  label: string;
  icon?: string;
  render: LayerRenderStrategy;
  /** Monotonic. Bumped when the prop shape changes; drives `onMigrateLayer`. */
  schemaVersion: number;
  props: Record<string, LayerPropSchema>;
}

/*
 * Caps.
 *
 * Not arbitrary: every declared prop becomes an inspector row, a potential
 * timeline track and a key in every document that uses the kind. A plugin with
 * 400 props on 60 kinds is not a plugin the editor can render, and finding that
 * out at render time means finding it out in a user's project.
 */
export const MAX_KINDS_PER_PLUGIN = 16;
export const MAX_PROPS_PER_KIND = 32;

/** Kind ids and prop names: camelCase, no dots (the host joins on dots). */
const KIND_ID_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const PROP_NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate one declared property.
 *
 * The `default` check is the one that earns its place. A default that violates
 * its own `min`/`max`, or is not a member of its own `enum`, produces a layer
 * that is invalid the instant it is created — and the author does not find out
 * until a user creates one, because nothing before that ever reads the value.
 *
 * Exported so `effectSchema.ts` validates effect parameters with the SAME code
 * rather than a second implementation of the same rules. Effect params have the
 * shape layer-kind props have precisely so an animatable one becomes an
 * ordinary track with no new machinery in the animation engine — and two
 * validators over one shape is how that stops being true.
 */
export function parseProp(
  at: string,
  name: string,
  raw: unknown,
  errors: string[],
): LayerPropSchema | null {
  if (!PROP_NAME_RE.test(name)) {
    errors.push(`"${at}" must be camelCase letters and digits, starting with a lowercase letter (1–32 characters).`);
    return null;
  }
  if (!isPlainObject(raw)) {
    errors.push(`"${at}" must be an object.`);
    return null;
  }

  const type = raw.type;
  if (typeof type !== 'string' || !(LAYER_PROP_TYPES as readonly string[]).includes(type)) {
    errors.push(`"${at}.type" must be one of: ${LAYER_PROP_TYPES.join(', ')}.`);
    return null;
  }
  const t = type as LayerPropType;

  const animatable = raw.animatable === true;
  if (animatable && !(ANIMATABLE_PROP_TYPES as readonly string[]).includes(t)) {
    // Refused here rather than in the graph editor. An author who ships this
    // finds out from a user that the property does not animate.
    errors.push(
      `"${at}.animatable" is only supported for ${ANIMATABLE_PROP_TYPES.join(', ')} properties — "${t}" cannot be keyframed.`,
    );
    return null;
  }

  const out: LayerPropSchema = { type: t, default: undefined };

  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 48) {
      errors.push(`"${at}.label", when present, must be a string of 1–48 characters.`);
      return null;
    }
    out.label = raw.label.trim();
  }

  if (t === 'enum') {
    const values = raw.values;
    if (!Array.isArray(values) || values.length === 0 || values.length > 32
      || values.some((v) => typeof v !== 'string' || !v)) {
      errors.push(`"${at}.values" must be a non-empty array of up to 32 strings.`);
      return null;
    }
    if (new Set(values).size !== values.length) {
      errors.push(`"${at}.values" contains duplicates.`);
      return null;
    }
    out.values = values as string[];
  } else if (raw.values !== undefined) {
    errors.push(`"${at}.values" is only meaningful for an enum property.`);
    return null;
  }

  if (t === 'number') {
    for (const key of ['min', 'max', 'step'] as const) {
      const v = raw[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`"${at}.${key}", when present, must be a finite number.`);
        return null;
      }
      out[key] = v;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
      errors.push(`"${at}.min" is greater than "${at}.max".`);
      return null;
    }
    if (out.step !== undefined && out.step <= 0) {
      errors.push(`"${at}.step" must be greater than zero.`);
      return null;
    }
  } else if (raw.min !== undefined || raw.max !== undefined || raw.step !== undefined) {
    errors.push(`"${at}.min"/"max"/"step" are only meaningful for a number property.`);
    return null;
  }

  if (t === 'asset') {
    const kind = raw.assetKind ?? 'image';
    if (kind !== 'image') {
      errors.push(`"${at}.assetKind" must be "image" — it is the only asset kind a plugin can be handed.`);
      return null;
    }
    out.assetKind = 'image';
  } else if (raw.assetKind !== undefined) {
    errors.push(`"${at}.assetKind" is only meaningful for an asset property.`);
    return null;
  }

  if (animatable) out.animatable = true;

  // The default, last, so it is checked against everything above it.
  //
  // An `asset` slot is the one type whose default is legitimately absent: there
  // is no asset id a package can name that exists in someone else's project.
  if (t === 'asset') {
    if (raw.default !== undefined && raw.default !== null) {
      errors.push(`"${at}.default" cannot be set for an asset property — an asset id means nothing in another project.`);
      return null;
    }
    out.default = null;
    return out;
  }

  if (raw.default === undefined) {
    errors.push(`"${at}.default" is required.`);
    return null;
  }
  const problem = defaultProblem(t, raw.default, out);
  if (problem) {
    errors.push(`"${at}.default" ${problem}`);
    return null;
  }
  out.default = raw.default;
  return out;
}

/** Why a default is not a valid value of its own property, or null. */
function defaultProblem(t: LayerPropType, value: unknown, schema: LayerPropSchema): string | null {
  switch (t) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number.';
      if (schema.min !== undefined && value < schema.min) return `is below "min" (${schema.min}).`;
      if (schema.max !== undefined && value > schema.max) return `is above "max" (${schema.max}).`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false.';
    case 'string':
      if (typeof value !== 'string') return 'must be a string.';
      return value.length <= 512 ? null : 'must be 512 characters or fewer.';
    case 'enum':
      if (typeof value !== 'string') return 'must be a string.';
      return schema.values?.includes(value) ? null : `must be one of the declared values: ${schema.values?.join(', ')}.`;
    case 'color':
      // Accepts `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()`. Validated as
      // a FORMAT, not parsed: the renderer does the parsing, and a value that
      // reaches it having never been checked is the case worth preventing.
      if (typeof value !== 'string') return 'must be a colour string.';
      return /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(value) ? null : 'must be a colour like "#ff8800" or "rgba(…)".';
    default:
      return null;
  }
}

/**
 * Validate `contributes.layerKinds`.
 *
 * Returns what survived, pushing a message per rejection. A kind with a bad
 * property is dropped whole rather than partially accepted: half a schema
 * renders half an inspector, and the author debugs a missing row instead of
 * reading an error.
 */
export function parseLayerKinds(
  raw: unknown,
  errors: string[],
  icons: ReadonlySet<string>,
): LayerKindContribution[] {
  const out: LayerKindContribution[] = [];
  if (raw === undefined) return out;

  if (!Array.isArray(raw)) {
    errors.push('"contributes.layerKinds" must be an array.');
    return out;
  }
  if (raw.length > MAX_KINDS_PER_PLUGIN) {
    errors.push(`"contributes.layerKinds" declares ${raw.length} kinds; the limit is ${MAX_KINDS_PER_PLUGIN}.`);
    return out;
  }

  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const at = `contributes.layerKinds[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`"${at}" must be an object.`);
      return;
    }

    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!KIND_ID_RE.test(id)) {
      errors.push(`"${at}.id" must be camelCase letters and digits, starting with a lowercase letter (1–32 characters).`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`"${at}.id" duplicates an earlier layer kind "${id}".`);
      return;
    }
    seen.add(id);

    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label || label.length > 48) {
      errors.push(`"${at}.label" is required (1–48 characters).`);
      return;
    }

    if (entry.icon !== undefined && (typeof entry.icon !== 'string' || !icons.has(entry.icon))) {
      errors.push(`"${at}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
      return;
    }

    const render = entry.render;
    if ((RESERVED_RENDER_STRATEGIES as readonly unknown[]).includes(render)) {
      // A version message, not an unknown-value message. Those are different
      // problems: one is "wait for Phase 4", the other is "you made a typo".
      errors.push(`"${at}.render": "${String(render)}" is reserved and not supported in this version.`);
      return;
    }
    if (typeof render !== 'string' || !(RENDER_STRATEGIES as readonly string[]).includes(render)) {
      errors.push(`"${at}.render" must be one of: ${RENDER_STRATEGIES.join(', ')}.`);
      return;
    }

    const schemaVersion = entry.schemaVersion;
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      errors.push(`"${at}.schemaVersion" is required and must be a whole number of 1 or more.`);
      return;
    }

    if (!isPlainObject(entry.props)) {
      errors.push(`"${at}.props" must be an object.`);
      return;
    }
    const names = Object.keys(entry.props);
    if (names.length === 0) {
      errors.push(`"${at}.props" declares nothing. A layer kind with no properties has no interface to author.`);
      return;
    }
    if (names.length > MAX_PROPS_PER_KIND) {
      errors.push(`"${at}.props" declares ${names.length} properties; the limit is ${MAX_PROPS_PER_KIND}.`);
      return;
    }

    const props: Record<string, LayerPropSchema> = {};
    let ok = true;
    for (const name of names) {
      const parsed = parseProp(`${at}.props.${name}`, name, entry.props[name], errors);
      if (!parsed) { ok = false; continue; }
      props[name] = parsed;
    }
    if (!ok) return;

    out.push({
      id,
      label,
      ...(typeof entry.icon === 'string' ? { icon: entry.icon } : {}),
      render: render as LayerRenderStrategy,
      schemaVersion,
      props,
    });
  });

  return out;
}

/** `<pluginId>.<kindId>` — the only spelling that appears in a document. */
export function namespacedKind(pluginId: string, kindId: string): string {
  return `${pluginId}.${kindId}`;
}

/**
 * Split a namespaced kind back into its parts.
 *
 * A plugin id contains dots too, so the split is on the LAST one — `id.slice`
 * from the first dot would attribute `studio.acme.easing-lab.depthImage` to a
 * plugin called `studio`.
 */
export function splitKind(kind: string): { pluginId: string; kindId: string } | null {
  const at = kind.lastIndexOf('.');
  if (at <= 0 || at === kind.length - 1) return null;
  const pluginId = kind.slice(0, at);
  const kindId = kind.slice(at + 1);
  if (!KIND_ID_RE.test(kindId)) return null;
  return { pluginId, kindId };
}

/** Every declared property's value, at its declared default. */
export function defaultProps(kind: LayerKindContribution): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(kind.props)) out[name] = schema.default;
  return out;
}
