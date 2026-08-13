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

      <div className={styles.inlineRows}>
        {names.map((name) => (
          <PropRow
            key={name}
            nodeId={nodeId}
            componentId={component.id}
            name={name}
            schema={schema?.[name] ?? null}
            stored={record.props[name]}
            inert={inert}
          />
        ))}
      </div>
    </div>
  );
}

function PropRow({
  nodeId, componentId, name, schema, stored, inert,
}: {
  nodeId: string;
  componentId: string;
  name: string;
  /** Null when the layer is inert — there is no live schema to read. */
  schema: LayerPropSchema | null;
  stored: unknown;
  inert: boolean;
}): JSX.Element {
  const [raw, write] = useNodeComponentProp(defaultSceneGraph, nodeId, componentId, name);
  const value = raw ?? stored;
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
      // Read-only for now: choosing an asset is a picker this slice does not
      // build. Shown rather than hidden, because a declared slot the inspector
      // omits reads to the author as a schema the host ignored.
      return (
        <div className={own.readonlyRow}>
          <span className={styles.popoverLabel}>{label}</span>
          <span className={own.readonlyValue}>
            {typeof value === 'string' && value ? value : 'No image assigned'}
          </span>
        </div>
      );

    case 'string':
    default:
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
}
