/**
 * Custom layers in a document — the part of layer kinds that outlives the
 * plugin that made them.
 *
 * ── This breaks an invariant, deliberately ───────────────────────────────────
 *
 * Until now, documents never referenced plugins. That was a real guarantee: a
 * `.premation` file opened the same way on every machine, and uninstalling a
 * plugin could not affect anything a user had saved. Layer kinds end it. A
 * project containing a `studio.acme.lab.depthImage` layer names a plugin, and
 * there is no way to give plugins first-class layers without that.
 *
 * So the guarantee is replaced rather than dropped, and this file is where the
 * replacement lives:
 *
 *   1. **The layer is never lost.** Not on uninstall, not on open without the
 *      plugin, not on save-and-reopen. Silently discarding a user's work
 *      because software is missing is the worst outcome available, and it is
 *      the one that happens by default if nobody writes this code.
 *
 *   2. **It still renders.** A `proxy` kind keeps its generated children as
 *      ORDINARY layers in the document. They are what draws, so a document
 *      opened without the plugin looks right — that is the entire reason
 *      `proxy` is the strategy that ships first and `shader` is not.
 *
 *   3. **It says so.** Inert, read-only, with an offer to install what is
 *      missing. Not a silent half-working layer whose properties appear to
 *      accept edits that nothing applies.
 *
 *   4. **Keyframes survive untouched.** They live on the node's properties like
 *      any others, so nothing here has to preserve them — which is the point.
 *      A design where this file had to copy keyframes around would be a design
 *      where they get lost.
 *
 * ── Storage shape ────────────────────────────────────────────────────────────
 *
 * One component per custom layer, whose TYPE carries the namespace:
 *
 *     { type: 'pluginLayer:studio.acme.lab.depthImage',
 *       props: { __kind, __pluginId, __kindId, __schemaVersion,
 *                focal: 50, mode: 'parallax', source: null } }
 *
 * The declared properties sit directly on that component, under their own
 * names, because that is what makes them ORDINARY properties: `writeProp`
 * already addresses `(nodeId, componentId, propName)`, and the animation engine
 * keys on the same triple. Nothing in the timeline or the graph editor needs a
 * case for them — and if it ever does, the props are modelled wrong.
 *
 * Namespacing by component type rather than by prop prefix means two plugins
 * that both declare `focal` cannot collide, and neither can read the other's
 * value, without any name mangling in between.
 */

import type { Component, SceneNode } from '../types';
import {
  defaultProps,
  splitKind,
  type LayerKindContribution,
  type LayerPropSchema,
} from './layerKindSchema';

/** The reserved keys on a custom-layer component. Never a declared prop name. */
export const CUSTOM_KIND_KEY = '__kind';
export const CUSTOM_PLUGIN_KEY = '__pluginId';
export const CUSTOM_KIND_ID_KEY = '__kindId';
export const CUSTOM_SCHEMA_KEY = '__schemaVersion';
/** Set on every generated child of a `proxy` layer. See `isPluginOwned`. */
export const OWNED_BY_KEY = '__ownedByPlugin';

const RESERVED_KEYS = new Set([
  CUSTOM_KIND_KEY, CUSTOM_PLUGIN_KEY, CUSTOM_KIND_ID_KEY, CUSTOM_SCHEMA_KEY, OWNED_BY_KEY,
  // `__cid` is the scene graph's own component-id key.
  '__cid',
]);

export const COMPONENT_TYPE_PREFIX = 'pluginLayer:';

/** What a document records about one custom layer, independent of any plugin. */
export interface CustomLayerRecord {
  /** `<pluginId>.<kindId>`, exactly as it appears in the document. */
  kind: string;
  pluginId: string;
  kindId: string;
  schemaVersion: number;
  /** Authored values, by declared name. Reserved keys excluded. */
  props: Record<string, unknown>;
}

/** A plugin a document depends on, as recorded at save time. */
export interface DocumentPluginReference {
  id: string;
  /** The version that wrote it. Advisory — used to explain, never to gate. */
  version?: string;
  publisher?: string;
  /** Which of its kinds this document actually uses. */
  kinds: string[];
}

export function componentTypeFor(kind: string): string {
  return `${COMPONENT_TYPE_PREFIX}${kind}`;
}

/**
 * The animation path for a declared property.
 *
 * Tracks are keyed `(nodeId, propPath)` — a flat string, the same way `x`,
 * `opacity` and `rotation` are keyed. A custom prop uses the same mechanism
 * with no special case anywhere in the engine, which is the whole test of
 * whether these are modelled as ordinary properties.
 *
 * The `plugin.` prefix exists for exactly one reason: a plugin is free to
 * declare a prop called `opacity`, and an unprefixed path would then address
 * the layer's NATIVE opacity track. Nothing native starts with `plugin.`, and a
 * node carries at most one custom-layer component, so one fixed prefix is
 * enough — a per-plugin one would make the path depend on which plugin is
 * installed, which is the one thing a stored track key must never do.
 */
export const CUSTOM_PROP_PREFIX = 'plugin.';

export function customPropPath(propName: string): string {
  return `${CUSTOM_PROP_PREFIX}${propName}`;
}

/**
 * Is this property path reserved for plugin-declared props?
 *
 * The prefix closes the collision from one side — a plugin declaring `opacity`
 * gets `plugin.opacity` and cannot touch the layer's native opacity track. This
 * closes it from the OTHER side: a native property named `plugin.something`,
 * added years from now by someone who has never read this file, would address a
 * plugin's track and the symptom would appear in a plugin nobody was editing.
 *
 * Enforced where a property name arrives as DATA rather than as code — a
 * plugin's `scene.setProperty` — and swept for in source by
 * `reservedPropPrefix.test.ts`.
 */
export function isReservedPropPath(path: string): boolean {
  return path.startsWith(CUSTOM_PROP_PREFIX);
}

/** The declared prop a track belongs to, or null for a native path. */
export function propNameFromPath(path: string): string | null {
  return path.startsWith(CUSTOM_PROP_PREFIX) ? path.slice(CUSTOM_PROP_PREFIX.length) : null;
}

/** Read the custom-layer record off a node, or null if it is a native layer. */
export function readCustomLayer(node: SceneNode): CustomLayerRecord | null {
  for (const c of node.components ?? []) {
    if (!c.type?.startsWith(COMPONENT_TYPE_PREFIX)) continue;
    const props = (c.props ?? {}) as Record<string, unknown>;
    const kind = props[CUSTOM_KIND_KEY];
    if (typeof kind !== 'string') continue;

    // Trust the stored ids, but fall back to splitting the kind — a document
    // written by an older build, or hand-edited, may carry only the kind.
    const split = splitKind(kind);
    const pluginId = typeof props[CUSTOM_PLUGIN_KEY] === 'string'
      ? (props[CUSTOM_PLUGIN_KEY] as string)
      : split?.pluginId;
    const kindId = typeof props[CUSTOM_KIND_ID_KEY] === 'string'
      ? (props[CUSTOM_KIND_ID_KEY] as string)
      : split?.kindId;
    if (!pluginId || !kindId) continue;

    const schemaVersion = typeof props[CUSTOM_SCHEMA_KEY] === 'number'
      ? (props[CUSTOM_SCHEMA_KEY] as number)
      : 1;

    const authored: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!RESERVED_KEYS.has(k)) authored[k] = v;
    }
    return { kind, pluginId, kindId, schemaVersion, props: authored };
  }
  return null;
}

/** The component that carries a custom layer, for a writer that needs its id. */
export function customLayerComponent(node: SceneNode): Component | null {
  return (node.components ?? []).find((c) => c.type?.startsWith(COMPONENT_TYPE_PREFIX)) ?? null;
}

/**
 * Build the component for a new custom layer.
 *
 * Declared props are seeded from the schema's defaults and then overlaid with
 * anything the caller supplied, VALIDATED — a plugin creating a layer with an
 * out-of-range number would otherwise write a value its own inspector cannot
 * display and its own schema forbids.
 */
export function buildCustomLayerComponent(
  pluginId: string,
  kind: LayerKindContribution,
  overrides: Record<string, unknown> = {},
  componentId = `plugin-${kind.id}`,
): Component {
  const props: Record<string, unknown> = {
    [CUSTOM_KIND_KEY]: `${pluginId}.${kind.id}`,
    [CUSTOM_PLUGIN_KEY]: pluginId,
    [CUSTOM_KIND_ID_KEY]: kind.id,
    [CUSTOM_SCHEMA_KEY]: kind.schemaVersion,
    ...defaultProps(kind),
  };
  for (const [name, value] of Object.entries(overrides)) {
    const schema = kind.props[name];
    if (!schema) continue; // A prop the kind does not declare is not stored.
    if (coerce(schema, value) !== undefined) props[name] = coerce(schema, value);
  }
  return { id: componentId, type: componentTypeFor(`${pluginId}.${kind.id}`), props };
}

/**
 * A whole scene node for a new custom layer.
 *
 * The Transform component carries `__kind` set to the NAMESPACED kind, which is
 * what makes the rest of the editor treat this as a layer at all — and what the
 * scene graph falls back on: an unrecognised kind maps to the engine's `null`
 * type, a transform-only container. That is the right base for both strategies.
 * A `render: 'none'` layer is a null gizmo; a `proxy` layer is a container its
 * generated children hang from.
 */
export function buildCustomLayerNode(
  id: string,
  pluginId: string,
  kind: LayerKindContribution,
  opts: { name?: string; x?: number; y?: number; props?: Record<string, unknown> } = {},
): SceneNode {
  const x = opts.x ?? 160;
  const y = opts.y ?? 120;
  const namespaced = `${pluginId}.${kind.id}`;
  return {
    id,
    name: opts.name?.trim().slice(0, 80) || kind.label,
    children: [],
    parent: null,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [CUSTOM_KIND_KEY]: namespaced,
          x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, opacity: 100,
        },
      },
      buildCustomLayerComponent(pluginId, kind, opts.props ?? {}, `${id}_p`),
    ],
  };
}

/**
 * A value that is valid for `schema`, or undefined.
 *
 * Clamps rather than rejects a number in range terms — a plugin that asks for
 * 120 on a 0–100 property meant the maximum, and refusing the whole write would
 * leave the layer at its default with nothing saying why. A value of the wrong
 * TYPE is a different thing and is refused.
 */
export function coerce(schema: LayerPropSchema, value: unknown): unknown {
  switch (schema.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      let v = value;
      if (schema.min !== undefined) v = Math.max(schema.min, v);
      if (schema.max !== undefined) v = Math.min(schema.max, v);
      return v;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'string':
      return typeof value === 'string' && value.length <= 512 ? value : undefined;
    case 'enum':
      return typeof value === 'string' && schema.values?.includes(value) ? value : undefined;
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(value) ? value : undefined;
    case 'asset':
      if (value === null) return null;
      return typeof value === 'string' && value.length > 0 && value.length < 256 ? value : undefined;
    default:
      return undefined;
  }
}

/** True for a layer generated and maintained by a plugin's `proxy` kind. */
export function isPluginOwned(node: SceneNode): boolean {
  return (node.components ?? []).some(
    (c) => typeof (c.props as Record<string, unknown> | undefined)?.[OWNED_BY_KEY] === 'string',
  );
}

/** Which plugin owns this generated layer, if any. */
export function ownerOf(node: SceneNode): string | null {
  for (const c of node.components ?? []) {
    const owner = (c.props as Record<string, unknown> | undefined)?.[OWNED_BY_KEY];
    if (typeof owner === 'string') return owner;
  }
  return null;
}

/**
 * Every plugin a set of nodes depends on.
 *
 * Written into the document so the editor can tell a user what is missing and
 * deep-link them to install it. Without it, a document with a custom layer can
 * say "this layer needs a plugin" and not which one — the kind string carries
 * the id, but not the version or the publisher, and an id alone is not enough
 * to explain or to fetch.
 *
 * ── Why `recorded` exists ────────────────────────────────────────────────────
 *
 * Version and publisher used to come from the INSTALLED copy and nowhere else,
 * so they were simply absent when the plugin was not installed. That is the
 * honest answer the first time a document is written on such a machine — but
 * not the second. A project whose document already said `version: 1.4.0`,
 * opened and re-saved without the plugin, lost that field permanently, and the
 * user who most needs to know which version is missing is exactly the one whose
 * machine does not have it.
 *
 * So what the document already recorded is kept when nothing better is known.
 * An installed copy still wins: it is current, and a recorded value may be
 * years old.
 */
export function collectPluginReferences(
  nodes: readonly SceneNode[],
  installed: ReadonlyMap<string, { version: string; author?: string }> = new Map(),
  recorded: ReadonlyMap<string, { version?: string; publisher?: string }> = new Map(),
): DocumentPluginReference[] {
  const byPlugin = new Map<string, DocumentPluginReference>();
  for (const node of nodes) {
    const record = readCustomLayer(node);
    if (!record) continue;
    let ref = byPlugin.get(record.pluginId);
    if (!ref) {
      const meta = installed.get(record.pluginId);
      const prior = recorded.get(record.pluginId);
      const version = meta?.version ?? prior?.version;
      const publisher = meta?.author ?? prior?.publisher;
      ref = {
        id: record.pluginId,
        ...(version ? { version } : {}),
        ...(publisher ? { publisher } : {}),
        kinds: [],
      };
      byPlugin.set(record.pluginId, ref);
    }
    if (!ref.kinds.includes(record.kindId)) ref.kinds.push(record.kindId);
  }
  // Sorted, so a document's plugin list does not reshuffle between saves and
  // produce a diff on every write.
  for (const ref of byPlugin.values()) ref.kinds.sort();
  return [...byPlugin.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** How a custom layer resolves against what is installed right now. */
export type CustomLayerState =
  | { status: 'active'; record: CustomLayerRecord; kind: LayerKindContribution }
  /** The plugin is not installed, or is installed but disabled. */
  | { status: 'missing'; record: CustomLayerRecord; reason: 'not-installed' | 'disabled' }
  /** Installed, but it no longer declares this kind. */
  | { status: 'unknown-kind'; record: CustomLayerRecord }
  /** The plugin's schema is NEWER: it gets a chance to migrate. */
  | { status: 'needs-migration'; record: CustomLayerRecord; kind: LayerKindContribution }
  /** The plugin's schema is OLDER than the document's. */
  | { status: 'downgrade'; record: CustomLayerRecord; kind: LayerKindContribution };

export interface InstalledKindLookup {
  /** The kind, or null when the plugin is absent or does not declare it. */
  find(pluginId: string, kindId: string): LayerKindContribution | null;
  /** False when the plugin is installed but the user turned it off. */
  isEnabled(pluginId: string): boolean;
  isInstalled(pluginId: string): boolean;
}

/**
 * What should happen to this layer, given what is installed.
 *
 * Every non-`active` state is INERT: props read-only, plugin logic not run.
 * The distinction between them is what the banner says and what button it
 * offers, which is the difference between a user who installs the missing
 * plugin and one who concludes the file is corrupt.
 *
 * A DOWNGRADE — the document's schema is newer than the installed plugin's — is
 * marked inert rather than guessed at. The older plugin has no way to know what
 * the newer one stored, so running it would silently discard whatever the newer
 * schema added.
 */
export function resolveCustomLayer(
  record: CustomLayerRecord,
  lookup: InstalledKindLookup,
): CustomLayerState {
  if (!lookup.isInstalled(record.pluginId)) return { status: 'missing', record, reason: 'not-installed' };
  if (!lookup.isEnabled(record.pluginId)) return { status: 'missing', record, reason: 'disabled' };

  const kind = lookup.find(record.pluginId, record.kindId);
  if (!kind) return { status: 'unknown-kind', record };

  if (kind.schemaVersion > record.schemaVersion) return { status: 'needs-migration', record, kind };
  if (kind.schemaVersion < record.schemaVersion) return { status: 'downgrade', record, kind };
  return { status: 'active', record, kind };
}

/** True when the layer is present but must not be edited or run. */
export function isInert(state: CustomLayerState): boolean {
  return state.status !== 'active';
}

/** One sentence for the layer's banner. Plain, and specific about the fix. */
export function describeState(state: CustomLayerState): string {
  switch (state.status) {
    case 'active':
      return '';
    case 'missing':
      return state.reason === 'disabled'
        ? `“${state.record.pluginId}” is disabled, so this layer is not running. Its properties are read-only until you enable it.`
        : `This layer needs the plugin “${state.record.pluginId}”, which is not installed. It still renders, and its properties are read-only until you install it.`;
    case 'unknown-kind':
      return `“${state.record.pluginId}” no longer provides a “${state.record.kindId}” layer. This layer still renders, and is read-only.`;
    case 'needs-migration':
      return `“${state.record.pluginId}” has updated this layer type. Its properties are read-only until the update is applied.`;
    case 'downgrade':
      return `This layer was made with a newer version of “${state.record.pluginId}”. Update the plugin to edit it; it is read-only meanwhile.`;
  }
}

/** Where a failed or partial migration parks the values it could not carry. */
export const QUARANTINE_KEY = '__preMigration';

export interface MigrationResult {
  /** What to store on the component now. */
  props: Record<string, unknown>;
  /** Prop names that did NOT come from the migration's own return value. */
  dropped: string[];
  /**
   * The pre-migration state, when anything was dropped. Store it on the node so
   * the user can get their values back; absent when the migration was clean.
   */
  quarantine?: { schemaVersion: number; props: Record<string, unknown> };
}

/**
 * Accept — or refuse — what `onMigrateLayer` returned.
 *
 * A migration is plugin code producing values the host will store, so its
 * output is validated exactly like any other plugin input.
 *
 * ── What happens to a prop the migration did not mention ─────────────────────
 *
 * It is KEPT, if it still validates. This is the correction to the first
 * version of this function, which defaulted everything the migration did not
 * return — including props the migration was never about. Schema v1→v2 adds a
 * field, the plugin's `onMigrateLayer` throws, and `focal` — valid, unchanged,
 * carefully animated — resets to 50. The user loses authored work because a
 * plugin author shipped a bad migration.
 *
 * The two errors are not symmetric. Keeping a still-valid value is occasionally
 * wrong (the plugin may have reused the name for something else, which nothing
 * here can detect); discarding it is always destructive. So: keep what
 * validates, default only what does not.
 *
 * ── Nothing is ever unrecoverable ────────────────────────────────────────────
 *
 * When anything is dropped, the pre-migration props are QUARANTINED on the node
 * rather than only reported. Recoverable beats reported: a warning tells a user
 * their layer changed, and leaves them nothing to do about it.
 *
 * Keyframes are not this function's concern and that is the point — they live
 * on the node's properties, keyed by (nodeId, componentId, propName), and
 * nothing here touches them. A design where this function had to move them
 * around is a design where they get lost.
 */
export function applyMigration(
  kind: LayerKindContribution,
  returned: unknown,
  /** The values the layer held before the migration ran. */
  previous: Record<string, unknown> = {},
): MigrationResult {
  const props = defaultProps(kind);
  const dropped: string[] = [];

  // 1. Carry forward everything that still validates. A prop the migration did
  //    not mention is not a prop the migration rejected.
  for (const [name, schema] of Object.entries(kind.props)) {
    if (!(name in previous)) continue;
    const carried = coerce(schema, previous[name]);
    if (carried !== undefined) props[name] = carried;
  }

  const usable = !!returned && typeof returned === 'object' && !Array.isArray(returned);

  // 2. Overlay what the migration returned, where it validates.
  if (usable) {
    for (const [name, value] of Object.entries(returned as Record<string, unknown>)) {
      const schema = kind.props[name];
      // A name the kind does not declare is reported: the plugin thinks it
      // migrated something that will not be stored.
      if (!schema) { dropped.push(name); continue; }
      const ok = coerce(schema, value);
      if (ok === undefined) { dropped.push(name); continue; }
      props[name] = ok;
    }
  }

  // 3. Anything the new schema requires that neither step produced landed on a
  //    default. Say so — that is the set the user may want back.
  for (const name of Object.keys(kind.props)) {
    if (dropped.includes(name)) continue;
    const cameFromMigration = usable && name in (returned as Record<string, unknown>);
    const cameFromPrevious = name in previous && coerce(kind.props[name]!, previous[name]) !== undefined;
    if (!cameFromMigration && !cameFromPrevious) dropped.push(name);
  }

  if (dropped.length === 0) return { props, dropped };
  return {
    props,
    dropped: [...new Set(dropped)].sort(),
    // Only the authored values, never the bookkeeping keys — this is a
    // recovery record, not a second copy of the layer.
    quarantine: { schemaVersion: kind.schemaVersion, props: { ...previous } },
  };
}
