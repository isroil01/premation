/**
 * Parameters a plugin contributes to a layer it does not own.
 *
 * `CustomLayerSection` is the inspector of a layer a plugin INVENTED; this is
 * the other half — a plugin's controls attached to an ordinary shape, text or
 * image layer, which is what an author reaches for when the plugin is a tool
 * rather than a layer type. Both render from a declared schema and neither
 * renders a line of the plugin's markup, for the reason that file opens with: a
 * plugin that could draw into the inspector could draw a convincing permission
 * prompt.
 *
 * ── Built out of the inspector's own rows, not out of new ones ───────────────
 *
 * Every parameter here is a `MultiPropertyRow`, a `MultiPropertyPairRow` or a
 * `PropertyRow` in the inspector layout. That is not tidiness: it is what makes
 * a plugin's parameter a FIRST-CLASS property. The stopwatch, the keyframe
 * navigator, the mini lane, the `=` expression editor, the pick-whip, the
 * right-click menu, the multi-selection aggregate with `—` for mixed values and
 * one undo entry per gesture — none of it is reimplemented here, and all of it
 * works on a plugin's slider because the row is the same row Position uses.
 *
 * The one thing this file owns is the three controls that had no shared row:
 * the enum `<select>`, the button, and the read-only status line.
 *
 * ── Multi-selection ──────────────────────────────────────────────────────────
 *
 * Numeric parameters aggregate across the selection through
 * `useMultiPropertyField`, like every other row. The rest — enum, colour,
 * checkbox — write to every selected layer the panel applies to, in one undo
 * entry. `appliesToSelection` keeps the section off a selection whose layers the
 * panel does not all cover, so an edit here always reaches everything on screen.
 *
 * ── Engine API (B3z) ─────────────────────────────────────────────────────────
 *
 * Every write is an engine command on `plugin/<slug>/<panel>/<name>` (a point
 * is ONE vec2 / vec3), prefixed — on a layer that has never had the panel — by
 * the panel group seeded with every declared default (pluginParamEdits.ts): one
 * undo entry per click, one per drag.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@components/Checkbox';
import { ColorPicker } from '@components/ColorPicker';
import { Icon } from '@components/Icon';
import { PropertyRow } from '@components/PropertyRow';
import { ValueField } from '@components/ValueField';
import { asCommandId } from '@app-types/common';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorPluginParam, pluginParamApiPath } from '@core/mirror/pluginParams';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorProperty, useRetainTree } from '@hooks/useMirror';
import { usePluginStore } from '@stores/pluginStore';
import {
  humaniseParamName,
  paramAxes,
  paramIsAnimatable,
  pluginParamPath,
  type PluginInspectorPanelContribution,
  type PluginParamSchema,
} from '@core/plugins/uiParams';
import { onPluginStatusChanged, pluginStatus } from '@core/plugins/uiStatus';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { useInspectorSelection } from './inspectorSelection';
import { MultiPropertyRow } from './MultiPropertyRow';
import { MultiPropertyPairRow } from './MultiPropertyPairRow';
import { numericParamCommands, paramStopwatchCommands, staticParamCommands } from './pluginParamEdits';
import { useEngineEdit } from './useEngineEdit';
import styles from './PluginParamsSection.module.css';

/** One applicable panel, with the plugin that declared it. */
export interface AppliedPluginPanel {
  pluginId: string;
  pluginName: string;
  panel: PluginInspectorPanelContribution;
}

/**
 * The panels that belong on one layer, in plugin-name order.
 *
 * ENABLED plugins only. A disabled plugin's section disappearing is what makes
 * the Plugins panel's toggle mean something — and its VALUES stay in the
 * document, so turning it back on restores the section with everything in it.
 *
 * B4: the layer's kind comes from the document mirror — a plugin layer kind's
 * id (`<pluginId>.<kindId>`, `LayerInfo.generator`), else the editor kind.
 */
export function pluginPanelsFor(nodeId: string): AppliedPluginPanel[] {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return [];
  const kind: string = layer.generator || (uiKindOf(layer) ?? 'shape');
  const out: AppliedPluginPanel[] = [];
  for (const entry of usePluginStore.getState().plugins) {
    if (!entry.enabled) continue;
    for (const panel of entry.manifest.contributes.inspector) {
      // An empty `appliesTo` is "every layer", which is what a manifest that
      // says nothing means — see `uiParams.ts`.
      if (panel.appliesTo.length > 0 && !panel.appliesTo.includes(kind)) continue;
      out.push({ pluginId: entry.manifest.id, pluginName: entry.manifest.name, panel });
    }
  }
  return out.sort((a, b) => a.pluginName.localeCompare(b.pluginName)
    || a.panel.title.localeCompare(b.panel.title));
}

/** Does any installed plugin contribute parameters to this layer? */
export function hasPluginParamsSection(nodeId: string): boolean {
  return pluginPanelsFor(nodeId).length > 0;
}

/**
 * The section's title: the panel's own when there is exactly one, and a
 * collective heading when several plugins contribute to the same layer.
 *
 * Worth the branch. One plugin is the overwhelmingly common case, and
 * "Plugin parameters" as the header of a section whose only content is titled
 * "3D Lift" is a level of indirection with nothing in it.
 */
export function pluginParamsTitle(nodeId: string): string {
  const panels = pluginPanelsFor(nodeId);
  return panels.length === 1 ? panels[0]!.panel.title : 'Plugin parameters';
}

export function PluginParamsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Re-resolve when a plugin is enabled, disabled or removed while its section
  // is on screen: live-looking controls that write into nothing are the failure
  // `CustomLayerSection` calls out, and this section has the same one.
  const installed = usePluginStore((s) => s.plugins);
  // The layer's header (its kind) decides which panels apply.
  const layer = useMirrorLayer(nodeId);
  const panels = useMemo(() => pluginPanelsFor(nodeId), [nodeId, installed, layer]);
  const nodeIds = useInspectorSelection(nodeId);

  if (panels.length === 0) return null;

  return (
    <div>
      {panels.map(({ pluginId, pluginName, panel }) => (
        <div key={`${pluginId}:${panel.id}`}>
          {/* The attribution is not optional, and it is not conditional on
              there being two plugins. A parameter that looks like the editor's
              own is a parameter the user blames the editor for. */}
          <div className={styles.panelHeading}>
            <Icon name={(panel.icon as never) ?? 'plugin'} size="sm" />
            <span>{panel.title}</span>
            <span className={styles.panelOwner}>{pluginName}</span>
          </div>
          <PanelRows pluginId={pluginId} panel={panel} nodeId={nodeId} nodeIds={nodeIds} />
        </div>
      ))}
    </div>
  );
}

/** One panel's parameters, split into its declared groups. */
function PanelRows({
  pluginId, panel, nodeId, nodeIds,
}: {
  pluginId: string;
  panel: PluginInspectorPanelContribution;
  nodeId: string;
  nodeIds: ReadonlyArray<string>;
}): JSX.Element {
  // The `showIf` conditions read sibling values, so the panel follows exactly
  // the siblings they name (their mirror properties; B4) — each row subscribes
  // to the one prop it draws itself.
  useRetainTree(nodeId);
  const showIfKeys = useMemo(() => {
    const names = new Set<string>();
    for (const p of panel.params) if (p.showIf) names.add(p.showIf.param);
    return [...names].map((n) => `prop:${nodeId}|${pluginParamApiPath(pluginId, panel.id, n)}`);
  }, [nodeId, pluginId, panel]);
  useMirrorKeys(showIfKeys);

  const groups = useMemo(() => {
    const order: Array<string | null> = [];
    const byGroup = new Map<string | null, PluginParamSchema[]>();
    for (const p of panel.params) {
      const g = p.group ?? null;
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g)!.push(p);
    }
    // Ungrouped first, as one unlabelled run — the same rule a layer kind's
    // props follow, so a panel written before it declared groups is unchanged.
    order.sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
    return order.map((group) => ({ group, members: byGroup.get(group)! }));
  }, [panel]);

  return (
    <>
      {groups.map(({ group, members }) => (
        <div key={group ?? ' ungrouped'}>
          {group !== null && <div className={styles.groupHeading}>{group}</div>}
          {members
            .filter((schema) => isVisible(schema, pluginId, panel, nodeId))
            .map((schema) => (
              <ParamRow
                key={schema.name}
                pluginId={pluginId}
                panel={panel}
                schema={schema}
                nodeId={nodeId}
                nodeIds={nodeIds}
              />
            ))}
        </div>
      ))}
    </>
  );
}

/**
 * Is this parameter's `showIf` condition met?
 *
 * Compared as STRINGS, for the reason `CustomLayerSection` records: an author
 * writing `equals: 1` against a number and `equals: "1"` means the same thing
 * and should not have to know which side of the JSON boundary the stored value
 * came from.
 */
function isVisible(
  schema: PluginParamSchema,
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  nodeId: string,
): boolean {
  const cond = schema.showIf;
  if (!cond) return true;
  const sibling = panel.params.find((p) => p.name === cond.param);
  if (!sibling) return true;
  return String(mirrorPluginParam(documentMirror(), nodeId, pluginId, panel.id, sibling)) === String(cond.equals);
}

interface RowProps {
  pluginId: string;
  panel: PluginInspectorPanelContribution;
  schema: PluginParamSchema;
  nodeId: string;
  nodeIds: ReadonlyArray<string>;
}

function ParamRow(props: RowProps): JSX.Element | null {
  const { schema } = props;
  switch (schema.type) {
    case 'slider':
    case 'number':
    case 'angle':
      // Animatable and static are different COMPONENTS, not a branch inside
      // one: the animatable row is a full multi-selection field with a
      // stopwatch, and the static one must not offer to keyframe a parameter
      // whose schema says it cannot be keyframed.
      return paramIsAnimatable(schema) ? <NumericRow {...props} /> : <StaticNumberRow {...props} />;
    case 'point':
    case 'point3d':
      return <PointRow {...props} />;
    case 'checkbox':
      return <CheckboxRow {...props} />;
    case 'enum':
      return <EnumRow {...props} />;
    case 'color':
      return <ColorRow {...props} />;
    case 'button':
      return <ButtonRow {...props} />;
    case 'status':
      return <StatusRow {...props} />;
    default:
      // A type this build does not know, from a plugin written against a newer
      // vocabulary. Nothing beats a control that lies about what it edits.
      return null;
  }
}

/** Read/write one parameter across the selection, for the shared rows. */
function useParamAccess(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  axis?: string,
): PropertyAccess {
  return useMemo(() => ({
    read: (id: string) => {
      const v = mirrorPluginParam(documentMirror(), id, pluginId, panel.id, schema, axis);
      return typeof v === 'number' ? v : undefined;
    },
    // The row's writes and stopwatch, path-addressed and self-seeding (the
    // param is not in the catalog until its panel group exists).
    engine: {
      commands: (writes, opts) => numericParamCommands(pluginId, panel, schema, axis, writes, opts),
      stopwatchOn: (ids, seconds) => paramStopwatchCommands(pluginId, panel, schema, ids, seconds),
    },
  }), [pluginId, panel, schema, axis]);
}

/**
 * An ANIMATABLE slider, number or angle.
 *
 * All three are one row, because to the engine they are one thing: a number on
 * a track. What separates them is the METADATA — the unit, the range, the step,
 * and for `logarithmic` a step recomputed from the current value — and that
 * lives in `propertyMeta`'s resolver, where the timeline and the graph editor
 * read it too, so a plugin's parameter is named and ranged the same way
 * wherever it appears.
 */
function NumericRow({ pluginId, panel, schema, nodeId }: RowProps): JSX.Element {
  const access = useParamAccess(pluginId, panel, schema);
  return (
    <MultiPropertyRow
      nodeId={nodeId}
      prop={pluginParamPath(pluginId, panel.id, schema.name)}
      label={schema.label ?? humaniseParamName(schema.name)}
      access={access}
    />
  );
}

/**
 * The same number WITHOUT a stopwatch, for a parameter the plugin did not
 * declare animatable.
 *
 * A `ValueField` rather than the multi-selection row, and the difference is the
 * point: offering to keyframe a parameter nothing samples over time would put a
 * track in the timeline that changes nothing, which is a worse outcome than a
 * plainer row. The unit, range and step still come from the same resolver.
 */
function StaticNumberRow(props: RowProps): JSX.Element {
  const { pluginId, panel, schema, nodeId, nodeIds } = props;
  const value = usePrimaryValue(pluginId, panel, schema, nodeId);
  const label = schema.label ?? humaniseParamName(schema.name);
  // Labels / range / step from the registry, fed the mirror's facts (B4).
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const meta = mirrorPropertyMeta(pluginParamPath(pluginId, panel.id, schema.name), layer, layer ? m.tree(nodeId) : undefined);
  // A drag of the field is ONE gesture (one undo entry).
  const e = useEngineEdit();
  return (
    <PropertyRow label={label} layout="inspector" compact>
      <ValueField
        value={typeof value === 'number' ? value : 0}
        onChange={(v) => e.send(`Set ${label}`, staticParamCommands(pluginId, panel, schema, nodeIds, v))}
        {...e.scrub(`Set ${label}`)}
        {...(meta.min !== undefined ? { min: meta.min } : {})}
        {...(meta.max !== undefined ? { max: meta.max } : {})}
        step={meta.step}
        unit={meta.unit || undefined}
        aria-label={label}
      />
    </PropertyRow>
  );
}

/**
 * A 2-D or 3-D point, on one row.
 *
 * `MultiPropertyPairRow` calls its field hook exactly three times whatever it
 * is handed, so a `point` and a `point3d` are the same component with a
 * different array — and the array's length is fixed by the parameter's TYPE,
 * never by anything that can change between renders.
 */
function PointRow({ pluginId, panel, schema, nodeId }: RowProps): JSX.Element {
  const ax = useParamAccess(pluginId, panel, schema, 'x');
  const ay = useParamAccess(pluginId, panel, schema, 'y');
  const az = useParamAccess(pluginId, panel, schema, 'z');
  const axes = paramAxes(schema);
  const label = schema.label ?? humaniseParamName(schema.name);
  const specs = [
    { prop: pluginParamPath(pluginId, panel.id, schema.name, 'x'), prefix: 'X', access: ax },
    { prop: pluginParamPath(pluginId, panel.id, schema.name, 'y'), prefix: 'Y', access: ay },
    ...(axes.includes('z')
      ? [{ prop: pluginParamPath(pluginId, panel.id, schema.name, 'z'), prefix: 'Z', access: az }]
      : []),
  ];
  return <MultiPropertyPairRow nodeId={nodeId} label={label} props={specs} />;
}

/**
 * Write one non-numeric parameter to every selected layer, in one undo entry.
 *
 * Non-numeric parameters have no track, so they cannot go through
 * `useMultiPropertyField` — but "one gesture, one undo, every selected layer"
 * is not a property of numbers, and a colour that only reached the primary
 * layer would be a quiet half-edit. `press` wraps a control that drags (a
 * colour picker): press → release is ONE gesture.
 */
function useWriteAll(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  nodeIds: ReadonlyArray<string>,
): { write: (value: unknown) => void; press: { onPointerDownCapture: () => void } } {
  const label = schema.label ?? humaniseParamName(schema.name);
  const e = useEngineEdit();
  const write = useCallback((value: unknown) => {
    e.send(`Set ${label}`, staticParamCommands(pluginId, panel, schema, nodeIds, value));
  }, [e, pluginId, panel, schema, nodeIds, label]);
  return useMemo(() => ({ write, press: e.press(`Set ${label}`) }), [write, e, label]);
}

/**
 * The value shown: the primary layer's, which is what every row here shows —
 * from the document mirror, re-rendering when THIS param's property changes.
 */
function usePrimaryValue(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  nodeId: string,
): unknown {
  // Subscribes (and keeps the tree loaded); the value is read from the same record.
  useMirrorProperty(nodeId, pluginParamApiPath(pluginId, panel.id, schema.name));
  return mirrorPluginParam(documentMirror(), nodeId, pluginId, panel.id, schema);
}

function CheckboxRow(props: RowProps): JSX.Element {
  const { pluginId, panel, schema, nodeId, nodeIds } = props;
  const value = usePrimaryValue(pluginId, panel, schema, nodeId);
  const { write } = useWriteAll(pluginId, panel, schema, nodeIds);
  const label = schema.label ?? humaniseParamName(schema.name);
  return (
    <PropertyRow label={label} layout="inspector" compact>
      {/* `Checkbox` forwards the native input's props, so `onChange` is handed
          the EVENT — writing the handler's argument straight through stores a
          React synthetic event where a boolean belongs. */}
      <Checkbox
        checked={value === true}
        onChange={(e) => write(e.target.checked)}
        aria-label={label}
      />
    </PropertyRow>
  );
}

function EnumRow(props: RowProps): JSX.Element {
  const { pluginId, panel, schema, nodeId, nodeIds } = props;
  const value = usePrimaryValue(pluginId, panel, schema, nodeId);
  const { write } = useWriteAll(pluginId, panel, schema, nodeIds);
  const label = schema.label ?? humaniseParamName(schema.name);
  return (
    <PropertyRow label={label} layout="inspector" compact>
      {/* The option's LABEL, never its value — an enum whose options carry
          labels is the whole reason this type is not a string list. */}
      <select
        className={styles.select}
        value={typeof value === 'string' ? value : ''}
        aria-label={label}
        onChange={(e) => write(e.target.value)}
      >
        {(schema.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </PropertyRow>
  );
}

function ColorRow(props: RowProps): JSX.Element {
  const { pluginId, panel, schema, nodeId, nodeIds } = props;
  const value = usePrimaryValue(pluginId, panel, schema, nodeId);
  const { write, press } = useWriteAll(pluginId, panel, schema, nodeIds);
  const label = schema.label ?? humaniseParamName(schema.name);
  return (
    <PropertyRow label={label} layout="inspector" compact>
      {/* Alpha is opt-in, and refused at parse time for a parameter that did
          not ask for it — a plugin reading `#ff8800` and handed `#ff8800cc`
          would silently render the wrong colour. */}
      <span {...press}>
        <ColorPicker
          value={typeof value === 'string' ? value : '#ffffff'}
          alpha={schema.alpha === true}
          onChange={(hex) => write(hex)}
          aria-label={label}
        />
      </span>
    </PropertyRow>
  );
}

/**
 * A button that runs one of the plugin's own commands.
 *
 * Through the COMMAND SYSTEM, not through a callback into the plugin: the
 * command is already registered, already namespaced, already in the palette and
 * the Plugins menu, and already the thing a `contributes.shortcuts` chord runs.
 * A second path to the same verb is a second place for it to behave differently.
 */
function ButtonRow({ pluginId, schema }: RowProps): JSX.Element {
  const label = schema.label ?? humaniseParamName(schema.name);
  return (
    <PropertyRow label="" srLabel={label} layout="inspector" compact>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => {
          getCommandSystem().execute(asCommandId(`plugin.${pluginId}.${schema.command}`));
        }}
      >
        {label}
      </button>
    </PropertyRow>
  );
}

/** A line the plugin writes and the user reads. Never saved — see `uiStatus.ts`. */
function StatusRow({ pluginId, panel, schema }: RowProps): JSX.Element {
  const [text, setText] = useState(() => pluginStatus(pluginId, panel.id, schema.name));
  useEffect(
    () => onPluginStatusChanged(() => setText(pluginStatus(pluginId, panel.id, schema.name))),
    [pluginId, panel.id, schema.name],
  );
  const label = schema.label ?? humaniseParamName(schema.name);
  return (
    <PropertyRow label={label} layout="inspector" compact>
      <span className={styles.statusValue}>{text ?? schema.text ?? '—'}</span>
    </PropertyRow>
  );
}
