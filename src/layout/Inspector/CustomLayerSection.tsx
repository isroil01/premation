/**
 * The inspector for a plugin-declared layer kind, rendered from its SCHEMA.
 *
 * The plugin ships no markup and no CSS. It declares types, ranges, labels and
 * enum values; the host picks the widget and owns the styling. That is not
 * politeness — a plugin that could render into the inspector could draw a
 * convincing permission prompt, and every plugin's panel would age differently
 * from the app around it.
 *
 * ── Ordinary properties, all the way down ────────────────────────────────────
 *
 * An animatable prop renders through the SAME `KeyframeRow` a native property
 * uses, addressed by `customPropPath(name)`. Nothing here reimplements
 * keyframing, easing, auto-keyframe or the graph editor; if any of that needed
 * a special case, the props would be modelled wrong.
 *
 * ── An inert layer is read-only, not empty ───────────────────────────────────
 *
 * When the plugin is missing, disabled, gone, or older than the document, the
 * panel still shows every property and its value — greyed, with a banner saying
 * why. The two failures worth avoiding are an empty panel (the user concludes
 * the layer is broken) and live-looking controls that silently discard edits
 * (worse: the user makes changes and loses them).
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Checkbox } from '@components/Checkbox';
import { ColorPicker } from '@components/ColorPicker';
import { AngleDial } from '@components/AngleDial';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import {
  customLayerComponent,
  customPropPath,
  describeState,
  isInert,
  readCustomLayer,
  resolveCustomLayer,
  type CustomLayerState,
} from '@core/plugins/customLayers';
import { findKindFor } from '@core/plugins/layerKindRegistry';
import { openPluginTab } from '@layout/Plugins/openPluginTab';
import { usePluginStore } from '@stores/pluginStore';
import { useAssetStore } from '@stores/assetStore';
import type { LayerPropSchema } from '@core/plugins/layerKindSchema';
import { KeyframeRow as KfRow } from './KeyframeRow';
import styles from './TransformSection.module.css';
import own from './CustomLayerSection.module.css';

/** `focalLength` → "Focal length". Used when the schema declares no label. */
function humanise(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function CustomLayerSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // Re-resolve when the installed set changes: uninstalling a plugin while its
  // layer is selected must flip this panel to read-only, not leave live
  // controls behind that write into nothing.
  const installed = usePluginStore((s) => s.plugins);

  const node = defaultSceneGraph.getNode(nodeId);
  const record = useMemo(() => (node ? readCustomLayer(node) : null), [node]);
  const component = useMemo(() => (node ? customLayerComponent(node) : null), [node]);

  const state: CustomLayerState | null = useMemo(() => {
    if (!record) return null;
    return resolveCustomLayer(record, {
      isInstalled: (id) => installed.some((p) => p.manifest.id === id),
      isEnabled: (id) => installed.some((p) => p.manifest.id === id && p.enabled),
      find: (pluginId, kindId) => findKindFor(pluginId, kindId),
    });
  }, [record, installed]);

  if (!record || !component || !state) return null;

  const inert = isInert(state);
  /*
    Which schema to render from.

    An ACTIVE layer renders from the registered schema. An inert one has no
    registered schema to consult — so it renders from what the DOCUMENT stored,
    which is the only description of the layer that still exists. That is the
    whole reason this panel is not empty when a plugin is missing.
  */
  const schema = state.status === 'active' ? state.kind.props : null;
  const names = schema ? Object.keys(schema) : Object.keys(record.props);

  return (
    <div className={styles.section}>
      {inert && (
        <div className={own.banner} role="status">
          <Icon name="warning" size="sm" />
          <span>{describeState(state)}</span>
          {/*
            Non-blocking, and it OFFERS rather than acts. The plugin's page is
            where install, permissions and publisher live — the same page the
            `premation://plugin/<id>` deep link opens, so a user who arrives
            from a colleague's message and a user who arrives from this banner
            land in the same place.
          */}
          {state.status === 'missing' && (
            <button
              type="button"
              className={own.bannerAction}
              onClick={() => openPluginTab(record.pluginId, record.pluginId)}
            >
              {state.reason === 'disabled' ? 'Open plugin' : 'Find plugin'}
            </button>
          )}
        </div>
      )}

      {groupsOf(names, schema).map(({ group, members }) => (
        <div key={group ?? '\u0000ungrouped'} className={styles.inlineRows}>
          {/*
            A flat section heading, never a nested tree. A plugin that could
            nest groups could hide a property inside a collapsed one the user
            never opens, which is a different thing from organising a panel.
          */}
          {group !== null && <div className={own.groupHeading}>{group}</div>}
          {members.map((name) => (
            <PropRow
              key={name}
              nodeId={nodeId}
              componentId={component.id}
              name={name}
              schema={schema?.[name] ?? null}
              stored={record.props[name]}
              allStored={record.props}
              inert={inert}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Split the declared props into their sections, preserving declaration order.
 *
 * Ungrouped props come FIRST as one unlabelled run — that is where every prop
 * written before `group` existed lands, and moving them under a heading would
 * change the panel of every plugin that never asked for one. After that,
 * sections appear in the order their first member was declared, so the author
 * controls the layout by writing the props in the order they want them.
 */
function groupsOf(
  names: readonly string[],
  schema: Record<string, LayerPropSchema> | null,
): Array<{ group: string | null; members: string[] }> {
  const order: Array<string | null> = [];
  const byGroup = new Map<string | null, string[]>();
  for (const name of names) {
    const g = schema?.[name]?.group ?? null;
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g)!.push(name);
  }
  // The ungrouped run to the top, whatever order it was discovered in.
  order.sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
  return order.map((group) => ({ group, members: byGroup.get(group)! }));
}

/** Is this property's `showIf` condition currently met? */
function isVisible(schema: LayerPropSchema | null, allStored: Record<string, unknown>): boolean {
  const cond = schema?.showIf;
  if (!cond) return true;
  /*
    Compared as STRINGS, not with `==`.

    An author writing `equals: 1` against a number prop, or `equals: "1"`, means
    the same thing and should not have to know which side of the JSON boundary
    the stored value came from. String coercion says that without reaching for
    loose equality, whose other conversions (null/undefined, arrays) are not
    ones anybody wants here.
  */
  return String(allStored[cond.prop]) === String(cond.equals);
}

function PropRow({
  nodeId, componentId, name, schema, stored, allStored, inert,
}: {
  nodeId: string;
  componentId: string;
  name: string;
  /** Null when the layer is inert — there is no live schema to read. */
  schema: LayerPropSchema | null;
  stored: unknown;
  /** Every stored prop, so `showIf` can read the sibling it names. */
  allStored: Record<string, unknown>;
  inert: boolean;
}): JSX.Element | null {
  const [raw, write] = useNodeComponentProp(defaultSceneGraph, nodeId, componentId, name);
  const value = raw ?? stored;
  /*
    `showIf`, evaluated AFTER every hook above.

    Returning before `useNodeComponentProp` would change this component's hook
    count the moment a condition flipped, which React tears the panel down for.
    The row is removed rather than disabled: a control the plugin says does not
    apply is not a control the user should be able to reason about, and greying
    it out invites them to wonder what would turn it on.
  */
  if (!isVisible(schema, allStored)) return null;
  // The declared label, never the storage name — and never the `plugin.` path,
  // which is an internal track key the user has no reason to see.
  const label = schema?.label ?? humanise(name);

  if (inert || !schema) {
    return (
      <div className={own.readonlyRow}>
        <span className={styles.popoverLabel}>{label}</span>
        <span className={own.readonlyValue}>{String(value ?? '—')}</span>
      </div>
    );
  }

  switch (schema.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : (schema.default as number);
      // Animatable numbers get the SAME row a native property uses, addressed
      // by the prefixed path. Keyframing, easing and auto-keyframe come from
      // that component; none of it is reimplemented here.
      if (schema.animatable) {
        return (
          <KfRow
            nodeId={nodeId}
            prop={customPropPath(name)}
            label={label}
            value={n}
            {...(schema.min !== undefined ? { min: schema.min } : {})}
            {...(schema.max !== undefined ? { max: schema.max } : {})}
            onStatic={(v) => write(v)}
          />
        );
      }
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <input
            type="number"
            className={own.numberInput}
            value={n}
            aria-label={label}
            {...(schema.min !== undefined ? { min: schema.min } : {})}
            {...(schema.max !== undefined ? { max: schema.max } : {})}
            {...(schema.step !== undefined ? { step: schema.step } : {})}
            onChange={(e) => write(Number(e.target.value))}
          />
        </div>
      );
    }

    case 'boolean':
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <Checkbox checked={value === true} onChange={(v) => write(v)} aria-label={label} />
        </div>
      );

    case 'enum':
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <select
            className={styles.select}
            style={{ width: 130 }}
            value={typeof value === 'string' ? value : (schema.default as string)}
            aria-label={label}
            onChange={(e) => write(e.target.value)}
          >
            {(schema.values ?? []).map((v) => (
              <option key={v} value={v}>{humanise(v)}</option>
            ))}
          </select>
        </div>
      );

    case 'color':
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <ColorPicker
            value={typeof value === 'string' ? value : (schema.default as string)}
            onChange={(hex) => write(hex)}
            aria-label={label}
          />
        </div>
      );

    case 'asset':
      return <AssetPropRow label={label} value={value} onPick={write} />;

    case 'angle':
      // A dial, not a number field: the value is degrees and unbounded, and a
      // dial is the control that makes a revolution obvious.
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <AngleDial
            value={typeof value === 'number' ? value : (schema.default as number) ?? 0}
            onChange={(deg) => write(deg)}
            aria-label={label}
          />
        </div>
      );

    case 'string':
      if (schema.multiline) {
        return (
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>{label}</span>
            <textarea
              className={own.textInput}
              rows={3}
              value={typeof value === 'string' ? value : ''}
              aria-label={label}
              maxLength={512}
              onChange={(e) => write(e.target.value)}
            />
          </div>
        );
      }
      return (
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <input
            type="text"
            className={own.textInput}
            value={typeof value === 'string' ? value : ''}
            aria-label={label}
            maxLength={512}
            onChange={(e) => write(e.target.value)}
          />
        </div>
      );
  }
  // A schema type this build does not know (a plugin written against a newer
  // prop-schema). Hiding the row beats rendering a control that lies.
  return null;
}

/**
 * The picker behind an `asset` property.
 *
 * This row was read-only until now — `PLUGINS.md` listed "no asset picker" as a
 * known gap, and it was the one that made the type close to useless: a plugin
 * could SET an asset, but the user it was declared for could not choose one, so
 * every asset prop needed the plugin to have some other way of knowing which
 * image was wanted.
 *
 * A `<select>` rather than a thumbnail grid, deliberately. The row is 130px in
 * a property popover, the same width the `enum` case works in, and a grid there
 * would be a second asset browser competing with the real Assets panel. What
 * the slot needs is "which of my images is this", which is a list.
 *
 * Only images are offered because `assetKind` can only be `'image'` — the
 * schema refuses anything else, on the grounds that it is the only kind a
 * plugin can be handed. Filtering here rather than listing everything and
 * failing on selection keeps that rule in one place the user can see.
 *
 * An id whose asset is GONE (deleted from the project, or a document opened
 * elsewhere) still renders, as its bare id and marked missing, rather than
 * silently resetting to "None". A reference that quietly becomes empty is a
 * property the user has to notice was lost; one that says "missing" is a
 * property they can fix.
 */
function AssetPropRow({
  label,
  value,
  onPick,
}: {
  label: string;
  value: unknown;
  onPick: (v: string | null) => void;
}): JSX.Element {
  const assets = useAssetStore((s) => s.assets);
  const images = useMemo(() => assets.filter((a) => a.type === 'image'), [assets]);
  const current = typeof value === 'string' && value ? value : '';
  const missing = current !== '' && !images.some((a) => a.id === current);

  return (
    <div className={styles.popoverRow}>
      <span className={styles.popoverLabel}>{label}</span>
      <select
        className={styles.select}
        style={{ width: 130 }}
        value={current}
        aria-label={label}
        onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">None</option>
        {missing && <option value={current}>{`${current} (missing)`}</option>}
        {images.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </div>
  );
}
