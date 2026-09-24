// ESLint rule `engine-reads/no-direct-document-read` — the B4 ratchet.
//
// NATIVE_CORE_PLAN §5 B4: the UI reads the document through a MIRROR fed only
// by the engine's getDocument + revisioned change events
// (src/stores/documentMirror.ts, src/hooks/useMirror.ts, docs/B4_MIRROR.md).
// Once every panel renders from the mirror, it does not matter which engine
// owns the document (F2). This rule flags every place UI code still reads the
// TypeScript engine's internals for display instead. Like the B3 write rule it
// is NOT part of `npm run lint`: it runs through `npm run lint:engine-reads`
// (scripts/lint/engineReadsReport.mjs) and the jest ratchet
// src/__tests__/engineReadRatchet.test.ts, which fails when any area's count
// goes UP.
//
// Syntactic (no type information), like every rule in this repo:
//
//   A. singleton   any use of `defaultSceneGraph` / `defaultAnimation` that is
//                  not a mutator call (those are counted by the WRITE ratchet)
//   B. timeline    any `getTimelineController()` call that is not directly a
//                  mutator call — bars, clips, markers, work area, zoom, the
//                  playhead's engine copy all live there. Transport and the
//                  ruler view go through `@core/timeline/timelineView` (a seam)
//   B'. viewport   `getWorkspaceController()` chained straight into one of its
//                  DOCUMENT reads (WORKSPACE_READS); its camera / render / tool
//                  members are view state (a seam)
//   C. helper     a call of (or reference to) a value imported from a @core
//                  module that reads the engine itself (it references a
//                  singleton, the timeline controller or a document store —
//                  decided by scanning the module's source once, ENGINE_MARKER)
//                  and whose name is not a write verb (writes: the other ratchet)
//   D. store       reads of the document stores: `useCompositionStore`,
//                  `useAssetStore`, `useSceneStore`, `useMotionBlurStore`
//                  (any read), `useProjectStore` reads that mention `comps`
//   E. revision    the legacy re-render plumbing: `useNodeRevision`,
//                  `useNodesRevision`, `useSceneRevision*`, `useAnimationRevision`,
//                  `useClipRevision`, `useNodeComponentProp`, and app-bus
//                  subscriptions to document-change events (`AnimationChanged`,
//                  `NodeUpdated`, `SceneGraphChanged`, `DocumentChanged`,
//                  `LayerReparented`)
//
// Not flagged: the engine seam itself (`@core/engine/*`: engine(), edit(),
// gestures, the write-composition helpers — the write ratchet's territory),
// type-only imports, pure @core modules (they never touch a singleton or a
// document store), the mirror and its hooks.
//
// A false positive belongs in PURE_READS below with a reason, never in an
// eslint-disable (inline disables are ignored by this config on purpose).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_MUTATORS, ANIM_MUTATORS, TIMELINE_MUTATORS, WRITE_VERB } from './engineWritesRule.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SINGLETONS = new Set(['defaultSceneGraph', 'defaultAnimation']);

/** A @core module is an engine reader when its own source mentions one of these. */
const ENGINE_MARKER = /\b(defaultSceneGraph|defaultAnimation|getTimelineController|useProjectStore|useCompositionStore|useAssetStore|useSceneStore|useMotionBlurStore|getNode\(|readNodeKind\(|catalogFor\()/;

/** @core modules that are the sanctioned seam or UI state, never counted. */
const SEAM_MODULES = [
  '@core/engine/', // engine(), edit(), gestures, propRefs / propertyCommands (write composition, B3)
  '@core/commands/CommandSystem', '@core/commands/ShortcutManager', '@core/events/', '@core/i18n',
  '@core/settings/', '@core/config/', '@core/theme/', '@core/logging/', '@core/perf/', '@core/analytics/',
  '@core/dnd/', '@core/layout/', '@core/auth/', '@core/api/client', '@core/services/',
  '@core/timeline/transportController', // transport (§6), not the document
  '@core/timeline/timelineView', // playhead / play state / loop (§6 control) and the ruler's zoom + scroll (editor view state)
  // The viewport host: camera (zoom / pan / fit / screen↔world), render requests, the content canvas and the
  // tool dispatch into the engine-side 2D tools (tools/core, the write ratchet's). Its DOCUMENT reads are
  // counted by name where the UI chains them — WORKSPACE_READS below.
  '@core/workspace/WorkspaceController',
  '@core/export/', // export jobs and file downloads, not the document
  '@core/mirror/', // the B4 read layer over the document mirror (pure)
];

/** Names imported from engine-reading modules that are nevertheless pure. Reason each. */
const PURE_READS = new Set([
  // Counted by the WRITE ratchet (its NAMED_WRITERS): a write, not a read.
  'runAnimEdit', 'beginAnimEdit', 'recordAnimEdit', 'runDocumentEdit', 'runAsOneHistoryEntry',
  'runAsOneHistoryEntrySync', 'batchHistory', 'baselineHistory', 'compToKeyframeTime',
  'makeKeyframeId', 'parseKeyframeId', 'updateNodeComponentProp',
  // Libraries and clipboards the user keeps across projects — not the document.
  'listPresets', 'exportPresets', 'presetFolder', 'listEffectPresets', 'hasEffectClipboard',
  'getTransitionItem', // core/library/transitionLibrary: a lookup in the static TRANSITION_ITEMS catalog
  // Pure string helpers living in modules that also read the scene.
  'familyKey', // core/fonts/missingFonts: normalises a family name
  'parseColorChannels', // core/effects/effects: hex → channels
  'effectPropPath', 'effectOpacityPath', // core/effects/effects: build a track name from ids
  'textPathPropPath', // core/text/textPath: build a track name
  'percentToDb', // core/audio/audioParams: unit conversion
  // B4 (checked: arguments only — no singleton, store, controller or engine default on any path).
  'maskPointsToPath', // core/workspace/toolEdits: mask points → a path Value
  'rectangleMask', 'ellipseMask', // core/effects/mask: geometry builders
  'sortedStops', 'makeStop', 'sampleGradientHex', // core/paint/fill: stop-list arithmetic, colour sampling
  'reindexRuns', // core/text/richText: grapheme run remap between two strings
  'bindPoseBones', // core/rig/skeletonCommands: maps the SkeletonRig it is given
  'isPrimitiveMeshType', 'defaultPrimitiveSpec', // core/scene/primitiveLayer: type guard, default spec table
  'motionPathTimeWindow', // core/motion/motionPath: window arithmetic
  'pickFace', 'faceHighlightGroups', // core/scene/facePicking: geometry over the faces it is given
  'thinSamples', // core/paint/paintSpace: point thinning
  'unifiedNavModeFor', // core/workspace/cameraNav: mouse button → navigation mode
  'focusRangeAt', // core/scene/camera3d: depth-of-field maths over the DofConfig it is given
  // B4 Inspector (checked: arguments only — no singleton, store, controller or engine default on any path).
  'polystarPropPath', 'polystarParamSpecs', // core/scene/polystar: a track name; the static row table per star type
  'pathOpPropPath', 'pathOpParamSpecs', // core/scene/pathOps: a track name; the static row table per operator type
  'overrideKey', 'parseOverrideKey', 'isOverridableProp', 'isValidOverrideValue', // core/scene/compInstanceOverrides: key strings, the static kind table
  'describeModifier', 'patchModifier', 'defaultModifier', 'instantiateRecipe', // core/animation/modifierStack: over the Modifier(s) given; ids from a counter
  'defaultStroke', 'normalizeStroke', // core/paint/stroke (and paint/paintStrokes): a default record; normalises the value given
  'normalizePaintOpOptions', // core/rendering/raster/paintBlend: normalises the value given
  'solidFill', 'sortedOpacityStops', 'defaultOpacityStops', 'makeOpacityStop', // core/paint/fill: paint / stop-list constructors and sorting
  'readMatte', // core/effects/matte: parses the stored matte value it is given (every legacy shape)
  'rampStyleOf', 'fittedSpeed', // core/animation/retimeCommands: easing → ramp style; speed rounding
  'hasFlag', // core/audio/audioEffects: a flag test on the AudioEffect given
  'thinLevels', // core/audio/ducking: keyframe thinning over the levels given
  'gateLevels', 'planGate', // core/audio/audioGate: gate curve and keys over the envelope given (time mapping is the caller's)
  'styledSurfaceFill', // core/effects/layerStyles: colour mixing over the LayerStyles given
  'nextFaceMaterials', // core/scene/faceMaterials: patches the FaceMaterials given
  'materialParamsOf', 'normalizeMaterialParams', // core/scene/material: reshapes / normalises the record given
  'primitiveLayerBox', // core/scene/primitiveLayer: the bounds of the mesh built from the spec given
  'isDistributeMode', // core/scene/alignNodes: a type guard over a static table
  'defaultAudioDriver', 'expressionBlocker', // core/audio/audioDriver: a default record; a check over the AudioDriver given
  'defaultAudioWaveform', // core/audio/audioWaveformGen: a default record
  'detectSilences', 'totalSilenceSec', // core/audio/silenceRemoval: analysis over the samples / ranges given
  'readAudioEffects', // core/audio/audioEffects: validates the chain on the component-shaped object given
  'hasClipboard', // core/animation/keyframeClipboard: the editor's keyframe clipboard — not the document
  'getMographItem', 'mographDuration', 'mographRestTime', // core/library/mographLibrary: the static MOGRAPH_ITEMS catalog and its choreography maths
  'amplitudeEnvelope', 'planAudioKeyframes', // core/audio/audioKeyframes: over the AudioBuffer / envelope given
  'rangesToCompIntervals', // core/audio/silenceRemoval: interval maths over the timings and ranges given
  'canSolveCamera', // core/tracking/applyTrack: a count check over the tracks given
  'describeConversion', // core/svg/svgConvert: sentences about the SvgLayerData given
  'requestExpressionEditor', 'consumeExpressionEditorRequest', 'onExpressionEditorRequest', // core/animation/expressionCommands: the editor's "open this expression field" channel — UI state, not the document
  'parentOptionsFor', // core/scene/parenting: modifier keys → reparent options
  'audioDriverExpression', // core/audio/audioDriver: expression source for the AudioDriver given
  'canGenerateProxy', 'proxyRefusal', // core/assets/proxyManager: a platform capability check; a check over the asset record given
]);

/**
 * `getWorkspaceController()` members that read the DOCUMENT (evaluated world matrices, the scene nodes, hit
 * tests through the tool port) — flagged when chained directly (`getWorkspaceController().getNodeScreenPlacement(…)`,
 * `getWorkspaceController().ws.hitTestScreen(…)`); the rest of the controller is view state (see SEAM_MODULES).
 * Gizmos get these from the engine's getLayerTransforms / hitTest queries once the viewport leaves the page (C/D5).
 */
const WORKSPACE_READS = new Set(['getNodeScreenPlacement', 'sceneNodes', 'hitTestScreen', 'scene']);

/** Document stores. `useProjectStore` only counts where the read mentions `comps`. */
const DOC_STORES = new Set(['useCompositionStore', 'useAssetStore', 'useSceneStore', 'useMotionBlurStore']);

const REVISION_HOOKS = new Set([
  'useNodeRevision', 'useNodesRevision', 'useSceneRevision', 'useSceneRevisionFrame', 'useAnimationRevision',
  'useClipRevision', 'useNodeComponentProp', 'nodeRevision', 'bumpSceneRevision',
]);

const DOC_BUS_EVENTS = new Set(['AnimationChanged', 'NodeUpdated', 'SceneGraphChanged', 'DocumentChanged', 'LayerReparented']);

// ── Module classification (once per process) ─────────────────────────────

const ALIASES = [
  ['@core/', 'src/core/'],
  ['@stores/', 'src/stores/'],
  ['@hooks/', 'src/hooks/'],
  ['@utils/', 'src/utils/'],
];

/** Package entry points whose EXPORTS are engine state (by name). */
const PACKAGE_READS = {
  '@motion/animation': new Set(['defaultAnimation', 'AnimationEngine', 'expandKeyframeProp']),
};

const readerCache = new Map();

function fileFor(source) {
  for (const [alias, dir] of ALIASES) {
    if (!source.startsWith(alias)) continue;
    const base = join(ROOT, dir, source.slice(alias.length));
    for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  return null;
}

/** Whether a module (by import source) reads the engine directly. */
export function isEngineReaderModule(source) {
  if (readerCache.has(source)) return readerCache.get(source);
  let out = false;
  if (source.startsWith('@core/') && !SEAM_MODULES.some((p) => source.startsWith(p))) {
    const file = fileFor(source);
    if (file) {
      try {
        const text = readFileSync(file, 'utf8')
          // Comments do not read anything.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        out = ENGINE_MARKER.test(text);
      } catch {
        out = false;
      }
    }
  }
  readerCache.set(source, out);
  return out;
}

// ── AST helpers ──────────────────────────────────────────────────────────

function unwrap(n) {
  let x = n;
  while (x && (x.type === 'ChainExpression' || x.type === 'TSNonNullExpression' || x.type === 'TSAsExpression')) x = x.expression;
  return x;
}

function propName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  return null;
}

function rootIdentifier(node) {
  let n = node;
  for (;;) {
    if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'CallExpression') n = n.callee;
    else if (n.type === 'ChainExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSAsExpression') n = n.expression;
    else break;
  }
  return n.type === 'Identifier' ? n.name : null;
}

/** `x.method(...)` where the member expression is the callee of a call. */
function calledMember(memberNode) {
  const parent = memberNode.parent;
  if (parent && parent.type === 'CallExpression' && unwrap(parent.callee) === memberNode) return propName(memberNode);
  if (parent && parent.type === 'ChainExpression') {
    const gp = parent.parent;
    if (gp && gp.type === 'CallExpression' && gp.callee === parent) return propName(memberNode);
  }
  return null;
}

function mentionsComps(node, sourceCode) {
  return /\bcomps\b/.test(sourceCode.getText(node));
}

const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'UI code must not read the engine directly (B4): read the document mirror (docs/B4_MIRROR.md).' },
    schema: [],
    messages: {
      read: 'B4: direct engine read ({{kind}}: {{what}}) — read the document mirror instead (docs/B4_MIRROR.md).',
    },
  },
  create(context) {
    const imports = new Map(); // local → { source, imported }
    const report = (node, kind, what) => context.report({ node, messageId: 'read', data: { kind, what } });
    const sourceCode = context.sourceCode;

    const isImportedSingleton = (name) => {
      const imp = imports.get(name);
      if (!imp) return false;
      if (imp.imported === 'default') return SINGLETONS.has(name) || imp.source.endsWith('/DefaultSceneGraph');
      return SINGLETONS.has(imp.imported);
    };

    const readerName = (imp, local) => {
      const name = imp.imported === 'default' ? local : imp.imported;
      const pkg = PACKAGE_READS[imp.source];
      if (pkg) return pkg.has(name) ? name : null;
      if (SINGLETONS.has(name)) return null; // counted as a singleton use
      if (name === 'getTimelineController') return null; // counted as a timeline use
      if (REVISION_HOOKS.has(name)) return null; // counted as revision plumbing
      if (DOC_STORES.has(name) || name === 'useProjectStore') return null; // counted as store reads
      if (!isEngineReaderModule(imp.source)) return null;
      if (PURE_READS.has(name)) return null;
      if (WRITE_VERB.test(name)) return null; // a write: the write ratchet counts it
      if (/^[A-Z_0-9]+$/.test(name)) return null; // a constant table
      return name;
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = String(node.source.value);
        for (const sp of node.specifiers) {
          if (sp.importKind === 'type') continue;
          if (sp.type === 'ImportDefaultSpecifier') imports.set(sp.local.name, { source, imported: 'default' });
          else if (sp.type === 'ImportNamespaceSpecifier') imports.set(sp.local.name, { source, imported: '*' });
          else if (sp.type === 'ImportSpecifier') {
            const imported = sp.imported.type === 'Identifier' ? sp.imported.name : String(sp.imported.value);
            imports.set(sp.local.name, { source, imported });
          }
        }
      },

      Identifier(node) {
        const parent = node.parent;
        // Declarations and import specifiers are not uses.
        if (!parent) return;
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return;
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if ((parent.type === 'Property' && parent.key === node && !parent.computed && parent.value !== node)) return;
        if (parent.type === 'TSQualifiedName' || parent.type === 'TSTypeReference' || parent.type === 'TSTypeQuery') return;
        const imp = imports.get(node.name);
        if (!imp) return;

        // A. singletons
        if (isImportedSingleton(node.name)) {
          if (parent.type === 'MemberExpression' && parent.object === node) {
            const m = calledMember(parent);
            const muts = imp.imported === 'defaultAnimation' || node.name === 'defaultAnimation' ? ANIM_MUTATORS : SCENE_MUTATORS;
            if (m && muts.has(m)) return; // a write
            report(node, 'singleton', `${node.name}.${propName(parent) ?? '[]'}`);
            return;
          }
          report(node, 'singleton', node.name);
          return;
        }

        // B. timeline controller
        if (imp.imported === 'getTimelineController') {
          if (parent.type !== 'CallExpression' || parent.callee !== node) {
            report(node, 'timeline', 'getTimelineController');
            return;
          }
          const gp = parent.parent;
          if (gp && gp.type === 'MemberExpression' && gp.object === parent) {
            const m = calledMember(gp);
            if (m && TIMELINE_MUTATORS.has(m)) return; // a write
            report(node, 'timeline', `getTimelineController().${propName(gp) ?? '[]'}`);
            return;
          }
          report(node, 'timeline', 'getTimelineController()');
          return;
        }

        // B'. the viewport host's document reads (WORKSPACE_READS), chained directly
        if (imp.imported === 'getWorkspaceController') {
          if (parent.type === 'CallExpression' && parent.callee === node) {
            const gp = parent.parent;
            if (gp && gp.type === 'MemberExpression' && gp.object === parent) {
              let m = propName(gp);
              if (m === 'ws' && gp.parent && gp.parent.type === 'MemberExpression' && gp.parent.object === gp) m = propName(gp.parent);
              if (m && WORKSPACE_READS.has(m)) report(node, 'viewport', `getWorkspaceController().${m}`);
            }
          }
          return;
        }

        // E. revision plumbing (hooks and helpers by name)
        if (REVISION_HOOKS.has(imp.imported === 'default' ? node.name : imp.imported)) {
          report(node, 'revision', imp.imported === 'default' ? node.name : imp.imported);
          return;
        }

        // D. document stores
        const storeName = imp.imported === 'default' ? node.name : imp.imported;
        if (DOC_STORES.has(storeName)) {
          report(node, 'store', storeName);
          return;
        }
        if (storeName === 'useProjectStore') {
          // Only the reads that reach the composition records.
          let top = node;
          while (top.parent && (top.parent.type === 'MemberExpression' || (top.parent.type === 'CallExpression' && top.parent.callee === top) || top.parent.type === 'ChainExpression' || top.parent.type === 'TSNonNullExpression')) top = top.parent;
          if (mentionsComps(top, sourceCode)) report(node, 'store', 'useProjectStore(comps)');
          return;
        }

        // C. helpers imported from engine-reading modules (and namespace members)
        if (imp.imported === '*') {
          if (parent.type === 'MemberExpression' && parent.object === node) {
            const member = propName(parent);
            if (member) {
              const w = readerName({ source: imp.source, imported: member }, member);
              if (w) report(node, 'helper', `${imp.source}:${w}`);
            }
          }
          return;
        }
        const w = readerName(imp, node.name);
        if (w) report(node, 'helper', `${imp.source}:${w}`);
      },

      // E. app-bus subscriptions to document-change events
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression') return;
        const m = propName(callee);
        if (m !== 'on' && m !== 'once' && m !== 'subscribe') return;
        const first = node.arguments[0];
        if (!first || first.type !== 'Literal' || typeof first.value !== 'string' || !DOC_BUS_EVENTS.has(first.value)) return;
        const root = rootIdentifier(callee.object);
        // `c.timeline.events.on('LayerAdded')` style engine emitters count via B already.
        if (root && root !== 'getEventBus' && root !== 'bus' && !/bus/i.test(root)) return;
        report(node, 'revision', `bus.${m}('${first.value}')`);
      },
    };
  },
};

export const engineReadsPlugin = {
  meta: { name: 'engine-reads', version: '1.0.0' },
  rules: { 'no-direct-document-read': rule },
};

/** For the report: the module classification is also useful on its own. */
export function listEngineReaderModules() {
  const out = [];
  const walk = (dir, alias) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${alias}${e.name}/`);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) {
        const src = `${alias}${e.name.replace(/\.tsx?$/, '')}`;
        if (isEngineReaderModule(src)) out.push(src);
      }
    }
  };
  walk(join(ROOT, 'src/core'), '@core/');
  return out;
}
