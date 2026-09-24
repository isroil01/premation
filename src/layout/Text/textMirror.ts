/**
 * textMirror — the text area's reads over the document MIRROR (B4,
 * docs/B4_MIRROR.md). Pure functions of a `DocumentMirror`: a Text layer's
 * fields (`text/<field>`), Source Text, its animators and selectors
 * (`text/animators/<aid>/…`, rebuilt into the editor's `TextAnimatorData`
 * shape the panels were written against), Path Options and the layer's masks.
 *
 * Units and value forms are the API's (ENGINE_API.md §15.7): a field is
 * `plainValue(info.value)`, a colour is `{r,g,b,a}` 0..1 (turned into the
 * `#rrggbb[aa]` the colour pickers hold), times are comp-time flicks.
 */

import { secondsToFlicks, type PropertyInfo, type Value } from '@motion/engine-api';
import type { DocumentMirror, MirrorTree } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readRuns, type RichRun } from '@core/text/richText';
import { plainValue } from '@core/mirror/trackIndex';
import { uiKindOf } from '@core/mirror/layerKinds';
import { jsonField } from '@core/mirror/layerFields';
import type { FillPaint, LinearFill, RadialFill } from '@core/paint/fill';
import { findMatches, type FindOptions } from '@core/textTools/findReplaceText';
import { ANCHOR_GROUPINGS, interCharacterCompositeOp, type AnchorGrouping, type FillStrokeMode } from '@core/text/textMoreOptions';
import type { FindScope, ScopeCount } from '@core/textTools/textFindReplace';
import type {
  TextAnimatorData,
  SelectorData,
  RangeSelectorData,
  WigglySelectorData,
  ExpressionSelectorData,
} from '@core/text/textAnimators';

export const SOURCE_TEXT_PATH = 'text/sourceText';
export const STYLE_RUNS_PATH = 'text/styleRuns';
export const TEXT_PATH_PATH = 'text/pathOptions/path';

/** Whether the Text settings belong on this layer (a text layer, or any layer carrying a Text group). */
export function hasTextLayer(m: DocumentMirror, id: string | undefined | null): boolean {
  if (!id) return false;
  const layer = m.layer(id);
  if (!layer) return false;
  return uiKindOf(layer) === 'text' || m.tree(id)?.nodes.has('text') === true;
}

/** A Text field's plain value (`text/<key>`), or undefined when the layer has no such field. */
export function textField(m: DocumentMirror, id: string, key: string): unknown {
  return plainValue(m.property(id, `text/${key}`)?.value);
}

/** Whether Source Text carries keyframes. */
export function isSourceTextAnimated(m: DocumentMirror, id: string): boolean {
  return m.keyframes(id, SOURCE_TEXT_PATH).length > 0;
}

/** The plain string of a Source Text value (a `textDocument`, or a bare string). */
export function sourceTextOf(v: Value | undefined): string | undefined {
  if (!v) return undefined;
  if (v.kind === 'textDocument') return v.value.text;
  if (v.kind === 'string') return v.value;
  return undefined;
}

/** Source Text at comp time `seconds` (the keyed value when animated). */
export function sourceTextAt(m: DocumentMirror, id: string, seconds: number): string | undefined {
  return sourceTextOf(m.valueAt(id, SOURCE_TEXT_PATH, secondsToFlicks(seconds)));
}

/**
 * Whether the layer is a text layer with something to outline (Create Shapes /
 * Masks from Text): `canCreateShapesFromText`'s mirror twin — its Source Text
 * is not blank.
 */
export function canOutlineText(m: DocumentMirror, id: string): boolean {
  if (uiKindOf(m.layer(id)) !== 'text') return false;
  return !!sourceTextOf(m.property(id, SOURCE_TEXT_PATH)?.value)?.trim();
}

/**
 * A text layer's stroke GRADIENT (`text/strokePaint`; `readTextStrokePaint`'s
 * mirror twin): a linear or radial paint with stops, else undefined.
 */
export function mirrorTextStrokePaint(m: DocumentMirror, id: string): LinearFill | RadialFill | undefined {
  const p = jsonField<FillPaint>(m, id, 'text/strokePaint');
  return p && (p.type === 'linear' || p.type === 'radial') && Array.isArray(p.stops) && p.stops.length > 0 ? p : undefined;
}

/** The ids of a layer's masks, in stack order (`masks/<id>`). */
export function maskIdsOf(m: DocumentMirror, id: string): string[] {
  const tree = m.tree(id);
  return (tree?.nodes.get('masks')?.children ?? []).map(lastSegment);
}

/**
 * Path Options ▸ Path: the mask the text rides ('' = none). The engine resolves
 * an unset path to the layer's first mask, as the renderer does.
 */
export function textPathOf(m: DocumentMirror, id: string): string {
  const v = plainValue(m.property(id, TEXT_PATH_PATH)?.value);
  return typeof v === 'string' ? v : '';
}

/** `{r,g,b,a}` 0..1 → `#rrggbb` (`#rrggbbaa` when translucent) — the form colour pickers hold. */
export function hexOfColorValue(v: Value | undefined): string | undefined {
  if (!v || v.kind !== 'color') return undefined;
  const { r, g, b, a } = v.value;
  const c = (x: number): string => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : `${base}${c(a)}`;
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function num(info: PropertyInfo | undefined): number | undefined {
  const v = plainValue(info?.value);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(info: PropertyInfo | undefined): string | undefined {
  const v = plainValue(info?.value);
  return typeof v === 'string' ? v : undefined;
}

function bool(info: PropertyInfo | undefined): boolean | undefined {
  const v = plainValue(info?.value);
  return typeof v === 'boolean' ? v : undefined;
}

const cache = new WeakMap<MirrorTree, TextAnimatorData[]>();

/**
 * The layer's text animators, rebuilt from its mirror property tree into the
 * editor's `TextAnimatorData` shape (order = the children of
 * `text/animators`; ids = the group ids; optional properties present only when
 * the animator has them). Numeric values are the STATIC values — rows read the
 * value at the playhead through their track. Cached per tree record.
 */
export function mirrorAnimators(m: DocumentMirror, id: string): TextAnimatorData[] {
  const tree = m.tree(id);
  if (!tree) return [];
  const hit = cache.get(tree);
  if (hit) return hit;
  const node = (p: string): PropertyInfo | undefined => tree.nodes.get(p);
  const out: TextAnimatorData[] = [];
  for (const aPath of node('text/animators')?.children ?? []) {
    const group = node(aPath);
    const data: Record<string, unknown> = {
      id: lastSegment(aPath),
      ...(group?.name ? { name: group.name } : {}),
      enabled: group?.enabled !== false,
    };
    const axes: Record<string, number> = {};
    for (const pPath of node(`${aPath}/props`)?.children ?? []) {
      const info = node(pPath);
      if (!info || info.kind !== 'property') continue;
      const key = lastSegment(pPath);
      const axis = /^axis([A-Za-z0-9]{4})$/.exec(key);
      if (axis) {
        axes[axis[1]!] = num(info) ?? 0;
      } else if (info.valueType === 'color') {
        const hex = hexOfColorValue(info.value);
        if (hex) data[key] = hex;
      } else if (info.valueType === 'choice' || info.valueType === 'string') {
        const s = str(info);
        if (s !== undefined) data[key] = s;
      } else {
        const n = num(info);
        if (n !== undefined) data[key] = n;
      }
    }
    if (Object.keys(axes).length > 0) data.axes = axes;
    data.selectors = (node(`${aPath}/selectors`)?.children ?? []).map((sPath) => mirrorSelector(tree, sPath));
    // The engine reports every base property; the defaults cover a tree that
    // omits one (the shapes the panels were written against require them).
    out.push({ x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, tracking: 0, ...data } as TextAnimatorData);
  }
  cache.set(tree, out);
  return out;
}

function mirrorSelector(tree: MirrorTree, sPath: string): SelectorData {
  const node = (k: string): PropertyInfo | undefined => tree.nodes.get(`${sPath}/${k}`);
  const group = tree.nodes.get(sPath);
  const kind = (str(node('kind')) ?? 'range') as SelectorData['kind'];
  const common = {
    id: lastSegment(sPath),
    enabled: group?.enabled !== false,
    basedOn: (str(node('basedOn')) ?? 'characters') as RangeSelectorData['basedOn'],
    mode: (str(node('mode')) ?? 'add') as RangeSelectorData['mode'],
  };
  if (kind === 'wiggly') {
    const w: WigglySelectorData = {
      ...common,
      kind: 'wiggly',
      maxAmount: num(node('maxAmount')) ?? 100,
      minAmount: num(node('minAmount')) ?? -100,
      wigglesPerSecond: num(node('wigglesPerSecond')) ?? 2,
      correlation: num(node('correlation')) ?? 50,
      temporalPhase: num(node('temporalPhase')) ?? 0,
      spatialPhase: num(node('spatialPhase')) ?? 0,
      lockDimensions: bool(node('lockDimensions')) ?? false,
      randomSeed: num(node('randomSeed')) ?? 0,
    };
    return w;
  }
  if (kind === 'expression') {
    const e: ExpressionSelectorData = {
      ...common,
      kind: 'expression',
      amount: num(node('amount')) ?? 100,
      expression: str(node('expression')) ?? 'selectorValue',
    };
    return e;
  }
  const r: RangeSelectorData = {
    ...common,
    kind: 'range',
    units: (str(node('units')) ?? 'percentage') as RangeSelectorData['units'],
    start: num(node('start')) ?? 0,
    end: num(node('end')) ?? 100,
    offset: num(node('offset')) ?? 0,
    amount: num(node('amount')) ?? 100,
    shape: (str(node('shape')) ?? 'square') as RangeSelectorData['shape'],
    smoothness: num(node('smoothness')) ?? 100,
    easeHigh: num(node('easeHigh')) ?? 0,
    easeLow: num(node('easeLow')) ?? 0,
    randomizeOrder: bool(node('randomizeOrder')) ?? false,
    randomSeed: num(node('randomSeed')) ?? 0,
  };
  return r;
}

/** The font axes the layer sets beyond the registered wght / wdth / slnt (`text/axes/<tag>` → static value). */
export function storedFontAxes(m: DocumentMirror, id: string): Record<string, number> {
  const tree = m.tree(id);
  const out: Record<string, number> = {};
  for (const p of tree?.nodes.get('text/axes')?.children ?? []) {
    const tag = lastSegment(p);
    if (tag === 'wght' || tag === 'wdth' || tag === 'slnt') continue;
    const n = num(tree!.nodes.get(p));
    if (n !== undefined) out[tag] = n;
  }
  return out;
}

/**
 * Text ▸ More Options (`readTextMoreOptions`' mirror twin): Anchor Point
 * Grouping, Grouping Alignment (static values — rows read the track), Fill &
 * Stroke and Inter-Character Blending, each validated the way the legacy
 * reader validates the stored prop.
 */
export function mirrorTextMoreOptions(m: DocumentMirror, id: string): {
  anchorGrouping: AnchorGrouping;
  groupingAlignX: number;
  groupingAlignY: number;
  fillStrokeMode: FillStrokeMode;
  interCharacterBlending: string;
} {
  const grouping = textField(m, id, 'anchorGrouping');
  const blend = textField(m, id, 'interCharacterBlending');
  return {
    anchorGrouping: typeof grouping === 'string' && ANCHOR_GROUPINGS.some((g) => g.value === grouping) ? grouping as AnchorGrouping : 'character',
    groupingAlignX: num(m.property(id, 'text/groupingAlignX')) ?? 0,
    groupingAlignY: num(m.property(id, 'text/groupingAlignY')) ?? 0,
    fillStrokeMode: textField(m, id, 'fillStrokeMode') === 'allAsOne' ? 'allAsOne' : 'perCharacter',
    interCharacterBlending: typeof blend === 'string' && interCharacterCompositeOp(blend) ? blend : 'normal',
  };
}

// ── Find and Replace Text: scope and counting (textFindReplace.ts's mirror twin) ──

/** Text layers under a composition: its stack and every group's children, depth-first. */
function textLayersUnder(m: DocumentMirror, compId: string | undefined): string[] {
  const comp = compId ? m.comp(compId) : undefined;
  if (!comp) return m.layerIds().filter((id) => uiKindOf(m.layer(id)) === 'text');
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const l = m.layer(id);
    if (!l) return;
    if (uiKindOf(l) === 'text') out.push(id);
    for (const c of l.children) walk(c);
  };
  for (const id of comp.layers) walk(id);
  return out;
}

/**
 * The text layers a Find/Replace scope covers: the selected ones, the active
 * composition's (groups included), or every text layer of the project.
 */
export function mirrorTextLayersInScope(
  m: DocumentMirror,
  scope: FindScope,
  selected: ReadonlyArray<string>,
  activeComp: string | undefined,
): string[] {
  if (scope === 'selected') return selected.filter((id) => uiKindOf(m.layer(id)) === 'text');
  if (scope === 'comp') return textLayersUnder(m, activeComp);
  return m.layerIds().filter((id) => uiKindOf(m.layer(id)) === 'text');
}

/** Matches in one text layer: its static text AND every Source Text keyframe value. */
export function mirrorCountInLayer(m: DocumentMirror, id: string, find: string, opts: FindOptions): number {
  let n = 0;
  const text = sourceTextOf(m.property(id, SOURCE_TEXT_PATH)?.value);
  if (text !== undefined) n += findMatches(text, find, opts).length;
  for (const k of m.keyframes(id, SOURCE_TEXT_PATH)) {
    const s = sourceTextOf(k.value);
    if (s !== undefined) n += findMatches(s, find, opts).length;
  }
  return n;
}

export function mirrorCountInScope(
  m: DocumentMirror,
  scope: FindScope,
  selected: ReadonlyArray<string>,
  activeComp: string | undefined,
  find: string,
  opts: FindOptions,
): ScopeCount {
  let matches = 0;
  let layers = 0;
  if (!find) return { matches, layers };
  for (const id of mirrorTextLayersInScope(m, scope, selected, activeComp)) {
    const c = mirrorCountInLayer(m, id, find, opts);
    matches += c;
    if (c > 0) layers += 1;
  }
  return { matches, layers };
}

/** The static value of a registered/stored font axis (`text/axes/<tag>`), or undefined. */
export function fontAxisValue(m: DocumentMirror, id: string, tag: string): number | undefined {
  return num(m.property(id, `text/axes/${tag}`));
}

/** The active tab's composition id, at call time (editor state). */
export function activeCompIdNow(): string | undefined {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.compositionId ?? undefined : undefined;
}

/** Whether the layer has per-character style runs (`text/styleRuns`). */
export function hasMirrorStyleRuns(m: DocumentMirror, id: string): boolean {
  const v = plainValue(m.property(id, STYLE_RUNS_PATH)?.value);
  return Array.isArray(v) && v.length > 0;
}

/**
 * A text layer's per-character style runs, grapheme-indexed — the runs a
 * write composer recomputes and sends back whole (`text/styleRuns`).
 */
export function currentRuns(id: string): RichRun[] {
  // B4-gap: legacy style runs indexed by code point (`__runsIndex` unset) are migrated to grapheme
  // indices by `readRuns`; the API's `text/styleRuns` returns the stored array raw and its write stamps
  // grapheme indexing, so recomputing from it would shift an older document's styling on emoji / combining marks.
  const node = defaultSceneGraph.getNode(id);
  // B4-gap: as above.
  return node ? readRuns(node) : [];
}
