/**
 * Merge Paths — boolean ops across shape layers (polygon-clipping backed).
 */



import {
  flattenOutline,
  nodeWorldPolygon,
  booleanPolygons,
  buildMergedPaths,
  
  
  
  
} from './mergePaths';
import type { SceneNode } from '@core/types';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';

function rect(id: string, x: number, y: number, w: number, h: number): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { __kind: 'shape', x, y, width: w, height: h, shapeType: 'rect' },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ff0000' } },
    ],
  } as unknown as SceneNode;
}

function ringArea(ring: ReadonlyArray<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  }
  return Math.abs(a / 2);
}

describe('flattenOutline', () => {
  it('corner-only outlines pass through as their anchors', () => {
    const sq = [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 10, y: 0, inX: 10, inY: 0, outX: 10, outY: 0 },
      { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 },
      { x: 0, y: 10, inX: 0, inY: 10, outX: 0, outY: 10 },
    ];
    expect(flattenOutline(sq)).toHaveLength(4);
  });

  it('curved segments are subdivided', () => {
    const curved = [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 5, outY: -5 },
      { x: 10, y: 0, inX: 5, inY: -5, outX: 10, outY: 0 },
      { x: 5, y: 10, inX: 5, inY: 10, outX: 5, outY: 10 },
    ];
    expect(flattenOutline(curved, 8).length).toBeGreaterThan(3);
  });
});

describe('nodeWorldPolygon', () => {
  it('a rect layer yields its world-space corners', () => {
    const poly = nodeWorldPolygon(rect('r1', 100, 100, 40, 20))!;
    expect(poly).not.toBeNull();
    const ring = poly[0]!;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(80);
    expect(Math.max(...xs)).toBeCloseTo(120);
    expect(Math.min(...ys)).toBeCloseTo(90);
    expect(Math.max(...ys)).toBeCloseTo(110);
  });

  it('non-shapes and open strokes return null', () => {
    const open = rect('r2', 0, 0, 10, 10);
    open.components.push({ id: 'r2_g', type: 'Geometry', props: { points: [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 5, y: 5, inX: 5, inY: 5, outX: 5, outY: 5 },
      { x: 9, y: 0, inX: 9, inY: 0, outX: 9, outY: 0 },
    ], open: true } });
    expect(nodeWorldPolygon(open)).toBeNull();
  });
});

describe('booleanPolygons', () => {
  const A: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  const B: [number, number][][] = [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]];

  it('union area = a + b − overlap', () => {
    const out = booleanPolygons([A, B], 'union');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(100 + 100 - 25);
  });

  it('intersect area = overlap', () => {
    const out = booleanPolygons([A, B], 'intersect');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(25);
  });

  it('subtract area = a − overlap', () => {
    const out = booleanPolygons([A, B], 'subtract');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(75);
  });

  it('exclude area = a + b − 2·overlap', () => {
    const out = booleanPolygons([A, B], 'exclude');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(150);
  });
});

describe('buildMergedPaths (the bake, laid into a fragment)', () => {
  it('unions two rect layers into one merged layer with the base style', () => {
    const b = new FragmentBuilder();
    const { ids, sources } = buildMergedPaths(b, [rect('mp_a', 100, 100, 40, 40), rect('mp_b', 120, 100, 40, 40)], 'union');
    expect(ids).toHaveLength(1);
    expect(sources).toEqual(['mp_a', 'mp_b']);
    expect(b.component(ids[0]!, 'Style')?.props.fill).toBe('#ff0000');
    expect(Array.isArray(b.component(ids[0]!, 'Geometry')?.props.points)).toBe(true);
  });

  it('subtracts a contained rect as a hole (one layer, two subpaths), not two fills', () => {
    const b = new FragmentBuilder();
    const { ids } = buildMergedPaths(b, [rect('mp_outer', 100, 100, 80, 80), rect('mp_inner', 100, 100, 30, 30)], 'subtract');
    expect(ids).toHaveLength(1);
    const runs = b.component(ids[0]!, 'Geometry')?.props.subpaths as Array<{ points: unknown[]; open?: boolean }> | undefined;
    expect(runs).toHaveLength(2);
    expect(runs![0]!.open).toBe(false);
    expect(runs![1]!.open).toBe(false);
  });

  it('is a no-op with fewer than two mergeable (unlocked, closed) layers', () => {
    const b = new FragmentBuilder();
    expect(buildMergedPaths(b, [rect('mp_c', 0, 0, 10, 10)], 'union')).toEqual({ ids: [], sources: [] });
    const locked = { ...rect('mp_d', 5, 0, 10, 10), locked: true } as SceneNode;
    expect(buildMergedPaths(b, [rect('mp_c', 0, 0, 10, 10), locked], 'union').ids).toEqual([]);
    expect(b.size).toBe(0);
  });
});

describe('a rounded rect entering the boolean stays round', () => {
  // The primitive fallback in `nodeWorldOutline` seeded a SHARP rect no matter
  // what the layer's corner radii said, so a rounded rect entering a Merge
  // Paths boolean (or driving the path cloner) was squared off. Same class of
  // bug as the path-op chain's seed — see `cornerRadiusPathOps.test.ts`, whose
  // stand-off assertion style this reuses: the rounded outline's closest
  // approach to the sharp corner it replaced is the arc's true r(√2−1).
  const W = 160;
  const H = 120;
  const R = 40;
  const CX = 200;
  const CY = 150;
  const STAND_OFF = R * (Math.SQRT2 - 1); // ≈ 16.57

  function roundedRect(props: Record<string, number>): SceneNode {
    const n = rect('rr', CX, CY, W, H);
    const t = n.components.find((c) => c.type === 'Transform')!;
    Object.assign(t.props as Record<string, unknown>, props);
    return n;
  }

  const CORNERS = [
    { x: CX - W / 2, y: CY - H / 2 }, // TL
    { x: CX + W / 2, y: CY - H / 2 }, // TR
    { x: CX + W / 2, y: CY + H / 2 }, // BR
    { x: CX - W / 2, y: CY + H / 2 }, // BL
  ];

  function ringPoints(
    node: SceneNode,
    sample?: (prop: string) => number | undefined,
  ): Array<{ x: number; y: number }> {
    const poly = nodeWorldPolygon(node, sample);
    expect(poly).not.toBeNull();
    // Drop the GeoJSON closing vertex so the first point is not counted twice.
    return poly![0]!.slice(0, -1).map(([x, y]) => ({ x, y }));
  }

  const minDistTo = (
    pts: ReadonlyArray<{ x: number; y: number }>,
    c: { x: number; y: number },
  ): number => Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));

  it('SHARP CONTROL: without radii a vertex sits AT each corner', () => {
    const pts = ringPoints(roundedRect({}));
    for (const c of CORNERS) expect(minDistTo(pts, c)).toBeLessThan(0.75);
  });

  it('a uniform radius stands every corner off by r(√2−1)', () => {
    const pts = ringPoints(roundedRect({ cornerRadius: R }));
    expect(pts.length).toBeGreaterThan(8);
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(STAND_OFF - 1.5);
      expect(d).toBeLessThan(STAND_OFF + 1.5);
    }
  });

  it('every emitted point sits ON the rounded boundary, not merely off the corner', () => {
    const pts = ringPoints(roundedRect({ cornerRadius: R }));
    const sdf = (p: { x: number; y: number }): number => {
      const qx = Math.abs(p.x - CX) - (W / 2 - R);
      const qy = Math.abs(p.y - CY) - (H / 2 - R);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
    };
    const worst = Math.max(...pts.map((p) => Math.abs(sdf(p))));
    expect(worst).toBeLessThan(0.5);
  });

  it('per-corner radii survive: only the corner that asked is rounded', () => {
    const pts = ringPoints(roundedRect({ cornerRadiusTL: R }));
    const dTL = minDistTo(pts, CORNERS[0]!);
    expect(dTL).toBeGreaterThan(STAND_OFF - 1.5);
    expect(dTL).toBeLessThan(STAND_OFF + 1.5);
    // TR stays the sharp vertex it authored.
    expect(minDistTo(pts, CORNERS[1]!)).toBeLessThan(0.75);
  });

  it('an ANIMATED radius wins over the stored prop, like x/y/width/height do', () => {
    const pts = ringPoints(
      roundedRect({ cornerRadius: R }),
      (prop) => (prop === 'cornerRadius' ? 36 : undefined),
    );
    const expected = 36 * (Math.SQRT2 - 1);
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(expected - 1.5);
      expect(d).toBeLessThan(expected + 1.5);
    }
  });

  it('a scaled layer keeps a CIRCULAR corner in world space (axis compensation)', () => {
    // Radii are authored in comp px; the compositor undoes the layer's scale
    // for the corners alone (`cornerRadiusScale`), so the boolean's seed must
    // too — without the pair, a 2× layer's corner would be a 2×-stretched
    // ellipse the raster never draws.
    const pts = ringPoints(roundedRect({ cornerRadius: R, scaleX: 2, scaleY: 1 }));
    const scaledCorners = [
      { x: CX - W, y: CY - H / 2 },
      { x: CX + W, y: CY - H / 2 },
      { x: CX + W, y: CY + H / 2 },
      { x: CX - W, y: CY + H / 2 },
    ];
    for (const c of scaledCorners) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(STAND_OFF - 1.5);
      expect(d).toBeLessThan(STAND_OFF + 1.5);
    }
  });
});
