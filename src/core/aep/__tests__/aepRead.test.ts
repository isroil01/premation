/**
 * Reading a project: items, compositions, layers, properties, keyframes.
 *
 * Every test here writes a real chunk record with the fixture builder and
 * reads it back, so a wrong offset in either direction fails. The cases that
 * matter most are the ones where a plausible-looking mistake produces a
 * plausible-looking result — the three adjacent time rationals in `ldta`, the
 * two 128-byte keyframe layouts that differ only by a flag, the properties AE
 * omits entirely when they are at their defaults.
 */

import { parseRifx } from '../riff';
import { readAepProject } from '../aepRead';
import { findGroup, findLeaf, type AepComp } from '../aepModel';
import {
  aepFile,
  compItem,
  effect,
  folderItem,
  footageItem,
  group,
  layer,
  mask,
  maskShape,
  property,
} from '../__testHelpers__/buildAep';

const read = (bytes: Uint8Array) => readAepProject(parseRifx(bytes));

const comp = (overrides: Partial<Parameters<typeof compItem>[0]> = {}) =>
  compItem({ id: 1, name: 'Main', width: 200, height: 100, fps: 24, durationSeconds: 10, ...overrides });

describe('compositions', () => {
  it('reads size, frame rate, duration and background', () => {
    const project = read(aepFile([comp({ background: [10, 20, 30] })]));
    const main = project.comps[0]!;
    expect(main).toMatchObject({
      name: 'Main',
      width: 200,
      height: 100,
      fps: 24,
      durationSeconds: 10,
      background: { r: 10, g: 20, b: 30 },
    });
  });

  it('reads a fractional frame rate rather than truncating it', () => {
    // 29.97 is stored as an integer plus a 16-bit fraction. Reading the integer
    // alone turns every NTSC project into a 29 fps one, which drifts a second
    // out over a minute.
    const project = read(aepFile([comp({ fps: 29.97 })]));
    expect(project.comps[0]!.fps).toBeCloseTo(29.97, 3);
  });

  it('reads AE\u2019s open-ended work area as infinite', () => {
    expect(read(aepFile([comp()])).comps[0]!.workAreaEnd).toBe(Infinity);
  });

  it('carries the timebase keyframes are counted in', () => {
    expect(read(aepFile([comp({ timebase: 23976 })])).comps[0]!.internalTimebase).toBe(23976);
  });

  it('reads the After Effects version that wrote the file', () => {
    expect(read(aepFile([comp()], { aeMajor: 24, aeMinor: 6 })).aeVersion).toBe('24.6');
  });
});

describe('items', () => {
  it('reads a folder and the path of the items inside it', () => {
    const project = read(
      aepFile([folderItem(2, 'Assets', [footageItem({ id: 3, name: 'logo', width: 64, height: 64 })])]),
    );
    expect(project.footage[0]).toMatchObject({ name: 'logo', folder: ['Assets'] });
  });

  it('reads a footage item\u2019s path out of the alias JSON', () => {
    const project = read(
      aepFile([footageItem({ id: 3, name: 'plate', width: 1920, height: 1080, path: 'C:\\shots\\plate.mov' })]),
    );
    expect(project.footage[0]!.path).toBe('C:\\shots\\plate.mov');
  });

  it('reads a solid\u2019s colour and its own name', () => {
    const project = read(
      aepFile([
        footageItem({ id: 4, name: '', width: 100, height: 100, solid: { color: [1, 0.5, 0], name: 'Orange Solid' } }),
      ]),
    );
    expect(project.footage[0]).toMatchObject({ footageKind: 'solid', name: 'Orange Solid' });
    expect(project.footage[0]!.solidColor).toEqual({ r: 1, g: 0.5, b: 0 });
  });

  it('marks footage AE recorded as missing', () => {
    const project = read(aepFile([footageItem({ id: 5, name: 'gone', width: 10, height: 10, missing: true })]));
    expect(project.footage[0]!.missingAtSave).toBe(true);
  });
});

describe('layers', () => {
  const withLayer = (o: Parameters<typeof layer>[0]) => read(aepFile([comp({ layers: [layer(o)] })])).comps[0]!;

  it('reads the three adjacent time rationals in the right order', () => {
    // start time, in point and out point sit next to each other and are
    // identically shaped. An offset slipped by one field reads an out point as
    // its own reciprocal, which lands every layer at a tenth of a second.
    const c = withLayer({ id: 1, startTime: 1, inPoint: 2, outPoint: 8 });
    expect(c.layers[0]).toMatchObject({ startTime: 1, inPoint: 2, outPoint: 8 });
  });

  it('reads identity, source, parent and stacking index', () => {
    const c = read(
      aepFile([comp({ layers: [layer({ id: 1, sourceId: 9 }), layer({ id: 2, parentId: 1 })] })]),
    ).comps[0]!;
    expect(c.layers[0]).toMatchObject({ id: 1, index: 1, sourceId: 9 });
    expect(c.layers[1]).toMatchObject({ id: 2, index: 2, parentId: 1 });
  });

  it('reads the layer kind', () => {
    expect(withLayer({ id: 1, type: 2 }).layers[0]!.kind).toBe('camera');
    expect(withLayer({ id: 1, type: 3 }).layers[0]!.kind).toBe('text');
    expect(withLayer({ id: 1, type: 4 }).layers[0]!.kind).toBe('shape');
  });

  it('reads the switches out of the three flag bytes', () => {
    const l = withLayer({ id: 1, threeD: true, solo: true, shy: true, locked: true, guide: true }).layers[0]!;
    expect(l).toMatchObject({ threeD: true, solo: true, shy: true, locked: true, guide: true, enabled: true });
  });

  it('resolves a blending mode through AE\u2019s index table', () => {
    // The indices are neither contiguous nor in menu order, so this is the one
    // place the table can be wrong without anything else noticing.
    expect(withLayer({ id: 1, blendingMode: 5 }).layers[0]!.blendingMode).toBe('Multiply');
    expect(withLayer({ id: 1, blendingMode: 0 }).layers[0]!.blendingMode).toBe('Normal');
  });

  it('reads the track matte and its explicit source layer', () => {
    const l = withLayer({ id: 2, trackMatte: 2, matteLayerId: 1 }).layers[0]!;
    expect(l.trackMatte).toBe('alpha-inverted');
    expect(l.matteLayerId).toBe(1);
  });

  it('leaves an unnamed layer\u2019s name empty for the planner to resolve', () => {
    // AE shows the SOURCE's name for a layer that was never renamed, and only
    // the planner knows what the source is.
    expect(withLayer({ id: 1, displayName: '' }).layers[0]!.name).toBe('');
  });

  it('does not mistake the comp viewer\u2019s cameras for layers', () => {
    // A composition also carries `DLay`/`SLay` lists that look exactly like
    // layers. Counting those adds eleven invisible cameras to every comp.
    const c = read(aepFile([comp({ layers: [layer({ id: 1 })] })])).comps[0]!;
    expect(c.layers).toHaveLength(1);
  });
});

describe('properties', () => {
  const propsOf = (members: Uint8Array[]): AepComp =>
    read(aepFile([comp({ layers: [layer({ id: 1, properties: members })] })])).comps[0]!;

  it('reads a static value out of `cdat`', () => {
    const c = propsOf(group('ADBE Transform Group', property('ADBE Rotate Z', { dimensions: 1, value: [45] })));
    const rotate = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Transform Group'), 'ADBE Rotate Z');
    expect(rotate?.value).toEqual([45]);
  });

  it('converts a percentage property out of its stored fraction', () => {
    // Opacity and Scale are stored 0–1 and shown 0–100. A reader that skips
    // this leaves every layer at 1 % opacity.
    const c = propsOf(group('ADBE Transform Group', property('ADBE Opacity', { dimensions: 1, value: [0.5] })));
    const opacity = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Transform Group'), 'ADBE Opacity');
    expect(opacity?.value).toEqual([50]);
  });

  it('converts a colour from stored ARGB bytes to RGBA fractions', () => {
    const c = propsOf(
      group('ADBE Material Options Group', property('ADBE Shadow Color', {
        dimensions: 4,
        color: true,
        value: [255, 0, 128, 255],
      })),
    );
    const color = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Material Options Group'), 'ADBE Shadow Color');
    expect(color?.value).toEqual([0, 128 / 255, 1, 1]);
  });

  it('reads keyframes with their times, values and eases', () => {
    const c = propsOf(
      group('ADBE Transform Group', property('ADBE Rotate Z', {
        dimensions: 1,
        value: [0],
        keyframes: [
          { time: 0, value: [0], inInterp: 2, outInterp: 2, outInfluence: [0.75] },
          { time: 2, value: [90], inInterp: 2, outInterp: 2, inInfluence: [0.75] },
        ],
      })),
    );
    const rotate = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Transform Group'), 'ADBE Rotate Z');
    expect(rotate?.keyframes).toHaveLength(2);
    expect(rotate?.keyframes[0]).toMatchObject({ time: 0, value: [0], outInterpolation: 'bezier' });
    expect(rotate?.keyframes[1]!.time).toBeCloseTo(2, 6);
    expect(rotate?.keyframes[1]!.value).toEqual([90]);
    expect(rotate?.keyframes[0]!.outInfluence[0]).toBeCloseTo(0.75, 6);
  });

  it('reads a spatial keyframe\u2019s tangents, which a scalar layout would eat', () => {
    // A 3-D position keyframe and a 3-D scale keyframe are both 128 bytes. Only
    // the property's spatial flag tells them apart, and reading a position with
    // the scalar layout silently returns tangents as values.
    const c = propsOf(
      group('ADBE Transform Group', property('ADBE Position', {
        dimensions: 3,
        spatial: true,
        value: [0, 0, 0],
        keyframes: [
          { time: 0, value: [10, 20, 0], outTangent: [5, 0, 0] },
          { time: 1, value: [100, 20, 0], inTangent: [-5, 0, 0] },
        ],
      })),
    );
    const position = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Transform Group'), 'ADBE Position');
    expect(position?.keyframes[0]!.value).toEqual([10, 20, 0]);
    expect(position?.keyframes[0]!.outTangent).toEqual([5, 0, 0]);
    expect(position?.keyframes[1]!.inTangent).toEqual([-5, 0, 0]);
  });

  it('reads an expression off the property that carries it', () => {
    const c = propsOf(
      group('ADBE Transform Group', property('ADBE Rotate Z', {
        dimensions: 1,
        value: [0],
        expressionSource: 'time * 36',
      })),
    );
    const rotate = findLeaf(findGroup(c.layers[0]!.properties, 'ADBE Transform Group'), 'ADBE Rotate Z');
    expect(rotate?.expression).toBe('time * 36');
    expect(rotate?.expressionEnabled).toBe(true);
  });

  it('names an effect\u2019s parameters and keeps the effect\u2019s own name', () => {
    const c = propsOf(
      group('ADBE Effect Parade', effect('ADBE Gaussian Blur 2', 'Soft Focus', [
        { index: 1, label: 'Blurriness', value: [12] },
      ])),
    );
    const parade = findGroup(c.layers[0]!.properties, 'ADBE Effect Parade');
    const blur = findGroup(parade, 'ADBE Gaussian Blur 2');
    expect(blur?.name).toBe('Soft Focus');
    const blurriness = findLeaf(blur, 'ADBE Gaussian Blur 2-0001');
    expect(blurriness?.value).toEqual([12]);
    // The label comes from the parameter's own `pard`, which is what the
    // effect mapping matches on.
    expect(blurriness?.name).toBe('Blurriness');
  });
});

describe('masks', () => {
  it('denormalises an outline back into layer pixels', () => {
    // AE stores the vertices as fractions of a bounding box, and the box as a
    // fraction of the layer. So a box of (0.1, 0.1)–(0.5, 0.5) on a 100×100
    // layer is the rectangle (10, 10)–(50, 50) — which is what AE's own
    // scripting API reports for the same file.
    const rect = maskShape(
      { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 },
      [
        [0, 0], [0, 0], [1, 0],
        [1, 0], [1, 0], [1, 1],
        [1, 1], [1, 1], [0, 1],
        [0, 1], [0, 1], [0, 0],
      ],
    );
    const project = read(
      aepFile([
        footageItem({ id: 9, name: 'src', width: 100, height: 100 }),
        comp({
          layers: [layer({ id: 1, sourceId: 9, properties: group('ADBE Mask Parade', mask({ shape: rect, name: 'Box' })) })],
        }),
      ]),
    );
    const [m] = project.comps[0]!.layers[0]!.masks;
    expect(m?.name).toBe('Box');
    expect(m?.mode).toBe('add');
    expect(m?.shape?.closed).toBe(true);
    expect(m?.shape?.vertices.map((v) => [Math.round(v.x), Math.round(v.y)])).toEqual([
      [10, 10],
      [50, 10],
      [50, 50],
      [10, 50],
    ]);
  });

  it('measures the outline against the SOURCE, not the composition', () => {
    // The same normalised box on a 50×50 source inside a 200×100 comp is
    // (5, 5)–(25, 25). Measuring against the comp would put it at (20, 10).
    const rect = maskShape({ left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 }, [[0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [1, 1], [1, 1], [1, 1], [0, 1], [0, 1], [0, 1], [0, 0]]);
    const project = read(
      aepFile([
        footageItem({ id: 9, name: 'small', width: 50, height: 50 }),
        comp({ layers: [layer({ id: 1, sourceId: 9, properties: group('ADBE Mask Parade', mask({ shape: rect })) })] }),
      ]),
    );
    const first = project.comps[0]!.layers[0]!.masks[0]!.shape!.vertices[0]!;
    expect([Math.round(first.x), Math.round(first.y)]).toEqual([5, 5]);
  });

  it('reads the mode and inversion out of the mask\u2019s own record', () => {
    const rect = maskShape({ left: 0, top: 0, right: 1, bottom: 1 }, [[0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [1, 1], [1, 1], [1, 1], [0, 1], [0, 1], [0, 1], [0, 0]]);
    const project = read(
      aepFile([comp({ layers: [layer({ id: 1, properties: group('ADBE Mask Parade', mask({ shape: rect, mode: 2, inverted: true })) })] })]),
    );
    expect(project.comps[0]!.layers[0]!.masks[0]).toMatchObject({ mode: 'subtract', inverted: true });
  });
});
