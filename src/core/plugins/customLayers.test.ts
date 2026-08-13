/**
 * A custom layer has to survive its plugin being gone.
 *
 * This is the property that makes plugin-defined layer kinds shippable at all.
 * Documents now reference plugins, which they never did before, and the failure
 * mode that buys is severe and quiet: a user uninstalls a plugin, opens a
 * project from last year, and the layer they spent an afternoon on is simply
 * not there. Nothing errors. There is nothing to undo.
 *
 * So the round trip is asserted at every transition — installed, uninstalled,
 * reinstalled — and the assertion is on the DATA being byte-identical, not on
 * the layer merely existing.
 */

import {
  applyMigration,
  buildCustomLayerComponent,
  coerce,
  collectPluginReferences,
  customLayerComponent,
  describeState,
  isInert,
  isPluginOwned,
  ownerOf,
  readCustomLayer,
  resolveCustomLayer,
  OWNED_BY_KEY,
  type InstalledKindLookup,
} from './customLayers';
import type { LayerKindContribution } from './layerKindSchema';
import type { SceneNode } from '../types';

const KIND: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
    source: { type: 'asset', default: null, assetKind: 'image' },
  },
};

const PLUGIN = 'studio.acme.lab';

function nodeWith(...components: SceneNode['components']): SceneNode {
  return {
    id: 'n1',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  };
}

/** A lookup over a pretend installed set. */
function lookup(opts: {
  installed?: boolean;
  enabled?: boolean;
  kind?: LayerKindContribution | null;
} = {}): InstalledKindLookup {
  const { installed = true, enabled = true, kind = KIND } = opts;
  return {
    isInstalled: () => installed,
    isEnabled: () => enabled,
    find: () => kind,
  };
}

describe('storage shape', () => {
  it('namespaces by component type, so two plugins cannot collide on a prop name', () => {
    const a = buildCustomLayerComponent('studio.a.lab', KIND);
    const b = buildCustomLayerComponent('studio.b.lab', KIND);
    expect(a.type).toBe('pluginLayer:studio.a.lab.depthImage');
    expect(b.type).toBe('pluginLayer:studio.b.lab.depthImage');
    expect(a.type).not.toBe(b.type);
    // Both declare `focal`, and neither can read the other's.
    expect(a.props.focal).toBeDefined();
    expect(b.props.focal).toBeDefined();
  });

  it('stores declared props under their own names, not behind a prefix', () => {
    // This is what makes them ORDINARY properties: `writeProp` addresses
    // (nodeId, componentId, propName), and so does the animation engine. A
    // mangled name would need a special case in both.
    const c = buildCustomLayerComponent(PLUGIN, KIND);
    expect(c.props.focal).toBe(50);
    expect(c.props.mode).toBe('parallax');
    expect(c.props.source).toBeNull();
  });

  it('reads back exactly what it wrote', () => {
    const node = nodeWith(buildCustomLayerComponent(PLUGIN, KIND, { focal: 72, mode: 'displace' }));
    expect(readCustomLayer(node)).toEqual({
      kind: 'studio.acme.lab.depthImage',
      pluginId: PLUGIN,
      kindId: 'depthImage',
      schemaVersion: 1,
      props: { focal: 72, mode: 'displace', source: null },
    });
  });

  it('keeps the reserved bookkeeping keys out of the authored props', () => {
    const node = nodeWith(buildCustomLayerComponent(PLUGIN, KIND));
    const record = readCustomLayer(node)!;
    // Otherwise `__kind` would show up in the inspector as a property.
    expect(Object.keys(record.props).sort()).toEqual(['focal', 'mode', 'source']);
  });

  it('returns null for a native layer', () => {
    expect(readCustomLayer(nodeWith({ id: 'c', type: 'shape', props: { __kind: 'shape' } }))).toBeNull();
  });

  it('falls back to splitting the kind when only it was stored', () => {
    // A document written by an older build, or hand-edited. The kind string is
    // the one field that cannot be missing, so it is the one worth trusting.
    const node = nodeWith({
      id: 'c',
      type: 'pluginLayer:studio.acme.lab.depthImage',
      props: { __kind: 'studio.acme.lab.depthImage', focal: 12 },
    });
    expect(readCustomLayer(node)).toMatchObject({ pluginId: PLUGIN, kindId: 'depthImage', schemaVersion: 1 });
  });

  it('refuses a prop the kind does not declare', () => {
    const c = buildCustomLayerComponent(PLUGIN, KIND, { focal: 10, nonsense: 'x' });
    expect(c.props.nonsense).toBeUndefined();
  });
});

describe('values a plugin supplies are validated', () => {
  it('clamps a number into range rather than dropping the whole write', () => {
    // A plugin asking for 120 on a 0–100 property meant the maximum. Refusing
    // it would leave the layer at its default with nothing saying why.
    expect(coerce(KIND.props.focal!, 120)).toBe(100);
    expect(coerce(KIND.props.focal!, -5)).toBe(0);
  });

  it('refuses a value of the wrong type outright', () => {
    // Different from out-of-range: there is no sensible reading of "true" as a
    // focal length.
    expect(coerce(KIND.props.focal!, true)).toBeUndefined();
    expect(coerce(KIND.props.mode!, 'orbit')).toBeUndefined();
    expect(coerce(KIND.props.source!, 42)).toBeUndefined();
  });

  it('lets an asset slot be cleared', () => {
    expect(coerce(KIND.props.source!, null)).toBeNull();
  });
});

describe('the plugin is uninstalled, and reinstalled', () => {
  const authored = { focal: 72, mode: 'displace', source: 'asset-3' };
  const node = nodeWith(buildCustomLayerComponent(PLUGIN, KIND, authored));
  const before = JSON.stringify(readCustomLayer(node));

  it('resolves as active while it is installed', () => {
    const state = resolveCustomLayer(readCustomLayer(node)!, lookup());
    expect(state.status).toBe('active');
    expect(isInert(state)).toBe(false);
  });

  it('goes inert when the plugin is gone, and keeps every value', () => {
    const state = resolveCustomLayer(readCustomLayer(node)!, lookup({ installed: false }));
    expect(state.status).toBe('missing');
    expect(isInert(state)).toBe(true);
    // The decisive assertion: the layer is not merely still present, its data
    // is unchanged. A "preserved" layer that lost its values is not preserved.
    expect(JSON.stringify(readCustomLayer(node))).toBe(before);
  });

  it('goes inert when the plugin is merely disabled, and says which it is', () => {
    const off = resolveCustomLayer(readCustomLayer(node)!, lookup({ enabled: false }));
    expect(off.status).toBe('missing');
    expect(describeState(off)).toMatch(/is disabled/);
    // Different sentence, different fix: enable versus install.
    const gone = resolveCustomLayer(readCustomLayer(node)!, lookup({ installed: false }));
    expect(describeState(gone)).toMatch(/is not installed/);
  });

  it('goes inert when the plugin no longer provides the kind', () => {
    const state = resolveCustomLayer(readCustomLayer(node)!, lookup({ kind: null }));
    expect(state.status).toBe('unknown-kind');
    expect(describeState(state)).toMatch(/no longer provides/);
  });

  it('reactivates in place on reinstall, with the original values', () => {
    const state = resolveCustomLayer(readCustomLayer(node)!, lookup());
    expect(state.status).toBe('active');
    expect(JSON.stringify(readCustomLayer(node))).toBe(before);
    expect(readCustomLayer(node)!.props).toEqual(authored);
  });

  it('never rewrites the node while resolving', () => {
    // `resolveCustomLayer` is a read. If it ever wrote — normalising a value,
    // dropping an unknown prop — then merely OPENING a document without the
    // plugin would destroy what the plugin put there.
    const snapshot = JSON.stringify(node);
    resolveCustomLayer(readCustomLayer(node)!, lookup({ installed: false }));
    resolveCustomLayer(readCustomLayer(node)!, lookup({ kind: null }));
    expect(JSON.stringify(node)).toBe(snapshot);
  });
});

describe('schema versions', () => {
  it('asks for a migration when the plugin is newer', () => {
    const node = nodeWith(buildCustomLayerComponent(PLUGIN, KIND));
    const newer = { ...KIND, schemaVersion: 2 };
    expect(resolveCustomLayer(readCustomLayer(node)!, lookup({ kind: newer })).status)
      .toBe('needs-migration');
  });

  it('marks a DOWNGRADE inert rather than guessing', () => {
    // The document was written by a newer plugin than the one installed. The
    // older plugin cannot know what the newer one stored, so running it would
    // silently discard whatever the newer schema added.
    const node = nodeWith(buildCustomLayerComponent(PLUGIN, { ...KIND, schemaVersion: 5 }));
    const state = resolveCustomLayer(readCustomLayer(node)!, lookup({ kind: KIND }));
    expect(state.status).toBe('downgrade');
    expect(describeState(state)).toMatch(/newer version/);
  });
});

describe('applying what onMigrateLayer returned', () => {
  const v2: LayerKindContribution = {
    ...KIND,
    schemaVersion: 2,
    props: {
      focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
      focalMm: { type: 'number', default: 35, min: 8, max: 200 },
      mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
    },
  };
  /** What the layer held under v1: a carefully authored `focal`. */
  const previous = { focal: 72, mode: 'displace' };

  it('takes values the new schema accepts', () => {
    const r = applyMigration(v2, { focalMm: 85, mode: 'parallax' }, previous);
    expect(r.props).toEqual({ focal: 72, focalMm: 85, mode: 'parallax' });
    expect(r.dropped).toEqual([]);
    expect(r.quarantine).toBeUndefined();
  });

  it('KEEPS a prop the migration was not about', () => {
    /*
      The correction that matters most. A v1→v2 migration adds `focalMm` and
      says nothing about `focal`. If `focal` reset to its default here, a user
      would lose authored, animated work because a plugin author wrote a
      migration that only mentioned the new field.
    */
    const r = applyMigration(v2, { focalMm: 85 }, previous);
    expect(r.props.focal).toBe(72);
    expect(r.props.mode).toBe('displace');
  });

  it('keeps still-valid values even when the migration THREW', () => {
    // `onMigrateLayer` threw, timed out, or returned undefined. The layer must
    // not be reset to factory settings because of it.
    for (const returned of [undefined, null, 'nope', [1, 2]]) {
      const r = applyMigration(v2, returned, previous);
      expect({ returned, focal: r.props.focal, mode: r.props.mode })
        .toEqual({ returned, focal: 72, mode: 'displace' });
      // Only the genuinely new field landed on a default, and it is reported.
      expect(r.dropped).toEqual(['focalMm']);
    }
  });

  it('defaults only what fails validation against the CURRENT schema', () => {
    // Keeping a still-valid value is occasionally wrong — the plugin may have
    // reused the name for something else, which nothing here can detect.
    // Discarding it is always destructive. The two errors are not symmetric.
    const stale = { focal: 'wide', mode: 'orbit' };
    const r = applyMigration(v2, {}, stale);
    expect(r.props).toEqual({ focal: 50, focalMm: 35, mode: 'parallax' });
    expect(r.dropped).toEqual(['focal', 'focalMm', 'mode']);
  });

  it('reports a name the plugin migrated that the kind does not declare', () => {
    // The plugin believes it migrated something that will not be stored.
    const r = applyMigration(v2, { legacyZoom: 3 }, previous);
    expect(r.dropped).toContain('legacyZoom');
  });

  it('QUARANTINES the originals whenever anything was dropped', () => {
    // Recoverable beats reported: a warning tells a user their layer changed
    // and leaves them nothing to do about it.
    const r = applyMigration(v2, undefined, previous);
    expect(r.quarantine).toEqual({ schemaVersion: 2, props: previous });
  });

  it('quarantines nothing on a clean migration', () => {
    const r = applyMigration(v2, { focal: 10, focalMm: 85, mode: 'parallax' }, previous);
    expect(r.dropped).toEqual([]);
    expect(r.quarantine).toBeUndefined();
  });

  it('clamps rather than dropping a number that is merely out of range', () => {
    const r = applyMigration(v2, { focalMm: 900 }, previous);
    expect(r.props.focalMm).toBe(200);
    expect(r.dropped).toEqual([]);
  });

  it('touches nothing but props, so animation cannot be collateral', () => {
    // Keyframes live on the node's properties, keyed by (nodeId, componentId,
    // propName). This function returns values and a recovery record; it has no
    // channel through which to affect a track. `customLayerTracks.test.ts`
    // asserts the same property against the real animation engine.
    const r = applyMigration(v2, { focalMm: 85 }, previous);
    expect(Object.keys(r).sort()).toEqual(['dropped', 'props']);
  });
});

describe('generated children are marked as owned', () => {
  const child = nodeWith({ id: 'c', type: 'shape', props: { __kind: 'shape', [OWNED_BY_KEY]: PLUGIN } });

  it('says who owns them', () => {
    // So the layer tree can show it. A user editing a layer that is about to be
    // regenerated, with nothing telling them, loses the edit and has no idea
    // what happened.
    expect(isPluginOwned(child)).toBe(true);
    expect(ownerOf(child)).toBe(PLUGIN);
  });

  it('leaves an ordinary layer alone', () => {
    const plain = nodeWith({ id: 'c', type: 'shape', props: { __kind: 'shape' } });
    expect(isPluginOwned(plain)).toBe(false);
    expect(ownerOf(plain)).toBeNull();
  });
});

describe('the document s plugin manifest', () => {
  it('records every plugin a document depends on, and which kinds it uses', () => {
    const nodes = [
      nodeWith(buildCustomLayerComponent(PLUGIN, KIND)),
      nodeWith(buildCustomLayerComponent(PLUGIN, { ...KIND, id: 'rig' })),
      nodeWith(buildCustomLayerComponent('studio.other.lab', KIND)),
      nodeWith({ id: 'c', type: 'shape', props: { __kind: 'shape' } }),
    ];
    const installed = new Map([[PLUGIN, { version: '1.2.0', author: 'Acme Studio' }]]);

    expect(collectPluginReferences(nodes, installed)).toEqual([
      { id: PLUGIN, version: '1.2.0', publisher: 'Acme Studio', kinds: ['depthImage', 'rig'] },
      // Unknown version: the plugin was not installed when this was saved. The
      // id alone is still enough to tell the user what is missing.
      { id: 'studio.other.lab', kinds: ['depthImage'] },
    ]);
  });

  it('is stable between saves, so a re-save is not a diff', () => {
    const nodes = [
      nodeWith(buildCustomLayerComponent('studio.z.lab', { ...KIND, id: 'zed' })),
      nodeWith(buildCustomLayerComponent('studio.a.lab', KIND)),
      nodeWith(buildCustomLayerComponent('studio.a.lab', { ...KIND, id: 'alpha' })),
    ];
    const once = JSON.stringify(collectPluginReferences(nodes));
    const twice = JSON.stringify(collectPluginReferences([...nodes].reverse()));
    expect(once).toBe(twice);
    expect(collectPluginReferences(nodes)[0]!.id).toBe('studio.a.lab');
  });

  it('is empty for a document with no custom layers', () => {
    expect(collectPluginReferences([nodeWith({ id: 'c', type: 'shape', props: {} })])).toEqual([]);
  });
});

describe('finding the component to write to', () => {
  it('hands back the component carrying the custom layer', () => {
    const component = buildCustomLayerComponent(PLUGIN, KIND);
    expect(customLayerComponent(nodeWith(component))?.id).toBe(component.id);
  });

  it('returns null for a native layer, so a writer cannot target the wrong one', () => {
    expect(customLayerComponent(nodeWith({ id: 'c', type: 'shape', props: {} }))).toBeNull();
  });
});
