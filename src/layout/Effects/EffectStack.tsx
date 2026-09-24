import { hasEffectHandles } from '@core/effects/effectHandles';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import { useState } from 'react';
/**
 * EffectStack — the applied-effects list for a layer (AE Effect Controls): each
 * effect has an enable toggle, reorder, remove, and one row per PARAMETER.
 * Numeric params are keyframeable (stopwatch → keyframes under
 * `effect.<id>.<param>`, sampled per frame by buildSnapshot).
 *
 * The panel used to render exactly one field per effect, because an effect
 * carried exactly one scalar — which is why Glow's colour and Drop Shadow's
 * angle didn't exist.
 *
 * Shared by the dedicated Effect Controls panel (left sidebar) so the stack
 * lives in exactly one component. The right-sidebar Effects tab is the library
 * you add FROM; this list is what you edit after.
 *
 * ── The AE Effect Controls treatment ────────────────────────────────────────
 * Three things AE has that a list of labelled number fields does not, all of
 * them added here:
 *
 *   `▸ Width  68.0`   Ranged numbers carry a DISCLOSURE TRIANGLE that reveals
 *                     a slider under the row. Typing 68 needs the field;
 *                     finding the value you want needs the slider, and hunting
 *                     for it by dragging a number is guesswork.
 *   the dial          Angles get AE's dial, not a number that means nothing
 *                     until you drag it. Detected off the param's declared
 *                     `unit === '°'`, so a new angle param gets one for free.
 *   `Gaussian Blur 2` Two of a kind are numbered by stack order, so four
 *                     stacked Smears are four distinguishable rows rather than
 *                     four identical labels (see `effectDisplayNames`).
 *
 * The header is AE's too: `▾ fx Name ............ Reset`, the selected effect
 * banded, its actions revealed on hover; right-click it for Duplicate / Copy.
 *
 * Every edit goes through the engine API (B3, `effectEdits.ts`): one undo entry
 * per click, typed value, drag (a scrub, a slider / dial / colour / curve drag
 * is one gesture) or reorder. Values shown are direct reads until B4.
 */

import { useState as useLocalState, Fragment } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { Slider } from '@components/Slider';
import { AngleDial } from '@components/AngleDial';
import { PropertyRow } from '@components/PropertyRow';
import { ColorPicker } from '@components/ColorPicker';
import { CurveEditor } from './CurveEditor';

import { useActiveWorkspace } from '@stores/projectStore';
import { useTrackNavigator } from '@layout/Inspector/AnimToggle';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch, useMirrorTree } from '@hooks/useMirror';
import { isTrackAnimated, readTrack, valueNumbersAt, trackRef as mirrorTrackRef } from '@core/mirror/selection';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { mirrorEffects, mirrorMaskHeaders } from '@core/mirror/effects';
import {
  effectDefFor,
  effectOpacityPath,
  effectPropPath,
  effectParam,
  effectDisplayNames,
  resolveChannelColor,
  type Effect,
  type EffectDef,
  type EffectParamDef,
  type EffectParamValue,
  type CurvePoints,
} from '@core/effects/effects';
import { copyEffects } from '@core/effects/effectClipboard';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { buildPropertyMenu } from '@core/inspector/propertyMenu';
import { layerTimeFor } from '@core/inspector/multiSelection';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import {
  dropEffectEdit,
  duplicateEffectEdit,
  effectOpacityCommands,
  effectOpacityStopwatchEdit,
  setEffectLabelColorEdit,
  setEffectMaskEdit,
  setEffectOpacityEdit,
  nudgeEffectEdit,
  paramCommands,
  paramStopwatchCommands,
  removeEffectEdit,
  resetEffectEdit,
  setEffectEnabledEdit,
} from './effectEdits';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

/**
 * One parameter line: AE's disclosure gutter, then the row, then whatever the
 * disclosure reveals.
 *
 * The gutter is a real column that every line reserves, expandable or not —
 * a triangle that only some rows carry would otherwise indent those rows'
 * names 14px past the rest, and a parameter list whose labels do not share a
 * left edge is exactly the misalignment PropertyRow's grid exists to prevent.
 * `PropertyRow` itself is untouched: its columns are shared with the timeline,
 * and this gutter is a fact about the effect panel, not about property rows.
 */
function ParamLine({
  expander,
  children,
  below,
}: {
  expander?: JSX.Element;
  children: React.ReactNode;
  below?: React.ReactNode;
}): JSX.Element {
  return (
    <div className={panel.paramLine}>
      <div className={panel.paramLineHead}>
        {expander ?? <span className={panel.paramGutter} aria-hidden />}
        <div className={panel.paramLineBody}>{children}</div>
      </div>
      {below}
    </div>
  );
}

/**
 * Split a param list into the sections AE draws.
 *
 * Consecutive params carrying the same `group` are ONE section; ungrouped
 * params stay at top level. Contiguity is the rule (see EffectParamDef.group),
 * so this is a single pass and a group interrupted by an ungrouped param
 * legitimately becomes two sections rather than silently reordering the
 * author's list.
 */
export function splitParamGroups(
  params: ReadonlyArray<EffectParamDef>,
): Array<{ group?: string; params: EffectParamDef[] }> {
  const out: Array<{ group?: string; params: EffectParamDef[] }> = [];
  for (const p of params) {
    const last = out[out.length - 1];
    if (last && last.group === p.group) last.params.push(p);
    else out.push({ group: p.group, params: [p] });
  }
  return out;
}

/**
 * One collapsible section of an effect's controls — AE's "▸ Output Cycle".
 *
 * Collapsed by DEFAULT. A grouped effect has groups precisely because it has
 * too many controls to show at once; opening all five of Colorama's sections
 * on selection would defeat the reason they were grouped.
 */
function ParamGroup({
  name,
  children,
  defaultOpen = false,
}: {
  name: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useLocalState(defaultOpen);
  return (
    <div className={panel.paramGroup}>
      <button
        type="button"
        className={panel.paramGroupHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
        <span>{name}</span>
      </button>
      {open ? <div className={panel.paramGroupBody}>{children}</div> : null}
    </div>
  );
}

/**
 * AE Compositing Options → Effect Opacity: how much of THIS effect's result
 * survives, 0–100.
 *
 * The dial that gives any effect a time range. An effect has no in/out point —
 * in AE or here — so limiting one to frames 30–60 means keyframing it to
 * nothing outside them, and most effects have no parameter that means "off":
 * Find Edges, Mosaic and a colour LUT have nothing to ramp to zero. This does,
 * uniformly, because the blend is against the effect's own input rather than
 * against any value it happens to expose.
 *
 * Deliberately NOT an `EffectParamRow`: that component is driven by an
 * `EffectParamDef` off the effect's definition, and this value lives on the
 * effect INSTANCE (`Effect.opacity`) precisely so it can exist for effects
 * whose definitions know nothing about it. It keyframes through the same
 * animation engine on the reserved path, so the stopwatch, the timeline row and
 * the graph editor all behave exactly as they do for a declared param.
 */
function EffectOpacityRow({ nodeId, effect }: { nodeId: string; effect: Effect }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const e = useEngineEdit();
  const path = effectOpacityPath(effect.id);
  // B4: the track's info, keys and value at the playhead from the document mirror.
  useMirrorTrackWatch([nodeId], [path]);
  const m = documentMirror();
  const animated = isTrackAnimated(m, nodeId, path);
  const stored = effect.opacity ?? 100;
  const display = readTrack(m, nodeId, path, time) ?? stored;
  const navigator = useTrackNavigator(nodeId, [path], 'Effect Opacity', () => [display]);

  // Keyframe when the property is already animated (an engine key at the
  // playhead), set the static instance field when it is not.
  const onChange = (v: number): void => {
    const next = Math.max(0, Math.min(100, v));
    const cmds = effectOpacityCommands(nodeId, effect.id, next, time);
    if (cmds) e.send('Set Effect Opacity', cmds);
    else void setEffectOpacityEdit(nodeId, effect.id, next);
  };

  // Stopwatch off puts the value at the playhead back as the STATIC one, so the
  // frame looks as it did (the engine's setAnimated semantics).
  const toggle = (): void => { void effectOpacityStopwatchEdit(nodeId, effect, time); };

  return (
    <ParamLine>
      <PropertyRow
        label="Effect Opacity"
        animated={animated}
        onStopwatch={toggle}
        navigator={navigator}
        onReset={animated ? undefined : () => { void setEffectOpacityEdit(nodeId, effect.id, undefined); }}
        compact
      >
        <ValueField
          {...e.scrub('Set Effect Opacity', () => animated)}
          value={display}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          onChange={onChange}
          aria-label={`${effect.type} effect opacity`}
        />
      </PropertyRow>
    </ParamLine>
  );
}

/**
 * AE Compositing Options → Effect Mask. The bake path already honours
 * `Effect.maskId`; this is the missing writer so authors can set it.
 */
function EffectMaskRow({ nodeId, effect }: { nodeId: string; effect: Effect }): JSX.Element {
  const paths = mirrorMaskHeaders(documentMirror().tree(nodeId));
  const current = effect.maskId ?? '';
  const stale = current !== '' && !paths.some((p) => p.id === current);
  return (
    <>
      <ParamLine>
        <div className={row.paramRow}>
          <div style={{ width: 14 }} />
          <span className={row.paramLabel}>Effect Mask</span>
          <select
            value={current}
            onChange={(ev) => { void setEffectMaskEdit(nodeId, effect.id, ev.currentTarget.value || undefined); }}
            aria-label={`${effect.type} effect mask`}
            title="Restrict this effect to a mask path. Prefer a path with mode None so it scopes the effect without also cutting the layer."
            className={panel.paramSelect}
          >
            <option value="">None</option>
            {stale && <option value={current}>Missing mask ({current})</option>}
            {paths.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.name.trim() || `Mask ${i + 1}`}
                {p.cuts ? ' · also clips layer' : ''}
              </option>
            ))}
          </select>
        </div>
      </ParamLine>
      {paths.length === 0 && (
        <p className={panel.hint} style={{ margin: '4px 8px 8px', opacity: 0.65, fontSize: 'var(--font-size-micro)' }}>
          Add a mask on this layer (mode None recommended) to scope the effect.
        </p>
      )}
    </>
  );
}

/**
 * AE's Compositing Options section: WHERE this effect applies (Effect Mask) and
 * HOW MUCH of it applies (Effect Opacity). One section, because they are the
 * same question asked over space and over strength, and the bake answers both
 * with one blend against the effect's input.
 *
 * Open by default once either is in use, so a layer arriving from elsewhere
 * does not hide the reason it looks the way it does behind a collapsed group.
 */
function CompositingOptions({ nodeId, effect }: { nodeId: string; effect: Effect }): JSX.Element {
  const inUse = effect.maskId !== undefined || effect.opacity !== undefined;
  return (
    <ParamGroup name="Compositing Options" defaultOpen={inUse}>
      <EffectOpacityRow nodeId={nodeId} effect={effect} />
      <EffectMaskRow nodeId={nodeId} effect={effect} />
    </ParamGroup>
  );
}

/** One parameter of one effect: a stopwatch (numbers only) plus its control. */
function EffectParamRow({
  nodeId,
  effect,
  def,
  param,
}: {
  nodeId: string;
  effect: Effect;
  def: EffectDef;
  param: EffectParamDef;
}): JSX.Element | null {
  const time = useActiveWorkspace()?.time ?? 0;
  // Declared with the other hooks, ABOVE the `resolved` early return below —
  // a `useState` after it would change this component's hook count the moment
  // an effect with a resolved param (Audio Spectrum) entered the stack.
  const [sliderOpen, setSliderOpen] = useLocalState(false);
  const e = useEngineEdit();

  const value = effectParam(effect, param.key);
  const label = `${def.label} ${param.label}`;
  /** One write of this param: into the open gesture (a drag), else ONE entry. */
  const send = (raw: EffectParamValue): void => {
    e.send(`Set ${label}`, paramCommands(nodeId, effect.id, param, raw, time));
  };
  const toggleAnim = (animated: boolean): void => {
    e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, paramStopwatchCommands(nodeId, effect.id, param, time));
  };
  // The navigator's tracks, decided by param type — called unconditionally so
  // the hook count never depends on which parameter this row is drawing.
  const navPrefix = effectPropPath(effect.id, param.key);
  const navTracks = param.type === 'color'
    ? [`${navPrefix}_r`, `${navPrefix}_g`, `${navPrefix}_b`, `${navPrefix}_a`]
    : [navPrefix];
  const navigator = useTrackNavigator(nodeId, navTracks, label);
  // B4: this parameter's info, keys and value at the playhead from the document mirror.
  useMirrorTrackWatch([nodeId], navTracks);
  const m = documentMirror();

  // A RESOLVED param is computed by the render pipeline every frame (Audio
  // Spectrum's band magnitudes). Rendering a control for it would give the user
  // a field whose input is overwritten before it is ever read — the dead-control
  // shape this codebase keeps finding. It has no editor by construction.
  if (param.type === 'resolved') return null;

  if (param.type === 'color') {
    // Keyframeable through decomposed channel tracks (`effect.<id>.<key>_r`
    // …), exactly the fill/stroke pattern — resolveEffectParams recomposes
    // them per frame. Before this, color params were the one param type the
    // stopwatch couldn't touch: no animated glow color, no shadow color ramp.
    const chPrefix = effectPropPath(effect.id, param.key);
    const animated = isTrackAnimated(m, nodeId, `${chPrefix}_r`);
    // Same rule the RENDERER uses (resolveEffectParams calls the same helper):
    // an unanimated channel falls back to the stored colour's channel, not to a
    // constant. Two implementations of this disagreed, and the swatch was the
    // one that lied. Display read, sampled on the layer's own keyframe axis.
    const colorRef = animated ? mirrorTrackRef(m, nodeId, `${chPrefix}_r`) : null;
    const channels = colorRef ? valueNumbersAt(m, nodeId, colorRef.path, time) : [];
    const CH = { _r: 0, _g: 1, _b: 2, _a: 3 } as const;
    const displayed = animated
      ? resolveChannelColor(String(value), (s) => channels[CH[s]])
      : String(value);
    return (
      <ParamLine>
        <PropertyRow label={param.label} animated={animated} onStopwatch={() => toggleAnim(animated)} navigator={navigator} compact>
          {/* A picker drag (press → release) is one gesture: one undo entry. */}
          <span style={{ display: 'contents' }} {...e.press(`Set ${label}`)}>
            <ColorPicker value={displayed} onChange={send} aria-label={label} compact />
          </span>
        </PropertyRow>
      </ParamLine>
    );
  }

  if (param.type === 'checkbox') {
    return (
      <ParamLine>
        <div className={row.paramRow}>
          <div style={{ width: 14 }} />
          <span className={row.paramLabel}>{param.label}</span>
          <Checkbox
            checked={value === true}
            onChange={(ev) => send(ev.currentTarget.checked)}
            aria-label={label}
            style={{ width: 14, height: 14 }}
          />
        </div>
      </ParamLine>
    );
  }

  if (param.type === 'layer') {
    // Layer reference (e.g. Displace's Map Layer): a dropdown of the comp's
    // OTHER layers — same sibling scope as the track-matte source picker.
    // '' = None → the effect falls back to its self-referential behavior.
    const siblings = siblingLayers(nodeId);
    const current = typeof value === 'string' ? value : '';
    const stale = current !== '' && !siblings.some((s) => s.id === current);
    return (
      <ParamLine>
        <div className={row.paramRow}>
        <div style={{ width: 14 }} />
        <span className={row.paramLabel}>{param.label}</span>
        <select
          value={current}
          onChange={(ev) => send(ev.currentTarget.value)}
          aria-label={label}
          className={panel.paramSelect}
        >
          <option value="">None (self)</option>
          {stale && <option value={current}>Missing layer ({current})</option>}
          {siblings.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}</option>
          ))}
        </select>
        </div>
      </ParamLine>
    );
  }

  if (param.type === 'maskPath') {
    // One of THIS layer's mask paths — the spine a path-following effect
    // (Write-on, Vegas) draws along. `mode: 'none'` paths are the intended
    // partners (geometry without a cut — see mask.ts), but any path works:
    // the effect reads only the outline. '' = the effect's own default
    // geometry (alpha contour / Start→End line).
    const paths = mirrorMaskHeaders(m.tree(nodeId));
    const current = typeof value === 'string' ? value : '';
    const stale = current !== '' && !paths.some((mp) => mp.id === current);
    return (
      <ParamLine>
        <div className={row.paramRow}>
        <div style={{ width: 14 }} />
        <span className={row.paramLabel}>{param.label}</span>
        <select
          value={current}
          onChange={(ev) => send(ev.currentTarget.value)}
          aria-label={label}
          className={panel.paramSelect}
        >
          <option value="">{param.noneLabel ?? 'None'}</option>
          {stale && <option value={current}>Missing mask ({current})</option>}
          {paths.map((mp, i) => (
            <option key={mp.id} value={mp.id}>{mp.name || `Mask ${i + 1}`}</option>
          ))}
        </select>
        </div>
      </ParamLine>
    );
  }

  if (param.type === 'enum') {
    /*
      A named choice stored as a NUMBER (see EffectParamDef). AE renders these
      as a plain menu with no stopwatch — Echo Operator, Bend Style — because
      interpolating BETWEEN two named modes is meaningless. A hold-keyframed
      enum is a real thing in AE, but it belongs with hold interpolation, not
      with a stopwatch that would linearly ramp "Add" into "Screen".

      Falls back to the def's default rather than option[0] when the stored
      value names no option: a project written by a build that had one more
      mode must not silently become a DIFFERENT mode, and `default` is the one
      value the effect is guaranteed to handle.
    */
    const opts = param.options ?? [];
    const current = typeof value === 'number' ? value : Number(param.default);
    const known = opts.some((o) => o.value === current);
    return (
      <ParamLine>
        <div className={row.paramRow}>
          <div style={{ width: 14 }} />
          <span className={row.paramLabel}>{param.label}</span>
          <select
            value={known ? String(current) : String(param.default)}
            onChange={(ev) => send(Number(ev.currentTarget.value))}
            aria-label={label}
            className={panel.paramSelect}
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </ParamLine>
    );
  }

  if (param.type === 'curve') {
    return (
      <ParamLine>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
          <span className={row.paramLabel}>{param.label}</span>
          {/* A point drag (press → release) is one gesture: one undo entry. */}
          <div {...e.press(`Set ${label}`)}>
            <CurveEditor
              value={Array.isArray(value) ? (value as CurvePoints) : [[0, 0], [255, 255]]}
              onChange={send}
            />
          </div>
        </div>
      </ParamLine>
    );
  }

  // Numeric: keyframeable under `effect.<id>.<param>`.
  const stored = typeof value === 'number' ? value : 0;
  const path = effectPropPath(effect.id, param.key);
  const animated = isTrackAnimated(m, nodeId, path);
  const display = readTrack(m, nodeId, path, time) ?? stored;

  // The field, slider, dial, reset and context menu share ONE writer: a key at
  // the playhead when the param is animated (AE setValueAtTime), else the static
  // value — `paramCommands`, the rule the canvas handle overlay uses too.
  const onChange = (v: number): void => send(v);
  const toggle = (): void => toggleAnim(animated);

  // Range, step, precision and unit all resolve through the property registry,
  // which reads them off this effect's own definition — so the timeline row and
  // this row describe the same parameter identically.
  const meta = mirrorPropertyMeta(path, m.layer(nodeId), m.tree(nodeId));

  // A slider needs BOTH ends of the range to mean anything. Distance (0–200)
  // gets one; Angle and Position X, declared without bounds, do not — a slider
  // over an invented range is a control that silently clamps.
  const ranged = Number.isFinite(meta.min) && Number.isFinite(meta.max);
  // AE's dial, chosen off the declared unit rather than a hand-kept list of
  // param names, so a new `unit: '°'` param gets one the day it is added.
  const isAngle = meta.unit === '°';

  const expander = ranged ? (
    <button
      type="button"
      className={panel.paramExpander}
      aria-expanded={sliderOpen}
      aria-label={`${sliderOpen ? 'Hide' : 'Show'} ${label} slider`}
      title={sliderOpen ? 'Hide slider' : 'Show slider'}
      onClick={() => setSliderOpen((v) => !v)}
    >
      <Icon name={sliderOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
    </button>
  ) : undefined;

  return (
    <ParamLine
      expander={expander}
      below={
        ranged && sliderOpen ? (
          // A slider drag (press → release) is one gesture: one undo entry.
          <div className={panel.paramSlider} {...e.press(`Set ${label}`)}>
            <Slider
              value={display}
              min={meta.min as number}
              max={meta.max as number}
              step={meta.step ?? 1}
              size="sm"
              // Same writer as the field: the slider must keyframe when the
              // property is animated, exactly as typing a value does.
              onChange={onChange}
              // Named, not captioned — the row directly above already says
              // "Distance", and `label` would print it a second time.
              aria-label={label}
            />
          </div>
        ) : undefined
      }
    >
      <PropertyRow
        label={param.label}
        animated={animated}
        onStopwatch={toggle}
        navigator={navigator}
        onReset={
          typeof meta.defaultValue === 'number' && meta.resettable
            ? () => send(meta.defaultValue as number)
            : undefined
        }
        onContextMenu={(ev) => {
          ev.preventDefault();
          openContextMenu(
            ev.clientX,
            ev.clientY,
            buildPropertyMenu({
              nodeId,
              prop: path,
              // The menu's own keyframe items work on the layer's keyframe axis (display read).
              layerT: layerTimeFor(nodeId, path, time),
              value: display,
              setValue: (v) => send(v),
            }),
          );
        }}
        compact
      >
        {/* Inside the value cell, left of the number — the placement the
            transform panel's rotation dial uses, which is what keeps the
            numbers in one column across rows that have a dial and rows
            that do not. */}
        {isAngle && (
          <span style={{ display: 'contents' }} {...e.press(`Set ${label}`)}>
            <AngleDial value={display} onChange={onChange} aria-label={`${label} dial`} />
          </span>
        )}
        <ValueField
          {...e.scrub(`Set ${label}`)}
          value={display}
          min={meta.min}
          max={meta.max}
          unit={meta.unit}
          step={meta.step}
          precision={meta.precision}
          onChange={onChange}
          aria-label={label}
        />
      </PropertyRow>
    </ParamLine>
  );
}

/**
 * The other layers beside `nodeId` — the same parent (or the top of the same
 * composition), back to front as the scene lists them — for a layer-reference
 * param. From the document mirror.
 */
function siblingLayers(nodeId: string): Array<{ id: string; name: string }> {
  const m = documentMirror();
  const self = m.layer(nodeId);
  const comp = self ? m.comp(self.comp) : undefined;
  if (!self || !comp) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const id = comp.layers[i]!;
    if (id === nodeId) continue;
    const l = m.layer(id);
    if (l && l.parent === self.parent) out.push({ id, name: l.name });
  }
  return out;
}

/** AE-style label colour menu for one applied effect instance. */
function effectLabelColorMenuItems(
  nodeId: string,
  effectId: string,
  current: string | undefined,
): ContextMenuItem[] {
  return [
    {
      id: 'fx-label-none',
      label: 'None (Default)',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => { void setEffectLabelColorEdit(nodeId, effectId, undefined); },
    },
    { id: 'fx-label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `fx-label-${c.id}`,
      label: (
        <>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: c.color,
              marginRight: 8,
              verticalAlign: 'baseline',
            }}
          />
          {c.label}
        </>
      ),
      icon: current === c.color ? 'check' : undefined,
      onSelect: () => { void setEffectLabelColorEdit(nodeId, effectId, c.color); },
    })),
  ];
}

/** Right-click on an effect's header: AE's Duplicate (Ctrl+D) and Copy, plus Reset / Remove. */
function effectHeaderMenuItems(nodeId: string, effectId: string, name: string): ContextMenuItem[] {
  return [
    { id: 'fx-duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => { void duplicateEffectEdit(nodeId, effectId, name); } },
    { id: 'fx-copy', label: 'Copy', onSelect: () => copyEffects(nodeId, [effectId]) },
    { id: 'fx-sep', separator: true },
    { id: 'fx-reset', label: 'Reset', onSelect: () => { void resetEffectEdit(nodeId, effectId, name); } },
    { id: 'fx-remove', label: 'Remove', danger: true, onSelect: () => { void removeEffectEdit(nodeId, effectId, name); } },
  ];
}

export function EffectStack({ nodeId }: { nodeId: string }): JSX.Element {
  // B4: the stack from the layer's mirror property tree (re-renders when the tree changes).
  const tree = useMirrorTree(nodeId);
  const effects = mirrorEffects(tree);
  // "Gaussian Blur 2" for the second of a kind — see effectDisplayNames.
  const names = effectDisplayNames(effects);
  // Which effect owns the canvas handles. Subscribed, not read via getState():
  // the band marking the selected effect has to repaint when the selection
  // moves, and a getState() read would leave it stale until something else
  // re-rendered the panel.
  const selectedEffectId = useEffectHandleStore((s) => (s.nodeId === nodeId ? s.effectId : null));

  const [userToggledIds, setUserToggledIds] = useState<Map<string, boolean>>(new Map());
  /** Effect being dragged, and the gap index the drop indicator sits in. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const toggleEffectCard = (id: string, currentCollapsed: boolean) => {
    setUserToggledIds((prev) => {
      const next = new Map(prev);
      next.set(id, !currentCollapsed);
      return next;
    });
  };

  if (effects.length === 0) {
    return (
      <div className={panel.hint}>
        No active effects on this layer. Add one from the Effects panel on the right.
      </div>
    );
  }

  return (
    <div className={panel.stackList}>
      {effects.map((e, i) => {
        /*
          `effectDefFor`, NOT a map built from `EFFECT_DEFS`.

          That array holds the built-ins only, and is captured at module load;
          a plugin's effects arrive later and change while the app runs. A map
          built from it returns undefined for every plugin effect, and the skip
          below then drew nothing for one — so adding a plugin effect from the
          browser wrote it to the layer and produced no visible change, which
          reads as the add having failed.

          The skip itself is right, for what is left once this resolves
          properly: an effect whose plugin has been disabled or uninstalled has
          no definition to draw a card from.
        */
        const def = effectDefFor(e.type);
        if (!def) return null;
        const name = names.get(e.id) ?? def.label;
        const off = e.enabled === false;
        const defaultCollapsed = i !== effects.length - 1;
        const isCollapsed = userToggledIds.has(e.id) ? userToggledIds.get(e.id)! : defaultCollapsed;

        // Drop BEFORE this card when the pointer is in its top half, after it
        // when in the bottom half — the gap the indicator is drawn in is the
        // index the effect lands at, so what you see is what you get.
        const onDragOver = (ev: React.DragEvent): void => {
          if (!dragId) return;
          ev.preventDefault();
          const r = ev.currentTarget.getBoundingClientRect();
          setDropIndex(ev.clientY < r.top + r.height / 2 ? i : i + 1);
        };

        return (
          <div
            key={e.id}
            className={cn(
              panel.effectCardItem,
              dragId === e.id && panel.effectCardDragging,
              dropIndex === i && panel.effectDropBefore,
              dropIndex === effects.length && i === effects.length - 1 && panel.effectDropAfter,
            )}
            onDragOver={onDragOver}
            onDrop={(ev) => {
              ev.preventDefault();
              if (dragId && dropIndex !== null) void dropEffectEdit(nodeId, dragId, dropIndex);
              setDragId(null);
              setDropIndex(null);
            }}
          >
            {/* AE Effect Controls header: ▾ fx Name .......... Reset */}
            <div
              className={cn(
                panel.effectCardHead,
                selectedEffectId === e.id && panel.effectCardHeadSelected,
              )}
              // The HEADER is the drag handle, not the whole card — dragging
              // from the body would fight every scrubby slider inside it.
              draggable
              onDragStart={(ev) => {
                setDragId(e.id);
                ev.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload.
                ev.dataTransfer.setData('text/plain', e.id);
              }}
              onDragEnd={() => { setDragId(null); setDropIndex(null); }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                openContextMenu(ev.clientX, ev.clientY, effectHeaderMenuItems(nodeId, e.id, name));
              }}
            >
              <span className={panel.dragGrip} aria-hidden title="Drag to reorder">
                <Icon name="grip-vertical" size="sm" />
              </span>
              <button
                type="button"
                className={panel.disclosureBtn}
                onClick={() => toggleEffectCard(e.id, isCollapsed)}
                title={isCollapsed ? 'Expand effect parameters' : 'Collapse effect parameters'}
              >
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              </button>

              <Checkbox
                checked={!off}
                onChange={() => { void setEffectEnabledEdit(nodeId, e.id, off, name); }}
                title={off ? 'Enable effect' : 'Disable effect'}
                style={{ width: 15, height: 15, flexShrink: 0 }}
              />

              <button
                type="button"
                className={panel.labelSwatch}
                style={e.labelColor ? { background: e.labelColor } : undefined}
                title="Label Color"
                aria-label={`Label color for ${name}`}
                // Header is the drag handle — keep the swatch from starting a drag.
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  openContextMenu(
                    ev.clientX,
                    ev.clientY,
                    effectLabelColorMenuItems(nodeId, e.id, e.labelColor),
                  );
                }}
              />

              <span className={panel.fxMark} aria-hidden>fx</span>

              <span
                className={off ? panel.itemLabelOff : panel.itemLabel}
                // Selecting the card is what shows its canvas handles. Twelve
                // Bezier Warp points and four Corner Pin points on one layer at
                // once would make the canvas unusable, so the overlay follows
                // the selected effect — the AE behaviour too.
                onClick={() => {
                  if (hasEffectHandles(e.type)) useEffectHandleStore.getState().select(nodeId, e.id);
                  toggleEffectCard(e.id, isCollapsed);
                }}
              >
                {name}
              </span>

              <div className={panel.itemActions}>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Move ${name} up`}
                  disabled={i === 0}
                  onClick={() => { void nudgeEffectEdit(nodeId, e.id, -1); }}
                >
                  <Icon name="arrow-up" size="sm" />
                </button>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Move ${name} down`}
                  disabled={i === effects.length - 1}
                  onClick={() => { void nudgeEffectEdit(nodeId, e.id, 1); }}
                >
                  <Icon name="arrow-down" size="sm" />
                </button>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Remove ${name}`}
                  onClick={() => { void removeEffectEdit(nodeId, e.id, name); }}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>

              {/* AE's Reset link. A word, not another icon: the header already
                  carries five glyphs, and this is the one control here whose
                  meaning an icon would not carry. Far right, like AE. */}
              <button
                type="button"
                className={panel.resetLink}
                title={`Restore every ${name} parameter to its default`}
                onClick={() => { void resetEffectEdit(nodeId, e.id, name); }}
              >
                Reset
              </button>
            </div>

            {/* Accordion Body: Effect Parameters + Compositing Options */}
            {!isCollapsed && !off && (
              <div className={panel.effectParamsBody}>
                {splitParamGroups(def.params).map((section, si) => {
                  const rows = section.params.map((p) => (
                    <EffectParamRow key={p.key} nodeId={nodeId} effect={e} def={def} param={p} />
                  ));
                  return section.group
                    ? <ParamGroup key={`g:${section.group}:${si}`} name={section.group}>{rows}</ParamGroup>
                    : <Fragment key={`u:${si}`}>{rows}</Fragment>;
                })}
                <CompositingOptions nodeId={nodeId} effect={e} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default EffectStack;
