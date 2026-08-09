/**
 * Derive the editor's feature counts FROM SOURCE.
 *
 * Why this exists: every `.md` in this repo that quoted a feature count went
 * stale, and three separate audits re-derived the same numbers by hand and got
 * three different answers (effects were documented as 38 AND 58 in two tables
 * of the same file, while the registry held 73). `docs/EDITOR_REFERENCE.md`
 * quotes this script, and `src/__tests__/docFeatureCounts.test.ts` fails the
 * build when the doc and the registries disagree. A number in the doc is
 * therefore a number a test is holding down.
 *
 * Report:  node scripts/featureCounts.cjs [--verbose]
 *
 * CommonJS (not `.mjs` like its neighbours) precisely so the Jest guard can
 * `require` it: the alternative is the test re-implementing these extractors,
 * which would give the doc two sources of truth and reintroduce the drift this
 * file exists to stop.
 *
 * Every extractor reads a REGISTRY — the declaration the product actually
 * dispatches on — not a list maintained alongside one. Each throws when its
 * registry moves rather than returning 0, because a count that quietly becomes
 * zero is exactly how the previous docs rotted.
 */

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Members of a `export type X = 'a' | 'b' | …;` union. Throws if absent. */
function unionMembers(rel, typeName) {
  const src = read(rel);
  const m = src.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`, 'm'));
  if (!m) throw new Error(`featureCounts: no union \`${typeName}\` in ${rel}`);
  const members = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (members.length === 0) throw new Error(`featureCounts: union \`${typeName}\` in ${rel} is empty`);
  return members;
}

/**
 * Top-level keys of an `export const X … = { a: …, b: … };` object literal, from
 * source TEXT.
 *
 * Split from the file-reading wrapper so a test can splice a registry and prove
 * the derived count actually moves — otherwise "the count comes from the
 * registry" is itself an unverified claim, which is the genus of bug this whole
 * script exists to kill.
 */
function objectKeysIn(src, constName, where = 'source') {
  const m = src.match(new RegExp(`export const ${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`, 'm'));
  if (!m) throw new Error(`featureCounts: no object \`${constName}\` in ${where}`);
  const keys = [...m[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]);
  if (keys.length === 0) throw new Error(`featureCounts: object \`${constName}\` in ${where} is empty`);
  return keys;
}

/** Top-level keys of an `export const X … = { a: …, b: … };` object literal. */
function objectKeys(rel, constName) {
  return objectKeysIn(read(rel), constName, rel);
}

function featureCounts() {
  const effects = unionMembers('src/core/effects/effects.ts', 'EffectType');

  // The authority is the LAYER blend mode carried on `fx`, not the 16-member
  // CSS `BlendMode` in packages/scene — that one is the scene-graph paint mode,
  // and reading it instead is how 36 gets mis-reported as 16.
  const blendModes = unionMembers('src/core/effects/blendMode.ts', 'LayerBlendMode');

  // Two registries, summed. Most styles compile to an effect and live in
  // LAYER_STYLE_LABEL; the backdrop-resolved ones cannot (they are a function of
  // what is composited behind the layer, so they resolve onto the renderable —
  // see glassResolve.ts) and live in BACKDROP_STYLES.
  //
  // This used to append a literal 'glass': a hand-written number inside the
  // script that exists to eliminate hand-written numbers. Shipping a second
  // backdrop-resolved style would have left the doc's count wrong while the
  // guard test stayed green — the exact failure mode being guarded against.
  const layerStyles = [
    ...objectKeys('src/core/effects/layerStyles.ts', 'LAYER_STYLE_LABEL'),
    ...objectKeys('src/core/effects/layerStyles.ts', 'BACKDROP_STYLES'),
  ];

  // 'none' is the empty slot, not an operator.
  const pathOps = unionMembers('src/core/scene/pathOps.ts', 'PathOpType').filter((t) => t !== 'none');

  const maskModes = unionMembers('src/core/effects/mask.ts', 'MaskMode');
  const lightTypes = unionMembers('src/core/scene/light.ts', 'LightType');

  // Concrete, exported Tool implementations. The three `abstract class` bases
  // (CreateShapeTool, CreateMaskShapeTool, CreatePolyTool) are scaffolding and
  // are excluded by requiring the `export` keyword.
  const toolsSrc = read('packages/workspace/src/tools/builtin.ts');
  const tools = [...toolsSrc.matchAll(/^export class (\w+Tool)\b/gm)].map((m) => m[1]);
  if (tools.length === 0) throw new Error('featureCounts: no tools found in builtin.ts');

  // ALL_TOOL_DEFS splices these four files (including the LATE_TOOL_DEFS tail
  // in craft.ts, which used to be registered inline and bypassed the registry).
  const aiTools = ['read', 'write', 'craft', 'compose'].flatMap((f) => {
    const src = read(`packages/ai-tools/src/tools/${f}.ts`);
    return [...src.matchAll(/^ {2}name: '([a-z0-9_]+)',/gm)].map((m) => m[1]);
  });
  if (aiTools.length === 0) throw new Error('featureCounts: no AI tools found');

  const videoFormats = unionMembers('src/core/export/videoSink.ts', 'VideoFormat');
  const stillFormats = unionMembers('src/core/export/exportManager.ts', 'ExportFormat');
  const exportFormats = [...new Set([...videoFormats, ...stillFormats])];

  const stores = readdirSync(join(ROOT, 'src/stores'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''));

  const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return { effects, blendModes, layerStyles, pathOps, maskModes, lightTypes, tools, aiTools, exportFormats, stores, packages };
}

/** `{ effects: 73, blendModes: 36, … }` — just the sizes. */
function featureSizes() {
  return Object.fromEntries(Object.entries(featureCounts()).map(([k, v]) => [k, v.length]));
}

module.exports = { featureCounts, featureSizes, objectKeysIn };

if (require.main === module) {
  const all = featureCounts();
  const pad = Math.max(...Object.keys(all).map((k) => k.length));
  for (const [key, list] of Object.entries(all)) {
    console.log(`${key.padEnd(pad)}  ${String(list.length).padStart(3)}`);
  }
  if (process.argv.includes('--verbose')) {
    for (const [key, list] of Object.entries(all)) {
      console.log(`\n${key} (${list.length}):\n  ${list.join(', ')}`);
    }
  }
}
