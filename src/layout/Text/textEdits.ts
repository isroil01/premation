/**
 * textEdits — the text area's writes over the engine API (B3,
 * docs/B3_PATTERNS.md): the Character / Paragraph panels, text animators and
 * their selectors, Source Text, Path Options, variable axes, text presets.
 *
 *   useTextParam           one keyframeable number of ONE text layer (an
 *                          animator property, a selector parameter, a Path
 *                          Options value, a font axis, Grouping Alignment):
 *                          display value, a write that keys it when animated
 *                          (AE setValueAtTime), the stopwatch, and the scrub
 *                          gesture — one undo entry per drag
 *   sourceTextCommand      Source Text at the playhead (keyed when animated)
 *   add/remove/enable …    text animator and selector groups by their ids
 *                          (`text/animators/<id>`, `…/selectors/<id>`)
 *   typewriterEdit         the Auto-Animate Typing rig as ONE entry
 *   textPresetEdit         a text style preset over the selection, one entry
 *
 * Reads stay direct (B4's mirror replaces them). What the API cannot address
 * yet funnels through the `legacy*` functions at the bottom, each marked with
 * its gap, so the remaining direct writes of this area live in few places.
 */

import type { Command, PropRef } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isLayer } from '@core/engine/doc';
import { engine } from '@core/engine/engineInstance';
import { compTime, paths, values as apiValues } from '@core/engine/propRefs';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { readPropertyValue, layerTimeFor } from '@core/inspector/multiSelection';
import { writeStaticPropertyValue } from '@core/inspector/propertyValue';
import { applyTextPreset } from '@core/inspector/sectionPresets';
import { runAnimEdit } from '@core/animation/animationCommands';
import { readAnimatorData, type SelectorKind } from '@core/text/textAnimators';
import { readRuns } from '@core/text/richText';
import type { PresetValues } from '@stores/sectionPresetStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { getTime } from '@stores/playbackClockStore';
import { componentPropsCommands } from '@layout/Inspector/useComponentProp';
import { scalarValueCommands, stopwatchCommands, trackRef } from '@layout/Inspector/inspectorEdits';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';

// ── One keyframeable number ─────────────────────────────────────────────

export interface TextParam {
  animated: boolean;
  /** The value at the playhead. */
  display: number;
  /** Write a value (a key at the playhead when animated). */
  onChange: (v: number) => void;
  /** The stopwatch. */
  toggle: () => void;
  /** ValueField scrub props: a drag is one gesture (engine route only). */
  scrub: { onScrubStart: () => void; onScrubEnd: () => void };
}

/**
 * One keyframeable number of a text layer, by its track name (`ta.0.opacity`,
 * `ta.0.s1.amount`, `text.path.firstMargin`, `text.axis.GRAD`, …).
 *
 * The engine addresses the track when the layer's catalog lists it — every
 * animator property / selector parameter row the timeline shows, Path Options
 * while the layer rides a mask, a stored font axis. A track it does not list
 * (an animator's Blur Y before it was ever written — AE's optional-property
 * rule) keeps the legacy writers below. `customStatic` overrides the static
 * write for a value stored somewhere other than its track (the wght / wdth /
 * slnt axes: `fontWeight` / `fontWidth` / `fontSlant`).
 */
export function useTextParam(
  nodeId: string,
  track: string,
  label: string,
  staticValue: number,
  customStatic?: (v: number) => void,
): TextParam {
  const time = useActiveWorkspace()?.time ?? 0;
  const e = useEngineEdit();
  const animated = defaultAnimation.isAnimated(nodeId, track);
  const display = readPropertyValue(nodeId, track, time, { read: () => staticValue }) ?? staticValue;
  const onEngine = (): boolean => trackRef(nodeId, track) !== null && (animated || !customStatic);
  return {
    animated,
    display,
    onChange: (v) => {
      if (!Number.isFinite(v)) return;
      if (!animated && customStatic) customStatic(v);
      else if (trackRef(nodeId, track)) e.send(`Set ${label}`, scalarValueCommands(track, [{ nodeId, value: v }], { seconds: time }));
      else legacyStaticWrite(nodeId, track, v);
    },
    toggle: () => {
      const r = trackRef(nodeId, track);
      const cmds = r?.animatable ? stopwatchCommands([nodeId], [track], time) : [];
      if (cmds.length > 0) e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, cmds);
      else if (!animated) legacyAnimate(nodeId, track, time, display, `Animate ${label}`);
    },
    scrub: e.scrub(`Set ${label}`, onEngine),
  };
}

// ── Source Text ─────────────────────────────────────────────────────────

/** The layer's style runs index its text: a content change through the API would drop them. */
export function hasStyleRuns(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readRuns(node).length > 0;
}

/**
 * Source Text := `text` at comp time `seconds` — a key there when Source Text
 * is animated (AE setValueAtTime), else the static text. Null when the engine
 * cannot take it: not a layer, or a static change on styled text (the API's
 * Source Text drops the style runs — ENGINE_API.md §15.4).
 */
export function sourceTextCommand(nodeId: string, text: string, seconds: number): Command | null {
  if (!isLayer(nodeId)) return null;
  const keyed = defaultAnimation.isDataAnimated(nodeId, 'text.source');
  if (!keyed && hasStyleRuns(nodeId)) return null;
  return { type: 'setProperty', prop: { layer: nodeId, path: paths.sourceText() }, value: apiValues.string(text), time: compTime(seconds) };
}

/** The Source Text stopwatch (AE: on = a key at the playhead; off = static at the playhead's value). */
export function sourceTextStopwatchCommand(nodeId: string, animated: boolean, seconds: number): Command | null {
  if (!isLayer(nodeId)) return null;
  return { type: 'setAnimated', prop: { layer: nodeId, path: paths.sourceText() }, animated, time: compTime(seconds) };
}

// ── Animators and selectors (groups, addressed by id) ───────────────────

const SELECTOR_MATCH_NAMES: Record<SelectorKind, string> = {
  range: 'ADBE Text Selector',
  wiggly: 'ADBE Text Wiggly Selector',
  expression: 'ADBE Text Expressible Selector',
};

function animatorRef(nodeId: string, animatorId: string): PropRef {
  return { layer: nodeId, path: paths.animatorGroup(animatorId) };
}

function selectorRef(nodeId: string, animatorId: string, selectorId: string): PropRef {
  return { layer: nodeId, path: paths.selectorGroup(animatorId, selectorId) };
}

/** Animate ▸ (Add): a fresh animator at the end of the stack. */
export function addAnimatorEdit(nodeId: string): Promise<unknown> {
  return edit('Add Text Animator', {
    type: 'addPropertyGroup', layer: nodeId, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator', init: [],
  });
}

export function removeAnimatorEdit(nodeId: string, animatorId: string): Promise<unknown> {
  return edit('Remove Text Animator', { type: 'removePropertyGroups', groups: [animatorRef(nodeId, animatorId)] });
}

export function setAnimatorEnabledEdit(nodeId: string, animatorId: string, enabled: boolean): Promise<unknown> {
  return edit(enabled ? 'Enable Animator' : 'Disable Animator', { type: 'setGroupEnabled', groups: [animatorRef(nodeId, animatorId)], enabled });
}

/** Add ▸ Selector ▸ <kind>: appended to the animator's stack. */
export function addSelectorEdit(nodeId: string, animatorId: string, kind: SelectorKind): Promise<unknown> {
  return edit('Add Selector', {
    type: 'addPropertyGroup', layer: nodeId, parent: `${paths.animatorGroup(animatorId)}/selectors`, matchName: SELECTOR_MATCH_NAMES[kind], init: [],
  });
}

export function removeSelectorEdit(nodeId: string, animatorId: string, selectorId: string): Promise<unknown> {
  return edit('Remove Selector', { type: 'removePropertyGroups', groups: [selectorRef(nodeId, animatorId, selectorId)] });
}

export function setSelectorEnabledEdit(nodeId: string, animatorId: string, selectorId: string, enabled: boolean): Promise<unknown> {
  return edit(enabled ? 'Enable Selector' : 'Disable Selector', { type: 'setGroupEnabled', groups: [selectorRef(nodeId, animatorId, selectorId)], enabled });
}

/**
 * Auto-Animate Typing — `applyTypewriter`'s rig as ONE entry: a new animator
 * with Opacity 0, its range selector hard-edged (Smoothness 0), and Start keyed
 * 0 → 100 % over `durationSec` from comp time `seconds`, linear. The selector's
 * id is minted by the engine, so the add and the rest run inside one gesture.
 */
export async function typewriterEdit(nodeId: string, seconds: number, durationSec = 1.5): Promise<boolean> {
  if (!isLayer(nodeId)) return false;
  const label = 'Typewriter';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return false;
  }
  let ok = false;
  const added = await client.execute({
    type: 'addPropertyGroup', layer: nodeId, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator',
    init: [{ path: 'props/opacity', value: apiValues.scalar(0) }],
  });
  if (!added.ok) reportEngineError(label, added.error);
  else {
    const animatorId = ((added.value as { groups?: string[] }).groups?.[0] ?? '').split('/')[2] ?? '';
    const node = defaultSceneGraph.getNode(nodeId);
    const selectorId = node ? readAnimatorData(node).find((a) => a.id === animatorId)?.selectors?.[0]?.id : undefined;
    if (selectorId) {
      const start: PropRef = { layer: nodeId, path: paths.selectorParam(animatorId, selectorId, 'start') };
      const res = await client.batch(label, [
        { type: 'setProperty', prop: { layer: nodeId, path: paths.selectorParam(animatorId, selectorId, 'smoothness') }, value: apiValues.scalar(0) },
        {
          type: 'addKeyframes',
          keys: [
            { prop: start, time: compTime(seconds), value: apiValues.scalar(0), easing: 'linear', spatialIn: [], spatialOut: [] },
            { prop: start, time: compTime(seconds + durationSec), value: apiValues.scalar(100), easing: 'linear', spatialIn: [], spatialOut: [] },
          ],
        },
      ]);
      if (!res.ok) reportEngineError(label, res.error);
      else ok = true;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok;
}

// ── Presets ─────────────────────────────────────────────────────────────

/**
 * A text style preset (or a Character panel preset chip) onto every text layer
 * of the selection, ONE entry. Through the engine when it addresses every
 * value on every layer (numbers the catalog lists: Font Size, Tracking…);
 * a preset that also carries a family / weight / style (strings — no API
 * property yet) keeps the pre-API bag writer for the WHOLE preset, so it stays
 * one undo entry instead of splitting in two.
 */
export function textPresetEdit(nodeIds: ReadonlyArray<string>, values: PresetValues, label = 'Apply Text preset'): void {
  const seconds = getTime();
  const cmds: Command[] = [];
  let legacy = false;
  for (const id of nodeIds) {
    const comp = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Text');
    if (!comp) continue;
    const r = componentPropsCommands(id, comp.id, values, seconds);
    if (Object.keys(r.rest).length > 0) { legacy = true; break; }
    cmds.push(...r.cmds);
  }
  if (legacy) {
    legacyTextPreset(nodeIds, values);
    return;
  }
  void edit(label, cmds);
}

// ── Legacy funnels (engine gaps) ────────────────────────────────────────

/** A text preset with values the API cannot address (see `textPresetEdit`). */
function legacyTextPreset(nodeIds: ReadonlyArray<string>, values: PresetValues): void {
  // B3-legacy: engine gap — Text component string props (fontFamily / fontWeight / fontStyle / align …) have no API property; one batchHistory entry.
  applyTextPreset(nodeIds, values);
}

/** A static write on a track the layer's catalog does not list yet (see `useTextParam`). */
function legacyStaticWrite(nodeId: string, track: string, v: number): void {
  // B3-legacy: engine gap — optional animator properties (Blur Y before its first write, AE's
  // optional-property rule) have no API property until stored; recorded by the history debounce.
  writeStaticPropertyValue(nodeId, track, v);
}

/** The stopwatch on a track the engine cannot address (same gap as `legacyStaticWrite`). */
function legacyAnimate(nodeId: string, track: string, seconds: number, value: number, label: string): void {
  // B3-legacy: engine gap — `setAnimated` needs a catalog property (an unstored optional animator
  // property, a wght/wdth/slnt axis stored as fontWeight/fontWidth/fontSlant).
  runAnimEdit(label, () => defaultAnimation.setKeyframe(nodeId, track, layerTimeFor(nodeId, track, seconds), value));
}
