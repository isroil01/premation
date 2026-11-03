import { hasEffectHandles } from '@core/effects/effectHandles';
import { Button } from '@components/Button';
import { edit } from '@core/engine/uiEdits';
import { paths, ref, values } from '@core/engine/propRefs';
import { useLiquifyBrushStore } from '@stores/liquifyBrushStore';
import { LIQUIFY_TOOLS, type LiquifyTool } from '@core/effects/liquifyField';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import { useState, useSyncExternalStore } from 'react';
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
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Tooltip, TooltipProvider } from '@components/Tooltip';
import { CurveEditor } from './CurveEditor';

import { useActiveWorkspace } from '@stores/projectStore';
import { useTrackNavigator } from '@layout/Inspector/AnimToggle';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch, useMirrorTreeGroups } from '@hooks/useMirror';
import { isTrackAnimated, readTrack, valueNumbersAt, trackRef as mirrorTrackRef } from '@core/mirror/selection';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { mirrorEffects, mirrorMaskHeaders } from '@core/mirror/effects';
import { layerSubjects } from '@core/workspace/subjects';
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
} from '@core/inspector/effectCatalog';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { engineRowMenuItems } from '@layout/Inspector/propertyRowMenu';
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
  setEffectSubjectScopeEdit,
  nudgeEffectEdit,
  paramCommands,
  paramStopwatchCommands,
  removeEffectEdit,
  resetEffectEdit,
  setEffectEnabledEdit,
  copyEffectsEdit,
  applyPresetToEffectEdit,
} from './effectEdits';
import panel from './EffectsPanel.module.css';
import { ParamExpression } from './ParamExpression';
import { altClickStopwatchEdit } from '@providers/commands/expressionCommands';
import { requestExpressionEditor } from '@core/animation/expressionEditorRequests';
import { MissingPluginCard, PluginEffectButton, usePluginEffectUi } from './PluginEffectParts';
import { PluginCustomUi } from './PluginCustomUi';
import { pluginCardSections } from '@core/inspector/pluginCardLayout';
import { pluginPresetsFor, type PluginPreset } from '@core/nativePlugins/pluginPresets';
import { PluginHeaderActions, PluginHeaderIcon } from './PluginCardHeader';
import { PluginFileField, PluginGradientField, PluginTextField } from './PluginParamControls';
import { isPluginEffectDef, pluginEffectDefsRevision, subscribePluginEffectDefs, type PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import row from '@layout/Inspector/TextAnimatorControls.module.css';
import { t } from '@core/i18n';
import { builtinGroupHint, builtinParamHint } from './builtinParamHints';

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

/** A param row's name; with a native plugin's description, a focusable label showing it as a tooltip. */
function ParamLabel({ text, description }: { text: string; description?: string }): JSX.Element {
  if (!description) return <span className={row.paramLabel}>{text}</span>;
  return (
    <Tooltip label={description}>
      <span className={cn(row.paramLabel, panel.paramDescribed)} tabIndex={0}>{text}</span>
    </Tooltip>
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
 * Collapsed by DEFAULT for built-ins. A grouped effect has groups precisely
 * because it has too many controls to show at once; opening all five of
 * Colorama's sections on selection would defeat the reason they were grouped.
 * A native plugin says per group (PR_PARAM_FLAG_START_COLLAPSED), so its
 * groups open unless it asked otherwise — AE's rule for plugins.
 */
function ParamGroup({
  name,
  children,
  defaultOpen = false,
  description,
}: {
  name: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** A native plugin group's description (SDK 1.2): the header's tooltip. */
  description?: string;
}): JSX.Element {
  const [open, setOpen] = useLocalState(defaultOpen);
  const head = (
    <button
      type="button"
      className={panel.paramGroupHead}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
      <span className={description ? panel.paramDescribed : undefined}>{name}</span>
    </button>
  );
  return (
    <div className={panel.paramGroup}>
      {description ? <Tooltip label={description} placement="left">{head}</Tooltip> : head}
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
        label={t('effects.stack.effectOpacity', 'Effect Opacity')}
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
          aria-label={t('effects.stack.effectOpacityAria', '{type} effect opacity', { type: effect.type })}
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
          <span className={row.paramLabel}>{t('effects.stack.effectMask', 'Effect Mask')}</span>
          <select
            value={current}
            onChange={(ev) => { void setEffectMaskEdit(nodeId, effect.id, ev.currentTarget.value || undefined); }}
            aria-label={t('effects.stack.effectMaskAria', '{type} effect mask', { type: effect.type })}
            title={t('effects.stack.effectMaskTitle', 'Restrict this effect to a mask path. Prefer a path with mode None so it scopes the effect without also cutting the layer.')}
            className={panel.paramSelect}
          >
            <option value="">{t('effects.stack.none', 'None')}</option>
            {stale && <option value={current}>{t('effects.stack.missingMask', 'Missing mask ({id})', { id: current })}</option>}
            {paths.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.name.trim() || t('effects.stack.maskN', 'Mask {n}', { n: i + 1 })}
                {p.cuts ? t('effects.stack.alsoClips', ' · also clips layer') : ''}
              </option>
            ))}
          </select>
        </div>
      </ParamLine>
      {paths.length === 0 && (
        <p className={panel.hint} style={{ margin: '4px 8px 8px', opacity: 0.65, fontSize: 'var(--font-size-micro)' }}>
          {t('effects.stack.addMaskHint', 'Add a mask on this layer (mode None recommended) to scope the effect.')}
        </p>
      )}
    </>
  );
}

/**
 * Compositing Options › Apply To: the whole layer, its subject (the Object
 * Matte selection) or everything but it — "colour only the person", "blur
 * only the background" without a duplicate layer. Shown on footage that has
 * a subject, and wherever it is already set.
 */
function ApplyToRow({ nodeId, effect }: { nodeId: string; effect: Effect }): JSX.Element | null {
  const subjects = layerSubjects(nodeId);
  if (subjects.length === 0 && effect.subjectScope === undefined && effect.subjectId === undefined) return null;
  // Which subject: with several on the layer, one of them or all (Compositing Options ▸ subjectId).
  const readsSubject = effect.subjectScope !== undefined || effect.type === 'matte-stroke' || effect.type === 'selective-color-ai';
  return (
    <>
      <ParamLine>
        <div className={row.paramRow}>
          <div style={{ width: 14 }} />
          <span className={row.paramLabel}>{t('effects.stack.applyTo', 'Apply To')}</span>
          <select
            value={effect.subjectScope ?? ''}
            onChange={(ev) => {
              const v = ev.currentTarget.value;
              void setEffectSubjectScopeEdit(nodeId, effect.id, v === 'subject' || v === 'background' ? v : undefined);
            }}
            aria-label={t('effects.stack.applyToAria', '{type} applies to', { type: effect.type })}
            title={t('effects.stack.applyToTitle', 'Where this effect lands: the whole layer, only the selected subject, or everything except the subject.')}
            className={panel.paramSelect}
          >
            <option value="">{t('effects.stack.applyToLayer', 'Whole Layer')}</option>
            <option value="subject">{t('effects.stack.applyToSubject', 'Subject')}</option>
            <option value="background">{t('effects.stack.applyToBackground', 'Background')}</option>
          </select>
        </div>
      </ParamLine>
      {readsSubject && (subjects.length > 1 || effect.subjectId !== undefined) && (
        <ParamLine>
          <div className={row.paramRow}>
            <div style={{ width: 14 }} />
            <span className={row.paramLabel}>{t('effects.stack.whichSubject', 'Subject')}</span>
            <select
              value={effect.subjectId ?? ''}
              onChange={(ev) => {
                const v = ev.currentTarget.value;
                void edit(t('effects.stack.whichSubjectLabel', 'Effect Subject'), {
                  type: 'setProperty', prop: { layer: nodeId, path: `effects/${effect.id}/compositing/subjectId` }, value: { kind: 'string', value: v },
                });
              }}
              aria-label={t('effects.stack.whichSubjectAria', 'Which subject {type} reads', { type: effect.type })}
              title={t('effects.stack.whichSubjectTitle', 'Which of the layer’s subjects this effect reads: one of them, or all of them together.')}
              className={panel.paramSelect}
            >
              <option value="">{t('effects.stack.allSubjects', 'All subjects')}</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </ParamLine>
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
  const inUse = effect.maskId !== undefined || effect.opacity !== undefined || effect.subjectScope !== undefined || effect.subjectId !== undefined;
  return (
    <ParamGroup name={t('effects.stack.compositingOptions', 'Compositing Options')} defaultOpen={inUse}>
      <EffectOpacityRow nodeId={nodeId} effect={effect} />
      <ApplyToRow nodeId={nodeId} effect={effect} />
      <EffectMaskRow nodeId={nodeId} effect={effect} />
    </ParamGroup>
  );
}

/**
 * A native plugin effect's params and buttons in the plugin's declared order,
 * as the plugin wants them shown right now (UPDATE_PARAMS_UI: hidden / renamed
 * / disabled — a hidden group hides everything in it). A plugin group opens
 * unless the plugin declared it START_COLLAPSED: the author grouped the
 * controls and said which ones to tuck away (pluginCardLayout.ts).
 */
function PluginEffectBody({ nodeId, effect, def }: { nodeId: string; effect: Effect; def: PluginEffectDef }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const answer = usePluginEffectUi(nodeId, effect, time);
  // Keyed by the group and its occurrence, not the section index: a section the
  // plugin hides above must not remount (and re-twirl) the groups below it.
  const seen = new Map<string, number>();
  // Its own tooltip provider (descriptions): the stack must not need the app root's (see TransformSection).
  return (
    <TooltipProvider>
      {pluginCardSections(def, answer?.byKey ?? null).map((section, si) => {
        const nth = seen.get(section.group ?? '') ?? 0;
        seen.set(section.group ?? '', nth + 1);
        const rows = section.items.map((it) => {
          if (it.kind === 'button') {
            return <PluginEffectButton key={it.key} nodeId={nodeId} effect={effect} def={def} action={it.key} label={it.label} disabled={it.disabled} />;
          }
          if (it.kind === 'customUi') {  // SDK 1.3: the plugin's own box (PluginCustomUi.tsx)
            return (
              <PluginCustomUi
                key={it.key} nodeId={nodeId} effect={effect} def={def} uiKey={it.key} label={it.label}
                height={it.height} description={it.description} time={time} disabled={it.disabled}
              />
            );
          }
          const r = <EffectParamRow key={it.param.key} nodeId={nodeId} effect={effect} def={def} param={it.param} />;
          return it.disabled
            ? <div key={it.param.key} aria-disabled style={{ opacity: 0.45, pointerEvents: 'none' }}>{r}</div>
            : r;
        });
        return section.group
          ? (
            <ParamGroup key={`g:${section.group}:${nth}`} name={section.group} defaultOpen={!section.collapsed} description={section.description || undefined}>
              {rows}
            </ParamGroup>
          )
          : <Fragment key={`u:${si}`}>{rows}</Fragment>;
      })}
    </TooltipProvider>
  );
}

/**
 * One effect's parameters as Effect Controls draws them, without the card
 * header or Compositing Options — for a panel that lists the effect its own
 * way (Properties ▸ Subject ▸ Styles) and tunes it in place.
 */
export function EffectParamsBody({ nodeId, effect }: { nodeId: string; effect: Effect }): JSX.Element | null {
  const def = effectDefFor(effect.type);
  if (!def) return null;
  return (
    <TooltipProvider>
      <div className={panel.effectParamsBody}>
        {isPluginEffectDef(def) ? (
          <PluginEffectBody nodeId={nodeId} effect={effect} def={def} />
        ) : splitParamGroups(def.params).map((section, si) => {
          const rows = section.params.map((p) => (
            <EffectParamRow key={p.key} nodeId={nodeId} effect={effect} def={def} param={p} />
          ));
          return section.group
            ? <ParamGroup key={`g:${section.group}:${si}`} name={section.group} description={builtinGroupHint(def.type, section.group)}>{rows}</ParamGroup>
            : <Fragment key={`u:${si}`}>{rows}</Fragment>;
        })}
      </div>
    </TooltipProvider>
  );
}

/** One parameter of one effect, with its expression (if any) under it. */
function EffectParamRow(props: {
  nodeId: string;
  effect: Effect;
  def: EffectDef;
  param: EffectParamDef;
}): JSX.Element | null {
  const { nodeId, effect, param } = props;
  if (param.type === 'resolved' || param.type === 'data') return null;
  return (
    <>
      <EffectParamControl {...props} />
      <ParamExpression nodeId={nodeId} track={effectPropPath(effect.id, param.key)} label={param.label} />
    </>
  );
}

/** AE's Alt-click on an effect parameter's stopwatch: its editor opens here, in Effect Controls. */
function altStopwatch(nodeId: string, track: string): void {
  void altClickStopwatchEdit([{ nodeId, prop: track }], requestExpressionEditor);
}

/** One parameter of one effect: a stopwatch (numbers only) plus its control. */
function EffectParamControl({
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
  // A plugin param declared CANNOT_ANIMATE has no stopwatch — unless keys reached
  // it anyway (an older project), so the stopwatch can still take them off.
  const fixed = isPluginEffectDef(def) && def.fixed.has(param.key);
  // SDK 1.2: what the plugin says the param does — the label's tooltip.
  const description = isPluginEffectDef(def) ? def.descriptions.get(param.key) : builtinParamHint(def.type, param.key);
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
  if (param.type === 'resolved' || param.type === 'data') return null;

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
        <PropertyRow label={param.label} description={description} animated={animated} onStopwatch={fixed && !animated ? undefined : () => toggleAnim(animated)} onAltStopwatch={() => altStopwatch(nodeId, chPrefix)} navigator={navigator} compact>
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
          <ParamLabel text={param.label} description={description} />
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
        <ParamLabel text={param.label} description={description} />
        <select
          value={current}
          onChange={(ev) => send(ev.currentTarget.value)}
          aria-label={label}
          className={panel.paramSelect}
        >
          <option value="">{t('effects.stack.noneSelf', 'None (self)')}</option>
          {stale && <option value={current}>{t('effects.stack.missingLayer', 'Missing layer ({id})', { id: current })}</option>}
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
        <ParamLabel text={param.label} description={description} />
        <select
          value={current}
          onChange={(ev) => send(ev.currentTarget.value)}
          aria-label={label}
          className={panel.paramSelect}
        >
          <option value="">{param.noneLabel ?? t('effects.stack.none', 'None')}</option>
          {stale && <option value={current}>{t('effects.stack.missingMask', 'Missing mask ({id})', { id: current })}</option>}
          {paths.map((mp, i) => (
            <option key={mp.id} value={mp.id}>{mp.name || t('effects.stack.maskN', 'Mask {n}', { n: i + 1 })}</option>
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
          <ParamLabel text={param.label} description={description} />
          <select
            value={known ? String(current) : String(param.default)}
            onChange={(ev) => send(Number(ev.currentTarget.value))}
            aria-label={label}
            className={panel.paramSelect}
            // One choice (Object Matte's Version): a read-only readout.
            disabled={opts.length <= 1}
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </ParamLine>
    );
  }

  // Plugin SDK 1.1 params (static: no stopwatch).
  if (param.type === 'text' || param.type === 'gradient' || param.type === 'file') {
    return (
      <ParamLine>
        <div className={row.paramRow} style={{ alignItems: 'flex-start' }}>
          <div style={{ width: 14 }} />
          <ParamLabel text={param.label} description={description} />
          {param.type === 'text' ? (
            <PluginTextField label={label} value={typeof value === 'string' ? value : typeof param.default === 'string' ? param.default : ''} onCommit={send} />
          ) : param.type === 'gradient' ? (
            <PluginGradientField label={label} value={value ?? param.default} onChange={send} />
          ) : (
            <PluginFileField label={label} value={typeof value === 'string' ? value : ''} fileTypes={param.fileTypes} onChange={send} />
          )}
        </div>
      </ParamLine>
    );
  }

  if (param.type === 'curve') {
    return (
      <ParamLine>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
          <ParamLabel text={param.label} description={description} />
          {/* A point drag (press → release) is one gesture: one undo entry. */}
          <div {...e.press(`Set ${label}`)}>
            <CurveEditor
              value={Array.isArray(value) ? (value as CurvePoints) : (Array.isArray(param.default) ? (param.default as CurvePoints) : [[0, 0], [255, 255]])}
              onChange={send}
              // Lumetri's Hue / Luma vs curves (AE parity 5.1): X is the hue / the luma.
              variant={param.key.startsWith('hueVs') ? 'hue' : param.key === 'lumaVsSat' ? 'luma' : 'tone'}
              {...(Array.isArray(param.default) ? { fallback: param.default as CurvePoints } : {})}
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
      aria-label={sliderOpen
        ? t('effects.stack.hideSliderAria', 'Hide {label} slider', { label })
        : t('effects.stack.showSliderAria', 'Show {label} slider', { label })}
      title={sliderOpen ? t('effects.stack.hideSlider', 'Hide slider') : t('effects.stack.showSlider', 'Show slider')}
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
        description={description}
        animated={animated}
        onStopwatch={fixed && !animated ? undefined : toggle}
        onAltStopwatch={() => altStopwatch(nodeId, path)}
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
            // The Inspector's row menu on the engine API: keys addressed in
            // composition time, state from the mirror (B4).
            engineRowMenuItems({
              nodeId,
              prop: path,
              nodeIds: [nodeId],
              time,
              label,
              resetValue: typeof meta.defaultValue === 'number' && meta.resettable ? meta.defaultValue : undefined,
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
      label: t('effects.stack.labelNone', 'None (Default)'),
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

/**
 * A plugin effect's Apply Preset submenu: the presets its plugin ships for this
 * effect type (SDK 1.2), applied onto THIS instance. Grouped by the plugin's
 * categories when it uses more than one. Empty when there are none.
 */
export function effectPresetMenuItems(nodeId: string, effectId: string, type: string, name: string): ContextMenuItem[] {
  const presets = pluginPresetsFor(type);
  if (presets.length === 0) return [];
  const item = (p: PluginPreset, i: number): ContextMenuItem => ({
    id: `fx-preset-${i}`,
    label: p.name,
    onSelect: () => { void applyPresetToEffectEdit(nodeId, effectId, p, name); },
  });
  const categories = [...new Set(presets.map((p) => p.category))];
  const children = categories.length > 1
    ? categories.map((c, ci): ContextMenuItem => ({
        id: `fx-preset-cat-${ci}`,
        label: c || t('effects.stack.otherCategory', 'Other'),
        children: presets.map((p, i) => (p.category === c ? item(p, i) : null)).filter((x): x is ContextMenuItem => x !== null),
      }))
    : presets.map(item);
  return [{ id: 'fx-presets', label: t('effects.stack.applyPreset', 'Apply Preset'), children }];
}

/** Right-click on an effect's header: AE's Duplicate (Ctrl+D) and Copy, Reset / Remove, and a plugin's presets. */
function effectHeaderMenuItems(nodeId: string, effectId: string, type: string, name: string, index: number, count: number): ContextMenuItem[] {
  return [
    { id: 'fx-up', label: t('effects.stack.moveUp', 'Move Up'), icon: 'arrow-up', disabled: index === 0, onSelect: () => { void nudgeEffectEdit(nodeId, effectId, -1); } },
    { id: 'fx-down', label: t('effects.stack.moveDown', 'Move Down'), icon: 'arrow-down', disabled: index === count - 1, onSelect: () => { void nudgeEffectEdit(nodeId, effectId, 1); } },
    { id: 'fx-sep0', separator: true },
    { id: 'fx-duplicate', label: t('effects.stack.duplicate', 'Duplicate'), icon: 'copy', onSelect: () => { void duplicateEffectEdit(nodeId, effectId, name); } },
    { id: 'fx-copy', label: t('effects.stack.copy', 'Copy'), onSelect: () => { void copyEffectsEdit(nodeId, [effectId]); } },
    { id: 'fx-sep', separator: true },
    ...effectPresetMenuItems(nodeId, effectId, type, name),
    { id: 'fx-reset', label: t('effects.stack.reset', 'Reset'), onSelect: () => { void resetEffectEdit(nodeId, effectId, name); } },
    { id: 'fx-remove', label: t('effects.stack.remove', 'Remove'), danger: true, onSelect: () => { void removeEffectEdit(nodeId, effectId, name); } },
  ];
}

/** The header's right-click items as the ⋯ menu's rows (one list, two openers). */
function asDropdownItems(items: ReadonlyArray<ContextMenuItem>): DropdownItem[] {
  return items.map((it): DropdownItem => (it.separator
    ? { type: 'separator' }
    : {
        type: 'item',
        id: it.id,
        label: it.label ?? '',
        icon: it.icon,
        disabled: it.disabled,
        danger: it.danger,
        onSelect: it.onSelect ? () => it.onSelect?.() : undefined,
        ...(it.children && it.children.length > 0 ? { submenu: asDropdownItems(it.children) } : {}),
      }));
}

/**
 * Liquify's brush (AE parity 5.5): the tool, size and pressure, Paint (arms
 * the canvas brush, LiquifyBrushOverlay) and Reset Mesh (clears the painted
 * field — one entry). The brush settings are editor state (liquifyBrushStore).
 */
function LiquifyBrushControls({ nodeId, effectId }: { nodeId: string; effectId: string }): JSX.Element {
  const painting = useLiquifyBrushStore((st) => st.nodeId === nodeId && st.effectId === effectId);
  const tool = useLiquifyBrushStore((st) => st.tool);
  const size = useLiquifyBrushStore((st) => st.size);
  const pressure = useLiquifyBrushStore((st) => st.pressure);
  const brush = useLiquifyBrushStore.getState();
  return (
    <ParamGroup name={t('effects.liquify.brush', 'Liquify Brush')}>
      <PropertyRow label={t('effects.liquify.tool', 'Tool')} compact>
        <select aria-label={t('effects.liquify.toolAria', 'Liquify tool')} value={tool} onChange={(ev) => brush.setTool(ev.target.value as LiquifyTool)}>
          {LIQUIFY_TOOLS.map((t) => <option key={t.tool} value={t.tool}>{t.label}</option>)}
        </select>
      </PropertyRow>
      <PropertyRow label={t('effects.liquify.size', 'Brush Size')} compact>
        <ValueField value={size} min={2} max={2000} precision={0} unit="px" onChange={brush.setSize} aria-label={t('effects.liquify.sizeAria', 'Liquify brush size')} />
      </PropertyRow>
      <PropertyRow label={t('effects.liquify.pressure', 'Brush Pressure')} compact>
        <ValueField value={pressure} min={1} max={100} precision={0} unit="%" onChange={brush.setPressure} aria-label={t('effects.liquify.pressureAria', 'Liquify brush pressure')} />
      </PropertyRow>
      <PropertyRow label="" compact>
        <span style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={painting ? 'primary' : 'secondary'}
            onClick={() => (painting ? brush.stop() : brush.start(nodeId, effectId))}
            title={painting
              ? t('effects.liquify.stopTitle', 'Stop painting ({key})', { key: 'Esc' })
              : t('effects.liquify.paintTitle', 'Paint the distortion on the canvas with the brush')}>
            {painting ? t('effects.liquify.painting', 'Painting… ({key})', { key: 'Esc' }) : t('effects.liquify.paint', 'Paint')}
          </Button>
          <Button size="sm" variant="secondary" title={t('effects.liquify.resetTitle', 'Clear the painted distortion')}
            onClick={() => {
              void edit('Reset Liquify Mesh', [
                { type: 'setProperty', prop: ref(nodeId, paths.effectParam(effectId, 'field')), value: values.json([]) },
                { type: 'setProperty', prop: ref(nodeId, paths.effectParam(effectId, 'fieldGrid')), value: values.json([]) },
              ]);
            }}>
            {t('effects.liquify.resetMesh', 'Reset Mesh')}
          </Button>
        </span>
      </PropertyRow>
    </ParamGroup>
  );
}

/** The root group of the layer's property tree the stack reads. */
const EFFECTS_ROOT: readonly string[] = ['effects'];

export function EffectStack({ nodeId }: { nodeId: string }): JSX.Element {
  // B4: the stack from the layer's mirror property tree (re-renders when the `effects` group changes — not on
  // a write elsewhere on the layer, e.g. a drag of Position).
  const tree = useMirrorTreeGroups(nodeId, EFFECTS_ROOT);
  // A plugin effect's card (its params) needs its definition, which can arrive after the stack drew.
  useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
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
        {t('effects.stack.empty', 'No active effects on this layer. Add one from the Effects panel on the right.')}
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
        // No definition: a plugin effect whose plugin is missing (or failed to
        // load). It stays in the document and passes through; say so here.
        if (!def) return <MissingPluginCard key={e.id} effect={e} name={names.get(e.id)} />;
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
            {/* AE Effect Controls header: ▾ fx Name .......... Reset ⋯.
                Reorder by dragging the header; Move Up / Move Down / Remove
                and the label colour are in the ⋯ and right-click menus. */}
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
                openContextMenu(ev.clientX, ev.clientY, effectHeaderMenuItems(nodeId, e.id, e.type, name, i, effects.length));
              }}
            >
              <button
                type="button"
                className={panel.disclosureBtn}
                onClick={() => toggleEffectCard(e.id, isCollapsed)}
                title={isCollapsed ? t('effects.stack.expand', 'Expand effect parameters') : t('effects.stack.collapse', 'Collapse effect parameters')}
              >
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              </button>

              {/* AE's fx switch: the effect on or off. Struck through when off. */}
              <button
                type="button"
                className={panel.fxToggle}
                data-on={!off || undefined}
                aria-pressed={!off}
                aria-label={off ? t('effects.stack.enableNamed', 'Enable {name}', { name }) : t('effects.stack.disableNamed', 'Disable {name}', { name })}
                title={off ? t('effects.stack.enable', 'Enable effect') : t('effects.stack.disable', 'Disable effect')}
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={() => { void setEffectEnabledEdit(nodeId, e.id, off, name); }}
              >
                fx
              </button>

              {isPluginEffectDef(def) ? <PluginHeaderIcon type={e.type} /> : null}

              {e.labelColor ? (
                <button
                  type="button"
                  className={panel.labelSwatch}
                  style={{ background: e.labelColor }}
                  title={t('effects.stack.labelColor', 'Label Color')}
                  aria-label={t('effects.stack.labelColorFor', 'Label color for {name}', { name })}
                  // Header is the drag handle — keep the swatch from starting a drag.
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openContextMenu(ev.clientX, ev.clientY, effectLabelColorMenuItems(nodeId, e.id, e.labelColor));
                  }}
                />
              ) : null}

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

              {isPluginEffectDef(def) ? (
                <PluginHeaderActions
                  nodeId={nodeId}
                  effect={e}
                  def={def}
                  presetItems={() => asDropdownItems(effectPresetMenuItems(nodeId, e.id, e.type, name)[0]?.children ?? [])}
                />
              ) : null}

              {/* AE's Reset link: a word, far right, always visible. */}
              <button
                type="button"
                className={panel.resetLink}
                title={t('effects.stack.resetTitle', 'Restore every {name} parameter to its default', { name })}
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={() => { void resetEffectEdit(nodeId, e.id, name); }}
              >
                {t('effects.stack.reset', 'Reset')}
              </button>

              {/* Move, duplicate, copy, label colour and remove: one menu, the
                  same items as the header's right-click menu (owner redesign
                  2026-10-14 — the ↑ ↓ ✕ glyphs crowded the header). */}
              <span onMouseDown={(ev) => ev.stopPropagation()}>
                <Dropdown
                  placement="bottom-end"
                  trigger={
                    <button type="button" className={panel.fxMenuBtn} aria-label={t('effects.stack.optionsFor', 'Effect options for {name}', { name })} title={t('effects.stack.options', 'Effect options')}>
                      <Icon name="more-horizontal" size="sm" />
                    </button>
                  }
                  items={() => [
                    ...asDropdownItems(effectHeaderMenuItems(nodeId, e.id, e.type, name, i, effects.length)),
                    { type: 'separator' },
                    {
                      type: 'item',
                      id: 'fx-label',
                      label: t('effects.stack.labelColor', 'Label Color'),
                      submenu: asDropdownItems(effectLabelColorMenuItems(nodeId, e.id, e.labelColor)),
                    },
                  ]}
                />
              </span>
            </div>

            {/* Accordion Body: Effect Parameters + Compositing Options */}
            {!isCollapsed && !off && (
              <div className={panel.effectParamsBody}>
                {isPluginEffectDef(def) ? (
                  <PluginEffectBody nodeId={nodeId} effect={e} def={def} />
                ) : splitParamGroups(def.params).map((section, si) => {
                  const rows = section.params.map((p) => (
                    <EffectParamRow key={p.key} nodeId={nodeId} effect={e} def={def} param={p} />
                  ));
                  return section.group
                    ? <ParamGroup key={`g:${section.group}:${si}`} name={section.group} description={builtinGroupHint(def.type, section.group)}>{rows}</ParamGroup>
                    : <Fragment key={`u:${si}`}>{rows}</Fragment>;
                })}
                {e.type === 'liquify' && <LiquifyBrushControls nodeId={nodeId} effectId={e.id} />}
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
