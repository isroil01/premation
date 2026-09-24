/**
 * Essential Properties — the instance-side control for a placed composition.
 *
 * AE splits this in two: you promote a property in the source comp, then set it
 * per placement. Promotion lives on the source root (`__essentialProps`); right-
 * click a property in the source inspector → "Add to Essential Properties".
 *
 * When the source has published at least one property, this panel lists only
 * those (any depth — the engine already resolves grandchild overrides). When
 * none are published yet, it keeps the pre-promotion fallback: every overridable
 * prop on each direct child, so existing projects keep working.
 *
 * The set is no longer numeric-only, so a row's editor depends on the property's
 * KIND (`OVERRIDE_PROP_KINDS`): a number field, a colour picker, or a text
 * input. Reading the inherited value differs by kind too — see `inheritedValue`,
 * where colour is the awkward case because it is stored as a hex string but
 * animated as three separate channels.
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Input } from '@components/Input';
import type { LayerInfo } from '@motion/engine-api';
import { useSceneRevision } from '@stores/sceneStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { documentMirror, type DocumentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorProperty, useMirrorTrackWatch } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { childOrderOf } from '@core/mirror/layerTree';
import {
  COMP_OVERRIDES_PATH,
  inheritedOverrideValue,
  layerToCompSeconds,
  mirrorCompOverrides,
  overrideSourceLayers,
} from '@core/mirror/compOverrides';
import {
  OVERRIDABLE_PROPS,
  readEssentialProps,
  overrideKey,
  parseOverrideKey,
  isOverridableProp,
  isValidOverrideValue,
  OVERRIDE_PROP_KINDS,
  type OverridableProp,
  type OverrideValue,
} from '@core/scene/compInstanceOverrides';
import { edit } from '@core/engine/uiEdits';
import { useGesture } from '@hooks/useGesture';
import { useEngineEdit } from './useEngineEdit';
import { jsonFieldCommands } from './layerFieldEdits';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';

const LABEL: Record<OverridableProp, string> = {
  x: 'X', y: 'Y', rotation: 'Rotation', scaleX: 'Scale X', scaleY: 'Scale Y', opacity: 'Opacity',
  text: 'Source Text', fill: 'Fill', color: 'Color',
};

/** Sensible identity for a property no component declares. */
const FALLBACK: Record<OverridableProp, OverrideValue> = {
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
  text: '', fill: '#ffffff', color: '#ffffff',
};

const UNIT: Partial<Record<OverridableProp, string>> = { rotation: '°', opacity: '%' };

/** The tracks an inherited value is read from (numbers; the colour properties by their red channel; Source Text). */
const WATCHED_TRACKS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'fill_r', 'color_r', 'text/sourceText'];

/**
 * What this property would be WITHOUT an override: the source layer's value
 * (animated or static) from the document mirror, else the identity.
 *
 * `t` is the host's playhead, read as a time on the source layer's own
 * keyframe axis (as the section always has) and converted to the source
 * composition's time, which is the axis the mirror's values are on.
 *
 * Colour is stored as a hex string but animated as three channels; the mirror
 * has one colour property for them, so a keyframed colour reads its animated
 * value and the field agrees with the canvas.
 */
function inheritedValue(m: DocumentMirror, source: LayerInfo, prop: OverridableProp, t: number): OverrideValue {
  return inheritedOverrideValue(m, source.id, prop, layerToCompSeconds(source, t)) ?? FALLBACK[prop];
}

type LayerRow = { source: LayerInfo; props: OverridableProp[] };

/**
 * `layer/compOverrides` (json, fx.__compOverrides) with the instance's current
 * overrides (read from the mirror now) changed by `change` — the whole next
 * record; empty clears it.
 */
function overridesCommands(
  instanceId: string,
  change: (next: Record<string, OverrideValue>) => void,
): ReturnType<typeof jsonFieldCommands> {
  const next: Record<string, OverrideValue> = {};
  for (const [k, v] of mirrorCompOverrides(documentMirror(), instanceId)) next[k] = v;
  change(next);
  return jsonFieldCommands(instanceId, COMP_OVERRIDES_PATH, Object.keys(next).length > 0 ? next : null);
}

/** One override set (a value that fails the property's validation is dropped) or cleared (`undefined`). */
function overrideCommands(instanceId: string, origId: string, prop: OverridableProp, value: OverrideValue | undefined): ReturnType<typeof jsonFieldCommands> {
  return overridesCommands(instanceId, (next) => {
    const key = overrideKey(origId, prop);
    if (value === undefined || !isValidOverrideValue(prop, value)) delete next[key];
    else next[key] = value;
  });
}

function rowsForInstance(m: DocumentMirror, ref: string, promoted: ReadonlySet<string>): LayerRow[] {
  if (promoted.size > 0) {
    // Curated list — group promoted keys by source layer, keep document order
    // by walking the referenced comp so nested layers appear under their
    // natural parents rather than in bag-iteration order.
    const byId = new Map<string, OverridableProp[]>();
    for (const key of promoted) {
      const parsed = parseOverrideKey(key);
      if (!parsed || !isOverridableProp(parsed.prop)) continue;
      const list = byId.get(parsed.origNodeId) ?? [];
      list.push(parsed.prop);
      byId.set(parsed.origNodeId, list);
    }
    const rows: LayerRow[] = [];
    for (const source of overrideSourceLayers(m, ref)) {
      const props = byId.get(source.id);
      if (props && props.length > 0) rows.push({ source, props });
    }
    return rows;
  }

  // Pre-promotion fallback: every overridable prop on each direct child.
  return childOrderOf(m, ref)
    .map((id) => m.layer(id))
    .filter((source): source is LayerInfo => !!source)
    .map((source) => ({ source, props: [...OVERRIDABLE_PROPS] }));
}

export function CompOverridesSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4-gap: which properties the source comp PUBLISHES (`__essentialProps` on its root) has no API datum — the scene revision re-reads it (a `CompInfo.essentialProps` would close it).
  useSceneRevision((s) => s.rev);
  const eng = useEngineEdit();
  // A text override's typing session (first keystroke → blur) is one entry.
  const typing = useGesture();
  const time = useThrottledTime();
  const layer = useMirrorLayer(nodeId);
  // The instance's override record (re-render when it changes).
  useMirrorProperty(nodeId, COMP_OVERRIDES_PATH);
  const m = documentMirror();
  // A placed composition's source item is the comp it references.
  const ref = uiKindOf(layer) === 'comp' ? layer?.source : undefined;

  // B4-gap: the published Essential Properties (`__essentialProps`) — see above.
  const promoted = readEssentialProps(ref);
  const rows = ref ? rowsForInstance(m, ref, promoted) : [];
  // The referenced comp's stack, and every listed source layer's values.
  useMirrorKeys(ref ? [`comp:${ref}`, `order:${ref}`, 'layers'] : []);
  useMirrorTrackWatch(rows.map((r) => r.source.id), WATCHED_TRACKS);
  if (!layer || !ref) return null;
  if (rows.length === 0) return null;

  const overrides = mirrorCompOverrides(m, nodeId);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Essential Properties</span>
        <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
          {overrides.size > 0
            ? `${overrides.size} overridden`
            : promoted.size > 0
              ? `${promoted.size} published`
              : 'inheriting'}
        </span>
      </div>
      {promoted.size === 0 && (
        <p style={{ margin: '0 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}>
          Right-click a property in the source composition to publish it here.
        </p>
      )}

      {rows.map(({ source, props }) => {
        const layerOverrides = props.filter((p) =>
          overrides.has(overrideKey(source.id, p)));
        return (
          <div key={source.id} style={{ marginBottom: 6 }}>
            <div className={styles.row}>
              <span
                className={styles.label}
                style={{ color: 'var(--color-text-secondary)' }}
                title={source.name || source.id}
              >
                {source.name || source.id}
              </span>
              {layerOverrides.length > 0 && (
                <button
                  type="button"
                  className={styles.select}
                  style={{ width: 'auto', padding: '0 8px', fontSize: 'var(--font-size-micro)' }}
                  onClick={() => {
                    void edit('Reset Overrides', overridesCommands(nodeId, (next) => {
                      for (const k of Object.keys(next)) if (parseOverrideKey(k)?.origNodeId === source.id) delete next[k];
                    }));
                  }}
                  aria-label={`Reset all overrides on ${source.name || source.id}`}
                >
                  Reset
                </button>
              )}
            </div>
            {props.map((prop) => {
              const key = overrideKey(source.id, prop);
              const overridden = overrides.has(key);
              const value = overridden
                ? overrides.get(key)!
                : inheritedValue(m, source, prop, time);
              const kind = OVERRIDE_PROP_KINDS[prop];
              return (
                <div className={ta.paramRow} key={prop}>
                  <button
                    type="button"
                    onClick={() => {
                      void edit(overridden ? 'Clear Override' : 'Override Property', overrideCommands(nodeId, source.id, prop, overridden ? undefined : value));
                    }}
                    title={overridden ? 'Clear override (inherit from the source comp)' : 'Override for this instance only'}
                    aria-label={`${overridden ? 'Clear' : 'Set'} ${LABEL[prop]} override on ${source.name || source.id}`}
                    style={{
                      width: 14, height: 14, padding: 0, borderRadius: '50%', cursor: 'pointer',
                      border: '1px solid var(--color-border)',
                      background: overridden ? 'var(--color-accent)' : 'transparent',
                    }}
                  />
                  <span className={ta.paramLabel}>{LABEL[prop]}</span>
                  {kind === 'number' ? (
                    <ValueField
                      value={value as number}
                      {...eng.scrub(`Override ${LABEL[prop]}`)}
                      onChange={(v) => eng.send(`Override ${LABEL[prop]}`, overrideCommands(nodeId, source.id, prop, v))}
                      unit={UNIT[prop]}
                      precision={2}
                      aria-label={`${LABEL[prop]} on ${source.name || source.id}`}
                    />
                  ) : kind === 'color' ? (
                    <div {...eng.press(`Override ${LABEL[prop]}`)} style={{ display: 'contents' }}>
                    <ColorPicker
                      value={String(value)}
                      onChange={(hex) => eng.send(`Override ${LABEL[prop]}`, overrideCommands(nodeId, source.id, prop, hex))}
                      compact
                      // No alpha: the override is written back as the layer's
                      // colour string, and the renderer's colour channels carry
                      // no alpha of their own — an 8-digit hex would set an
                      // opacity that nothing reads.
                      alpha={false}
                      aria-label={`${LABEL[prop]} on ${source.name || source.id}`}
                    />
                    </div>
                  ) : (
                    <Input
                      size="sm"
                      value={String(value)}
                      onChange={(e) => {
                        if (!typing.isActive()) typing.begin(`Override ${LABEL[prop]}`);
                        typing.send(overrideCommands(nodeId, source.id, prop, e.target.value));
                      }}
                      onBlur={() => { void typing.end(); }}
                      fullWidth
                      aria-label={`${LABEL[prop]} on ${source.name || source.id}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export default CompOverridesSection;
