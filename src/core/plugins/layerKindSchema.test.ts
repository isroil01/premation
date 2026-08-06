/**
 * What a plugin may declare as a layer kind, and what it may not.
 *
 * Every rejection here is one an author would otherwise discover from a user.
 * A default that violates its own `min` produces a layer that is invalid the
 * moment it is created; an `animatable: true` on a string produces a property
 * that silently refuses to keyframe in the graph editor; a `render` value the
 * host does not implement produces a layer that appears in the tree and never
 * draws. None of those fail at install time unless they are failed here.
 */

import {
  parseLayerKinds,
  splitKind,
  namespacedKind,
  defaultProps,
  MAX_KINDS_PER_PLUGIN,
  MAX_PROPS_PER_KIND,
} from './layerKindSchema';
import { parseManifest, HOST_API_VERSION } from './manifest';
import { ICON_NAMES } from '@components/Icon/iconNames';

const ICONS = new Set<string>(ICON_NAMES);

/** Validate one kind, returning what survived plus every message. */
function parseOne(kind: unknown): { kinds: ReturnType<typeof parseLayerKinds>; errors: string[] } {
  const errors: string[] = [];
  const kinds = parseLayerKinds([kind], errors, ICONS);
  return { kinds, errors };
}

const VALID = {
  id: 'depthImage',
  label: 'Depth Image',
  icon: 'image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    source: { type: 'asset', assetKind: 'image' },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

describe('a well-formed kind', () => {
  it('is accepted whole', () => {
    const { kinds, errors } = parseOne(VALID);
    expect(errors).toEqual([]);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toMatchObject({ id: 'depthImage', render: 'proxy', schemaVersion: 1 });
  });

  it('yields a starting value for every declared property', () => {
    const { kinds } = parseOne(VALID);
    // An asset slot defaults to null: there is no asset id a package can name
    // that exists in someone else's project.
    expect(defaultProps(kinds[0]!)).toEqual({ focal: 50, source: null, mode: 'parallax' });
  });
});

describe('the render strategy', () => {
  it.each(['none', 'proxy'])('accepts %s', (render) => {
    const { errors } = parseOne({ ...VALID, render });
    expect(errors).toEqual([]);
  });

  it('refuses "shader" as RESERVED, not as unknown', () => {
    // Two different problems with two different fixes: "wait for Phase 4" and
    // "you made a typo". An author told "unknown render strategy" goes looking
    // for the correct spelling of something that does not exist yet.
    const { errors } = parseOne({ ...VALID, render: 'shader' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/reserved and not supported in this version/);
    expect(errors[0]).not.toMatch(/must be one of/);
  });

  it('refuses an unknown strategy by listing what is valid', () => {
    const { errors } = parseOne({ ...VALID, render: 'canvas' });
    expect(errors[0]).toMatch(/must be one of: none, proxy/);
  });

  it('requires one at all', () => {
    const { render, ...noRender } = VALID;
    expect(parseOne(noRender).errors[0]).toMatch(/render.*must be one of/);
  });
});

describe('property types', () => {
  it('refuses animatable on a type the interpolator cannot handle', () => {
    for (const type of ['string', 'enum', 'asset'] as const) {
      const props = { x: { type, default: type === 'enum' ? 'a' : 'x', values: ['a'], animatable: true } };
      const { errors } = parseOne({ ...VALID, props });
      expect({ type, matched: errors.some((e) => /only supported for number, color, boolean/.test(e)) })
        .toEqual({ type, matched: true });
    }
  });

  it.each(['number', 'color', 'boolean'])('allows animatable on %s', (type) => {
    const defaults: Record<string, unknown> = { number: 1, color: '#ff8800', boolean: true };
    const { errors } = parseOne({
      ...VALID,
      props: { x: { type, default: defaults[type], animatable: true } },
    });
    expect(errors).toEqual([]);
  });

  it('refuses an unknown type', () => {
    const { errors } = parseOne({ ...VALID, props: { x: { type: 'vector3', default: 0 } } });
    expect(errors[0]).toMatch(/must be one of: number, string, boolean, enum, color, asset/);
  });
});

describe('defaults are checked against their own constraints', () => {
  it('refuses a number below its min', () => {
    const { errors } = parseOne({ ...VALID, props: { x: { type: 'number', default: -5, min: 0, max: 10 } } });
    expect(errors[0]).toMatch(/is below "min" \(0\)/);
  });

  it('refuses a number above its max', () => {
    const { errors } = parseOne({ ...VALID, props: { x: { type: 'number', default: 50, min: 0, max: 10 } } });
    expect(errors[0]).toMatch(/is above "max" \(10\)/);
  });

  it('refuses an enum default that is not one of its own values', () => {
    const { errors } = parseOne({
      ...VALID,
      props: { x: { type: 'enum', values: ['a', 'b'], default: 'c' } },
    });
    expect(errors[0]).toMatch(/must be one of the declared values: a, b/);
  });

  it('refuses a default of the wrong type', () => {
    expect(parseOne({ ...VALID, props: { x: { type: 'number', default: '5' } } }).errors[0])
      .toMatch(/must be a finite number/);
    expect(parseOne({ ...VALID, props: { x: { type: 'boolean', default: 'yes' } } }).errors[0])
      .toMatch(/must be true or false/);
    expect(parseOne({ ...VALID, props: { x: { type: 'color', default: 'reddish' } } }).errors[0])
      .toMatch(/must be a colour/);
  });

  it('requires one, except for an asset slot', () => {
    expect(parseOne({ ...VALID, props: { x: { type: 'number' } } }).errors[0]).toMatch(/is required/);
    // An asset id means nothing in another project, so a package cannot name one.
    expect(parseOne({ ...VALID, props: { x: { type: 'asset' } } }).errors).toEqual([]);
    expect(parseOne({ ...VALID, props: { x: { type: 'asset', default: 'asset-7' } } }).errors[0])
      .toMatch(/cannot be set for an asset property/);
  });

  it('refuses min greater than max, before it can reject every value', () => {
    const { errors } = parseOne({ ...VALID, props: { x: { type: 'number', default: 5, min: 10, max: 0 } } });
    expect(errors[0]).toMatch(/is greater than/);
  });
});

describe('names and shapes', () => {
  it.each(['Depth', 'depth-image', 'depth.image', '1depth', '', 'a'.repeat(33)])(
    'refuses the kind id %p',
    (id) => {
      expect(parseOne({ ...VALID, id }).errors[0]).toMatch(/\.id" must be camelCase/);
    },
  );

  it('refuses a prop name with a dot, which the host joins on', () => {
    const { errors } = parseOne({ ...VALID, props: { 'a.b': { type: 'number', default: 0 } } });
    expect(errors[0]).toMatch(/must be camelCase/);
  });

  it('refuses a duplicate kind id rather than letting the last one win', () => {
    const errors: string[] = [];
    parseLayerKinds([VALID, VALID], errors, ICONS);
    expect(errors[0]).toMatch(/duplicates an earlier layer kind "depthImage"/);
  });

  it('refuses a kind with no properties', () => {
    // A layer type with no properties has no interface to author, so it is
    // almost certainly an unfinished manifest rather than an intention.
    const { errors } = parseOne({ ...VALID, props: {} });
    expect(errors[0]).toMatch(/declares nothing/);
  });

  it('refuses an icon this editor does not have', () => {
    const { errors } = parseOne({ ...VALID, icon: 'sparkle-explosion' });
    expect(errors[0]).toMatch(/not an icon this editor has/);
  });

  it('requires a monotonic schemaVersion', () => {
    for (const schemaVersion of [0, -1, 1.5, '1', undefined]) {
      expect(parseOne({ ...VALID, schemaVersion }).errors[0]).toMatch(/schemaVersion/);
    }
  });

  it('drops a kind whole when one property is bad', () => {
    // Half a schema renders half an inspector, and the author debugs a missing
    // row instead of reading an error.
    const { kinds, errors } = parseOne({
      ...VALID,
      props: { good: { type: 'number', default: 1 }, bad: { type: 'number', default: 'x' } },
    });
    expect(kinds).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('caps', () => {
  it('refuses more kinds than the editor can render', () => {
    const many = Array.from({ length: MAX_KINDS_PER_PLUGIN + 1 }, (_, i) => ({ ...VALID, id: `kind${i}` }));
    const errors: string[] = [];
    parseLayerKinds(many, errors, ICONS);
    expect(errors[0]).toMatch(new RegExp(`the limit is ${MAX_KINDS_PER_PLUGIN}`));
  });

  it('refuses more props than an inspector can show', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PROPS_PER_KIND; i += 1) props[`p${i}`] = { type: 'number', default: 0 };
    expect(parseOne({ ...VALID, props }).errors[0]).toMatch(new RegExp(`the limit is ${MAX_PROPS_PER_KIND}`));
  });
});

describe('namespacing', () => {
  it('splits on the LAST dot, because a plugin id contains dots too', () => {
    // `slice` from the first dot would attribute this to a plugin called
    // "studio" — which exists in no registry and matches no installed package.
    expect(splitKind('studio.acme.easing-lab.depthImage'))
      .toEqual({ pluginId: 'studio.acme.easing-lab', kindId: 'depthImage' });
  });

  it('round-trips', () => {
    const id = namespacedKind('studio.acme.lab', 'depthImage');
    expect(splitKind(id)).toEqual({ pluginId: 'studio.acme.lab', kindId: 'depthImage' });
  });

  it('refuses a bare kind with no plugin, so a native kind is never mistaken for one', () => {
    expect(splitKind('shape')).toBeNull();
    expect(splitKind('.depthImage')).toBeNull();
    expect(splitKind('studio.acme.')).toBeNull();
    // A trailing segment that is not a valid kind id is not a custom layer.
    expect(splitKind('studio.acme.Depth-Image')).toBeNull();
  });
});

describe('the manifest gate', () => {
  it('requires apiVersion 3', () => {
    const { manifest, errors } = parseManifest({
      id: 'studio.acme.lab',
      name: 'Lab',
      version: '1.0.0',
      description: 'x',
      apiVersion: 2,
      main: 'main.js',
      permissions: [],
      contributes: { layerKinds: [VALID] },
    });
    expect(manifest).toBeNull();
    expect(errors[0]).toMatch(/requires "apiVersion": 3/);
  });

  it('accepts them at apiVersion 3, and the host is at least that', () => {
    const { manifest, errors } = parseManifest({
      id: 'studio.acme.lab',
      name: 'Lab',
      version: '1.0.0',
      description: 'x',
      apiVersion: 3,
      main: 'main.js',
      permissions: [],
      contributes: { layerKinds: [VALID] },
    });
    expect(errors).toEqual([]);
    expect(manifest?.contributes.layerKinds).toHaveLength(1);
    expect(HOST_API_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('lets a document-changing contribution be seen before install', () => {
    const { manifest } = parseManifest({
      id: 'studio.acme.lab',
      name: 'Lab',
      version: '1.0.0',
      description: 'x',
      apiVersion: 3,
      main: 'main.js',
      permissions: [],
      contributes: { layerKinds: [VALID] },
    });
    // It is listed in the summary because it is the contribution that leaves
    // something behind in a project after an uninstall.
    const { describeContributions } = require('./manifest') as typeof import('./manifest');
    expect(describeContributions(manifest!.contributes)).toContain('1 layer type');
  });

  it('refuses an onLayerKind activation for a kind that was never declared', () => {
    const { errors } = parseManifest({
      id: 'studio.acme.lab',
      name: 'Lab',
      version: '1.0.0',
      description: 'x',
      apiVersion: 3,
      main: 'main.js',
      permissions: [],
      contributes: { layerKinds: [VALID] },
      activationEvents: ['onLayerKind:nope'],
    });
    // An event that can never fire presents as a plugin that simply never
    // starts, with nothing anywhere saying why.
    expect(errors[0]).toMatch(/refers to layer kind "nope"/);
  });
});
