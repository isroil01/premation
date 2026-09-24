// ESLint rule `engine-writes/no-direct-document-write` — the B3 ratchet.
//
// NATIVE_CORE_PLAN §5 B3: every UI write to the document goes through the
// engine API (docs/ENGINE_API.md, docs/B3_PATTERNS.md). This rule flags every
// direct write B3 still has to remove from UI code (the ENGINE_API.md §2.1 /
// §15.3 inventory). It is NOT part of `npm run lint` — its hundreds of
// warnings would swamp the repo's warning budget. It runs through
// `npm run lint:engine-writes` (scripts/lint/engineWritesReport.mjs) and the
// jest ratchet src/__tests__/engineWriteRatchet.test.ts, which fails when any
// area's count goes UP.
//
// Syntactic, like the rest of this repo's lint (no type information):
//
//   A. calls of mutators on the document singletons — `defaultSceneGraph.X()`
//      (11 core methods + fx setters), `defaultAnimation.X()`, the timeline
//      controller (`getTimelineController().X()` or a variable holding it)
//   B. calls of known write helpers by their import — `updateNodeComponentProp`,
//      `useNodeComponentProp`, `runAnimEdit`/`beginAnimEdit`/`recordAnimEdit`,
//      `runDocumentEdit`, `runAsOneHistoryEntry[Sync]`, `batchHistory`, the
//      positional keyframe id codec, `compToKeyframeTime` — and any
//      write-verb function (`set…`, `update…`, `add…`, `toggle…`, `insert…`, …)
//      imported from an engine-writing `@core/*` module
//   C. store writes — projectStore comp actions, compositionStore setters,
//      assetStore document actions, historyStore recorder calls (by
//      `useXStore.getState()…` chains and by `useXStore((s) => s.X)` selectors)
//   D. live node view assignments — `node.visible = …` (visible, locked, solo,
//      shy, color, name) on a node obtained from `getNode(…)`
//
// A false positive (a flagged name that is not a document write) belongs in
// NOT_WRITES below with a reason, never in an eslint-disable.

const SCENE_OBJECTS = new Set(['defaultSceneGraph', 'sceneGraph', 'sg', 'graph']);
const SCENE_MUTATORS = new Set([
  // core
  'addNode', 'addChild', 'setParent', 'setLocalTransform', 'setSeparateDimensions', 'removeNode',
  'setChildOrder', 'writeProp', 'addComponent', 'removeComponent', 'clear',
  // fx setters
  'setEffects', 'setBlendMode', 'setMask', 'setPuppet', 'setSkeleton', 'setMaskAnim', 'setMatte',
  'setTextPath', 'setAdjustment', 'setMotionBlur', 'setFxEnabled', 'setAutoOrient', 'setRepeater',
  'setTrimPath', 'setPathOps', 'setPrecomp', 'setFill', 'setFills', 'setStroke', 'setStrokes', 'setSolid',
  'setLayerTime', 'setLayerStyles', 'setCornerPin', 'setParticle', 'setLayerQuality', 'setGuideLayer',
  'setImageSequence', 'setPaint', 'setAudioWaveform', 'setFxKey',
]);

const ANIM_OBJECTS = new Set(['defaultAnimation', 'animation']);
const ANIM_MUTATORS = new Set([
  'setKeyframes', 'setKeyframe', 'removeKeyframe', 'moveKeyframe', 'setEasing', 'setBezier',
  'setSpatialTangent', 'clearSpatialTangents', 'smoothSpatialTangents', 'setRoving', 'updateKeyframe',
  'setSpatialInterp', 'removeTrack', 'setTrackKeyframes', 'setDataTrack', 'setDataKeyframe',
  'removeDataKeyframe', 'moveDataKeyframe', 'setDataEasing', 'setExpression', 'setExpressionEnabled',
  'setExpressionState', 'removeExpression', 'clearNode', 'clear', 'restore', 'restoreNode',
]);

const TIMELINE_MUTATORS = new Set([
  'addLayerMarkerAtPlayhead', 'addMarkerAtPlayhead', 'applyClipGeometry', 'clearWorkArea', 'deleteLayer',
  'deleteLayerForClip', 'moveMarker', 'moveSelectedEndToPlayhead', 'moveSelectedStartToPlayhead',
  'nudgeSelectedLayers', 'overlapCutBars', 'removeMarker', 'restore', 'restoreClipBars', 'rippleDeleteLayer',
  'rippleInsertGapAt', 'rippleTrimClipEnd', 'rippleTrimClipStart', 'rollEdit', 'rollEditSeconds',
  'sequenceLayerBars', 'setClipStart', 'setClipStarts', 'setDurationSeconds', 'setFrameRate', 'setWorkArea',
  'setWorkAreaIn', 'setWorkAreaOut', 'slideClip', 'slipClip', 'splitClip', 'splitSelectedAtPlayhead',
  'transferNodeClips', 'trimClipTo', 'trimSelectedEndToPlayhead', 'trimSelectedStartToPlayhead',
  'updateMarker', 'undo', 'redo',
]);

/** Store root identifier → the members that write the document (or the recorder). */
const STORE_WRITES = {
  useProjectStore: new Set(['createComp', 'removeComp', 'updateComp', 'replaceComps']),
  useCompositionStore: new Set(['update', 'setBackground', 'setBackgroundPaint', 'setTransparent', 'updateComp', 'setState']),
  useAssetStore: new Set([
    'addAsset', 'addAssetsBatch', 'removeAsset', 'removeAssets', 'createFolder', 'renameFolder', 'removeFolder',
    'moveAssetToFolder', 'setInterpretation', 'setProxy', 'setTags', 'setLabel',
  ]),
  useHistoryStore: new Set(['record', 'flush', 'runRestoring', 'schedule']),
};

/** Exact imports: source → names (`default` = the default import). */
const NAMED_WRITERS = {
  '@core/inspector/InspectorAPI': new Set(['updateNodeComponentProp', 'default']),
  '@hooks/useNodeComponentProp': new Set(['useNodeComponentProp', 'default']),
  '@core/animation/animationCommands': new Set(['runAnimEdit', 'beginAnimEdit', 'recordAnimEdit']),
  '@core/commands/documentEdit': new Set(['runDocumentEdit']),
  '@core/composition/compositeEdit': new Set(['runAsOneHistoryEntry', 'runAsOneHistoryEntrySync']),
  '@stores/historyStore': new Set(['batchHistory', 'baselineHistory']),
  '@core/timeline/TimelineController': new Set(['compToKeyframeTime']),
  '@motion/animation': new Set(['makeKeyframeId', 'parseKeyframeId']),
};

/** Write verbs for helpers imported from engine-writing @core modules. */
const WRITE_VERB = /^(add|update|remove|delete|toggle|move|set|duplicate|reorder|replace|apply|clear|reset|insert|write|rename|create|commit|keyframe|edit|group|ungroup|reparent|arrange|relink|nudge|split|trim|paste|bake|convert|precompose|align|distribute|sequence|link|unlink|merge|separate|import|freeze|reverse|enable|disable|fit)[A-Z]|^(renameLayer|alignNodes|arrangeNodes|reparentNode|insertNull|applyIk|applyFade|applyBounce|applyPreset|applyAssembly|applyDataRow|applyTransitionItem)$/;

/** @core areas that do not hold document state (view, services, rendering, tooling). */
const NOT_DOCUMENT_MODULES = [
  '@core/commands/CommandSystem', '@core/commands/ShortcutManager', '@core/events/', '@core/dnd/',
  '@core/rendering/', '@core/perf/', '@core/persistence/recovery', '@core/settings/', '@core/plugins/uiStatus',
  '@core/plugins/registry', '@core/plugins/developerMode', '@core/plugins/layerKindSchema', '@core/localIndex/',
  '@core/i18n', '@core/fonts/fontPrefs', '@core/export/', '@core/config/', '@core/api/', '@core/theme/',
  '@core/services/', '@core/analytics/', '@core/engine/', '@core/ai/', '@core/whip/', '@core/timeline/propertyTree',
  '@core/composition/assetSelection', '@core/template/templatePreview', '@core/template/batchRenderEditor',
  '@core/workspace/shapeToolPaint', '@core/audio/audioCommands', '@core/project/pendingFootage',
  '@core/inspector/pinnedProps', '@core/layout/', '@core/logging/', '@core/loading/', '@core/files/', '@core/auth/',
  '@core/cli/', '@core/application/',
  '@core/commands/shortcutOverrides', // keyboard preferences
  '@core/timeline/transportController', // transport (§6), not the document
  '@core/timeline/timelineView', // transport (§6) + ruler zoom/scroll (editor view state), not the document
  '@core/audio/audioHardware', // device selection
  '@core/tracking/samModelInstall', // model download cache
  '@core/workspace/cameraBookmarks', // viewport view state
  '@core/plugins/uiTools', // which plugin tool is active (editor state)
  '@core/plugins/uiCanvas', // plugin on-canvas draw lists (overlay, not the document)
];

/** Names that match WRITE_VERB but are not document writes. Reason each. */
const NOT_WRITES = new Set([
  // factories of players / renderers / ports / caches (view machinery)
  // (matched by NOT_WRITE_SHAPE below)
  'keyframeToCompTime', // time conversion (compToKeyframeTime is listed on its own: B3 deletes the UI calls)
  'clearRestMeshCache', // render cache
  'setFocusedExpressionRow', // which row has keyboard focus (editor state)
  'mergeRanges', // pure range arithmetic
  'mergeIntervals', // core/audio/silenceRemoval: unions comp-time intervals (pure; audioEdits sends the cuts)
  'fitSpeedFactor', // core/animation/retimeCommands: returns Fit to Footage's scale factor (pure; retimeEdits sends the keys)
  'applyTextPath', // pure glyph layout along a path (core/text/textPath)
  'resetProjectWorkspace', // project lifecycle (tabs/timelines), not an edit
  'deleteEffectPreset', 'deletePreset', 'importPresets', 'importPresetObjects', // preset LIBRARY, not the document
  'resetTransformWrites', // core/scene/layerTransformOps: the Reset defaults as a list (pure; resetEdits sends them)
  'resetInputFor', // core/scene/layerTransformOps: gathers a layer's Reset inputs (a read)
  'setVertexWeight', // core/rig/weightPaint: returns the next weight map (pure; rigEdits sends skeleton/weightPaint)
  'groupNavigatorFor', // core/mirror/selection: keyframe-navigator state for a property group (a mirror read)
  'distributeMinimum', // core/scene/alignNodes: returns the minimum layer count for a distribute mode
  'precomposeTargets', // core/composition/precompose: reads which selected layers a Pre-compose would move
  'convertFill', // core/paint/fill: returns a new FillPaint value (the caller sends it)
  'applyDeletionsToWords', // core/captions/transcriptEdit: returns the transcript words after cuts (pure)
  'applyStyleToRange', // core/text/richText: returns new style runs (pure; the caller writes them)
  'replaceAllInString', 'replaceAllWithRuns', // core/textTools/findReplaceText: return the replaced text / shifted runs (pure; textEdits sends them)
  'applyIk', // core/rig/rigDeform: solves a pose, returns new Bone objects (pure; also used by the renderer)
  'reorderSiblings', // core/scene/parenting: returns a reordered id array (pure; the caller sends reorderLayers)
  'pastePathEdit', // core/workspace/pathCommands: Edit ▸ Paste of copied vertices — ONE engine edit (setProperty / editPathTopology per target outline), not a direct write
  'setPluginPropWriteHandler', // core/scene/pluginPropWrites: REGISTERS the plugin system's write-path callback (plugins/authoredWriteHook.ts); writes nothing
  'insertCaptionLayers', // core/captions/captionLayers: ONE engine edit (deleteLayers + pasteLayers of an off-document build), not a direct write
  'importLocalAsset', // core/assets/local: content-addresses a File's bytes into the bundle BLOB store and returns a record + src (storage, dedup by hash); it adds no item — assetStore's importer (also the engine's importFiles port) does
]);
const NOT_WRITE_SHAPE = /^create\w*(Player|Renderer|Painter|Port|Cache|Backend|Store)$|ForTests?$/;

/**
 * A helper whose LAST argument is the identifier `scratch` runs on a scratch
 * AnimationEngine copy, not the document: the motion-path macros
 * (layout/Workspace/viewportEdits.ts `editPositionKeys` / `positionKeyPatchCommands`)
 * seed one with the layer's Position keys, let the legacy arithmetic
 * (`setPathTangent`, `setSpatialInterpolation`, `toggleVertexInterpolation`, …)
 * mutate it, and send the difference as one `updateKeyframes`. The same helpers
 * called WITHOUT a scratch engine default to `defaultAnimation` and still count.
 */
const SCRATCH_ENGINE_ARG = 'scratch';

/**
 * Off-document builders (src/core/engine/offDocument.ts): a function passed to
 * one of these runs against a SCRATCH state of the document that is restored
 * exactly before the call returns (and the call fails if the builder changed
 * anything but new layers); the net change reaches the document only as the
 * `pasteLayers` command the caller sends. Writer calls lexically inside such a
 * callback are scratch writes, like a helper called with a `scratch` engine.
 */
const OFF_DOCUMENT_BUILDERS = new Set(['buildLayerFragment', 'insertBuiltLayers', 'offDocument', 'assistantKeyframesEdit', 'assistantKeyframeCommands']);

function insideOffDocumentBuilder(context, node) {
  const ancestors = context.sourceCode.getAncestors(node);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== 'ArrowFunctionExpression' && a.type !== 'FunctionExpression') continue;
    const call = ancestors[i - 1];
    if (!call || call.type !== 'CallExpression' || !call.arguments.includes(a)) continue;
    const callee = unwrap(call.callee);
    const name = callee.type === 'Identifier' ? callee.name : propName(callee);
    if (name && OFF_DOCUMENT_BUILDERS.has(name)) return true;
  }
  return false;
}

/**
 * Modules that ARE a counted writer: their body's call of the underlying
 * writer is the same write every one of their call sites is already counted
 * for, so it is not a second site. Repo-relative path → reason.
 */
const WRITER_MODULES = new Map([
  ['src/hooks/useNodeComponentProp.ts', 'the legacy hook; every useNodeComponentProp() call is counted where it is made'],
]);

/**
 * A store's own module delegating to its own write action (compositionStore's
 * `setState` → `update`) is the store's implementation, not a UI call site:
 * the callers of both actions are counted where they call them.
 */
function isOwnStoreModule(relPath, storeRoot) {
  const m = /^use(\w+)Store$/.exec(storeRoot);
  if (!m) return false;
  const file = `${m[1].charAt(0).toLowerCase()}${m[1].slice(1)}Store`;
  return new RegExp(`(^|/)src/stores/${file}\\.tsx?$`).test(relPath);
}

function relPathOf(context) {
  const cwd = (context.cwd ?? process.cwd()).replace(/\\/g, '/');
  const file = (context.filename ?? '').replace(/\\/g, '/');
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}
function lastArgIsScratch(call) {
  const last = call.arguments[call.arguments.length - 1];
  return !!last && last.type === 'Identifier' && last.name === SCRATCH_ENGINE_ARG;
}

/** Module-owned write helpers under these prefixes are candidates for rule B's verb check. */
const WRITER_PREFIX = '@core/';

const VIEW_PROPS = new Set(['visible', 'locked', 'solo', 'shy', 'color', 'name']);

function rootIdentifier(node) {
  let n = node;
  for (;;) {
    if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'CallExpression') n = n.callee;
    else if (n.type === 'ChainExpression') n = n.expression;
    else if (n.type === 'TSNonNullExpression') n = n.expression;
    else break;
  }
  return n.type === 'Identifier' ? n.name : null;
}

function propName(member) {
  if (member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  return null;
}

function unwrap(n) {
  let x = n;
  while (x && (x.type === 'ChainExpression' || x.type === 'TSNonNullExpression' || x.type === 'TSAsExpression')) x = x.expression;
  return x;
}

function isCallOf(node, name) {
  const n = unwrap(node);
  return n && n.type === 'CallExpression' && ((n.callee.type === 'Identifier' && n.callee.name === name) || propName(n.callee) === name);
}

/** The initializer of the variable an identifier refers to (const/let), or null. */
function initOf(context, ident) {
  const scope = context.sourceCode.getScope(ident);
  let s = scope;
  while (s) {
    const v = s.set.get(ident.name);
    if (v) {
      const def = v.defs[0];
      if (def && def.type === 'Variable' && def.node.init) return def.node.init;
      return null;
    }
    s = s.upper;
  }
  return null;
}

const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'UI code must not write the document directly (B3): send engine API commands (docs/B3_PATTERNS.md).' },
    schema: [],
    messages: {
      write: 'B3: direct document write ({{kind}}: {{what}}) — send an engine command instead (docs/B3_PATTERNS.md).',
    },
  },
  create(context) {
    const rel = relPathOf(context);
    if (WRITER_MODULES.has(rel)) return {};
    const imports = new Map(); // local name → { source, imported }
    const report = (node, kind, what) => {
      if (insideOffDocumentBuilder(context, node)) return;
      context.report({ node, messageId: 'write', data: { kind, what } });
    };

    const writerName = (imp, local) => {
      const named = NAMED_WRITERS[imp.source];
      if (named && named.has(imp.imported)) return `${imp.imported === 'default' ? local : imp.imported}`;
      if (!imp.source.startsWith(WRITER_PREFIX)) return null;
      if (NOT_DOCUMENT_MODULES.some((p) => imp.source.startsWith(p))) return null;
      const name = imp.imported === 'default' ? local : imp.imported;
      if (NOT_WRITES.has(name) || NOT_WRITE_SHAPE.test(name)) return null;
      return WRITE_VERB.test(name) ? name : null;
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = String(node.source.value);
        for (const sp of node.specifiers) {
          if (sp.importKind === 'type') continue;
          if (sp.type === 'ImportDefaultSpecifier') imports.set(sp.local.name, { source, imported: 'default' });
          else if (sp.type === 'ImportSpecifier') {
            const imported = sp.imported.type === 'Identifier' ? sp.imported.name : String(sp.imported.value);
            imports.set(sp.local.name, { source, imported });
          }
        }
      },

      CallExpression(node) {
        const callee = unwrap(node.callee);
        // B: imported helpers
        if (callee.type === 'Identifier') {
          const imp = imports.get(callee.name);
          const w = imp ? writerName(imp, callee.name) : null;
          if (w && !lastArgIsScratch(node)) report(node, 'helper', w);
          return;
        }
        const method = propName(callee);
        if (!method) return;
        const obj = unwrap(callee.object);
        // A: singletons
        if (obj.type === 'Identifier' && SCENE_OBJECTS.has(obj.name) && SCENE_MUTATORS.has(method)) {
          report(node, 'scene graph', `${obj.name}.${method}`);
          return;
        }
        if (obj.type === 'Identifier' && ANIM_OBJECTS.has(obj.name) && ANIM_MUTATORS.has(method)) {
          report(node, 'animation', `${obj.name}.${method}`);
          return;
        }
        if (TIMELINE_MUTATORS.has(method)) {
          const isController = isCallOf(obj, 'getTimelineController')
            || (obj.type === 'Identifier' && isCallOf(initOf(context, obj), 'getTimelineController'));
          if (isController) {
            report(node, 'timeline', method);
            return;
          }
        }
        // C: store chains (useXStore.getState()…X(…))
        const root = rootIdentifier(callee.object);
        if (root && STORE_WRITES[root] && STORE_WRITES[root].has(method) && !isOwnStoreModule(rel, root)) {
          report(node, 'store', `${root}.${method}`);
          return;
        }
        // Namespace-style helper call (`sceneInsert.insertText()` via `import * as`)
        if (obj.type === 'Identifier' && imports.has(obj.name)) {
          const imp = imports.get(obj.name);
          if (imp.imported === '*') {
            const w = writerName({ source: imp.source, imported: method }, method);
            if (w && !lastArgIsScratch(node)) report(node, 'helper', w);
          }
        }
      },

      ImportNamespaceSpecifier(node) {
        const decl = node.parent;
        imports.set(node.local.name, { source: String(decl.source.value), imported: '*' });
      },

      // C: selectors — useCompositionStore((s) => s.update)
      MemberExpression(node) {
        const name = propName(node);
        if (!name) return;
        const obj = unwrap(node.object);
        if (obj.type !== 'Identifier') return;
        const fn = context.sourceCode.getAncestors(node).reverse().find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
        if (!fn || fn.params.length === 0 || fn.params[0].type !== 'Identifier' || fn.params[0].name !== obj.name) return;
        const call = fn.parent;
        if (!call || call.type !== 'CallExpression' || call.arguments[0] !== fn) return;
        const store = unwrap(call.callee);
        if (store.type !== 'Identifier' || !STORE_WRITES[store.name]) return;
        if (STORE_WRITES[store.name].has(name)) {
          report(node, 'store', `${store.name}(s => s.${name})`);
        }
      },

      // D: live node view assignments
      AssignmentExpression(node) {
        const left = unwrap(node.left);
        if (left.type !== 'MemberExpression') return;
        const name = propName(left);
        if (!name || !VIEW_PROPS.has(name)) return;
        const obj = unwrap(left.object);
        const fromGetNode = isCallOf(obj, 'getNode')
          || (obj.type === 'Identifier' && isCallOf(initOf(context, obj), 'getNode'));
        if (fromGetNode) report(node, 'node view', `.${name} =`);
      },
    };
  },
};

export const engineWritesPlugin = {
  meta: { name: 'engine-writes', version: '1.0.0' },
  rules: { 'no-direct-document-write': rule },
};

/**
 * Areas of the ratchet (src/__tests__/engineWriteRatchet.json). First match wins;
 * paths are repo-relative with forward slashes.
 */
export const AREAS = [
  ['text', /^src\/layout\/(Text\/|Inspector\/(Character|Paragraph|Text|Font|font))/],
  ['inspector', /^src\/(layout\/(Inspector|RightInspector|SceneControls)\/|components\/(Inspector|PropertyRow|MatteControl)\/)/],
  ['timeline', /^src\/layout\/(Timeline|BottomTimeline|Motion|Multicam)\//],
  ['viewport/tools', /^src\/layout\/(Workspace|LayerViewer|Paint|SourceMonitor|overlays|Scopes|Presentation)\//],
  ['effects', /^src\/layout\/Effects\//],
  ['layers', /^src\/layout\/Scene\//],
  ['comps/assets/dialogs', /^src\/(layout\/(Composition|Assets|Project|Export|RenderQueue|Templates|Swatches|Transcript)\/|pages\/)/],
  ['AI/plugins/commands', /^src\/(layout\/(AiChat|Plugins|CommandPalette|Menu|TitleBar|TopNav)\/|App\.tsx$)/],
  // Core code that writes the document on the 2D tools' behalf: the workspace
  // ports, camera navigation, device handles (src/core/workspace).
  ['tools/core', /^src\/core\/workspace\//],
  ['other', /./],
];

export function areaOf(relPath) {
  for (const [name, re] of AREAS) if (re.test(relPath)) return name;
  return 'other';
}

// Shared with the B4 read ratchet (scripts/lint/engineReadsRule.mjs): a call
// this rule counts as a WRITE is not counted there as a read too.
export { SCENE_MUTATORS, ANIM_MUTATORS, TIMELINE_MUTATORS, WRITE_VERB, STORE_WRITES };
