/**
 * Plugin-contributed animation presets — and the expression story behind them.
 *
 * The request this answers is "let a plugin register an expression function".
 * It cannot be done, for two independent reasons, and both are worth pinning
 * because both will be re-proposed:
 *
 *   1. An expression is evaluated inside the render, per property per frame,
 *      and plugin code lives in a Worker.
 *   2. The interpreter is a CLOSED VOCABULARY on purpose — expressions are
 *      parsed and interpreted, never `eval`'d, because `new Function` is
 *      refused by the app's CSP and relaxing that would let a shared project
 *      run code in a renderer holding the user's auth token.
 *
 * What a plugin ships instead is DATA the existing machinery already runs:
 * tracks, and expression SOURCE that goes through the same interpreter a
 * user-typed expression does.
 */

import { parseManifest, MANIFEST_VERSION } from './manifest';
import { parsePresets, MAX_PRESETS_PER_PLUGIN, MAX_KEYFRAMES_PER_TRACK } from './presetSchema';
import { pluginPresets } from '@core/animation/pluginPresets';
import { usePluginStore } from '@stores/pluginStore';

const BASE = {
  id: 'com.example.motion',
  name: 'Motion Pack',
  version: '1.0.0',
  description: 'Ships presets.',
  main: 'main.js',
  permissions: [],
};

const one = (over: Record<string, unknown> = {}) => [{
  name: 'Drift',
  tracks: [{ prop: 'transform.x', keyframes: [{ t: 0, value: 0 }] }],
  ...over,
}];

function parse(presets: unknown, apiVersion = MANIFEST_VERSION) {
  return parseManifest({ ...BASE, apiVersion, contributes: { presets } });
}

describe('declaring presets', () => {
  it('accepts a keyframe preset', () => {
    const { manifest, errors } = parse(one());
    expect(errors).toEqual([]);
    expect(manifest?.contributes.presets[0]!.name).toBe('Drift');
  });

  it('accepts a BEHAVIOUR — an expression rather than keyframes', () => {
    const { manifest, errors } = parse(one({
      tracks: [],
      expressions: [{ prop: 'transform.y', expr: 'wiggle(2, 30)' }],
    }));
    expect(errors).toEqual([]);
    expect(manifest?.contributes.presets[0]!.expressions).toEqual([
      { prop: 'transform.y', expr: 'wiggle(2, 30)' },
    ]);
  });

  it('★ refuses applyFn, which a manifest cannot carry but a string would fake', () => {
    // A string under that key arrives truthy and non-callable, and the apply
    // path would call it. Refusing by name turns a crash at apply time into a
    // publish error the author sees.
    const { errors } = parse(one({ applyFn: 'function(){}' }));
    expect(errors.join(' ')).toMatch(/applyFn/);
    expect(errors.join(' ')).toMatch(/cannot carry code/);
  });

  it('★ refuses `builtin`, so a plugin cannot file itself among the app s own', () => {
    expect(parse(one({ builtin: true })).errors.join(' ')).toMatch(/builtin/);
  });

  it('requires the grammar that introduced it', () => {
    expect(parse(one(), 5).errors.join(' ')).toMatch(/requires "apiVersion": 6/);
  });

  it('refuses two presets with one name', () => {
    const dup = [...one(), ...one()];
    expect(parse(dup).errors.join(' ')).toMatch(/two presets called "Drift"/);
  });

  it('bounds the counts rather than trusting them', () => {
    const many = Array.from({ length: MAX_PRESETS_PER_PLUGIN + 1 }, (_, i) => ({
      name: `P${i}`, tracks: [],
    }));
    expect(parse(many).errors.join(' ')).toMatch(/the limit is 32/);

    const fat = one({
      tracks: [{
        prop: 'transform.x',
        keyframes: Array.from({ length: MAX_KEYFRAMES_PER_TRACK + 1 }, (_, i) => ({ t: i, value: i })),
      }],
    });
    expect(parse(fat).errors.join(' ')).toMatch(/more than 512/);
  });

  it('★ reports a bad preset without losing the good ones beside it', () => {
    // A pack of thirty presets with one typo should install twenty-nine, not
    // nothing — and the message should name which.
    const errors: string[] = [];
    const out = parsePresets(
      [{ name: 'Good', tracks: [] }, { name: '', tracks: [] }, { name: 'AlsoGood', tracks: [] }],
      'contributes.presets',
      errors,
    );
    expect(out.map((p) => p.name)).toEqual(['Good', 'AlsoGood']);
    expect(errors.join(' ')).toMatch(/presets\[1\]\.name/);
  });

  it('does NOT syntax-check the expression, and that is deliberate', () => {
    // Parsing needs the expression engine, which the registry does not have.
    // A syntax check here would make the two validators disagree in the worse
    // direction: a preset that publishes and then refuses to install. A broken
    // expression surfaces inline and editable, like a user's own.
    const { manifest, errors } = parse(one({
      tracks: [], expressions: [{ prop: 'transform.x', expr: 'this is (not valid' }],
    }));
    expect(errors).toEqual([]);
    expect(manifest?.contributes.presets[0]!.expressions).toHaveLength(1);
  });
});

describe('the registry', () => {
  afterEach(() => usePluginStore.setState({ plugins: [] } as never));

  const install = (enabled: boolean, over: Record<string, unknown> = {}) => {
    usePluginStore.setState({
      plugins: [{ enabled, granted: [], manifest: parse(one(over)).manifest! }],
    } as never);
  };

  it('★ folders a plugin s presets under the plugin name', () => {
    // Attributable without opening the plugin manager, and a plugin cannot
    // file itself among the built-ins by naming a folder that already exists.
    install(true);
    expect(pluginPresets()[0]!.folder).toBe('Motion Pack');

    install(true, { folder: 'Camera' });
    expect(pluginPresets()[0]!.folder).toBe('Motion Pack/Camera');
  });

  it('marks them not-builtin whatever the manifest said', () => {
    install(true);
    expect(pluginPresets()[0]!.builtin).toBe(false);
  });

  it('omits a disabled plugin', () => {
    install(false);
    expect(pluginPresets()).toEqual([]);
  });
});
