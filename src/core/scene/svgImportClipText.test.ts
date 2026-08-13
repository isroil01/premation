/**
 * The last of the animated-SVG fidelity gaps: features the parser could see but
 * had nowhere to put.
 *
 * These live here rather than beside `svgFidelity.test.ts` because they need
 * the two capabilities the parser cannot reach on its own — the boolean
 * clipper and the text measurer, both injected from `@core`. Exercising them
 * through the real injections is the point: a fake would prove the wiring and
 * not the geometry.
 */

import { parseSvgToShapes, type ParsedShape } from '../../utils/svgParser';
import { measureSvgText, intersectSvgPaths, insertSvgShapeGroup } from './sceneInsert';
import { seedDefaultScene } from './seedDefaultScene';
import defaultSceneGraph from './DefaultSceneGraph';
import type { SceneNode } from '@core/types';

const parse = (svg: string, unsupportedOut?: Set<string>): ParsedShape[] =>
  parseSvgToShapes(svg, {
    maxDurationSeconds: 10,
    measureText: measureSvgText,
    intersectPaths: intersectSvgPaths,
    ...(unsupportedOut ? { unsupportedOut } : {}),
  });

/** The same file with no injected capabilities — the graceful-degradation path. */
const parseBare = (svg: string): ParsedShape[] => parseSvgToShapes(svg, { maxDurationSeconds: 10 });

const PULSE = '<animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>';

const wrap = (inner: string, w = 100, h = 100): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`;

const only = (shapes: readonly ParsedShape[]): ParsedShape => {
  if (shapes.length !== 1) throw new Error(`expected 1 shape, got ${shapes.length}`);
  return shapes[0]!;
};

beforeAll(() => { seedDefaultScene(); });

describe('clip-path cuts the geometry', () => {
  const HALF = wrap(`
    <defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>
    <rect x="0" y="0" width="100" height="100" fill="#f00" clip-path="url(#c)">${PULSE}</rect>`);

  it('reduces the shape to the clipped region', () => {
    // The clip used to be dropped entirely, so the rect drew at full width —
    // spilling past the boundary the file drew it inside.
    const s = only(parse(HALF));
    expect(s.width).toBeCloseTo(50, 3);
    expect(s.height).toBeCloseTo(100, 3);
    expect(s.centerX).toBeCloseTo(25, 3);
  });

  it('leaves the shape whole when no clipper is injected', () => {
    const s = only(parseBare(HALF));
    expect(s.width).toBeCloseTo(100, 3);
    expect(s.centerX).toBeCloseTo(50, 3);
  });

  it('applies a clip declared on an ancestor group', () => {
    // `clip-path` clips the element AND its subtree, so it has to accumulate
    // down the tree the way a transform does.
    const s = only(parse(wrap(`
      <defs><clipPath id="c"><circle cx="50" cy="50" r="25"/></clipPath></defs>
      <g clip-path="url(#c)">
        <rect x="0" y="0" width="100" height="100" fill="#0f0">${PULSE}</rect>
      </g>`)));
    expect(s.width).toBeCloseTo(50, 0);
    expect(s.height).toBeCloseTo(50, 0);
    expect(s.centerX).toBeCloseTo(50, 0);
  });

  it('compounds nested clips instead of taking only the innermost', () => {
    const s = only(parse(wrap(`
      <defs>
        <clipPath id="left"><rect x="0" y="0" width="50" height="100"/></clipPath>
        <clipPath id="top"><rect x="0" y="0" width="100" height="40"/></clipPath>
      </defs>
      <g clip-path="url(#left)">
        <rect x="0" y="0" width="100" height="100" fill="#00f" clip-path="url(#top)">${PULSE}</rect>
      </g>`)));
    expect(s.width).toBeCloseTo(50, 3);
    expect(s.height).toBeCloseTo(40, 3);
  });

  it('drops a shape whose clip removes it entirely', () => {
    // The file draws nothing here, so neither should the import — an unclipped
    // rect appearing where the design shows empty space is the worst outcome.
    expect(parse(wrap(`
      <defs><clipPath id="c"><rect x="200" y="200" width="10" height="10"/></clipPath></defs>
      <rect x="0" y="0" width="50" height="50" fill="#f00" clip-path="url(#c)">${PULSE}</rect>`)))
      .toHaveLength(0);
  });
});

describe('<image> becomes an image layer', () => {
  const DOC = wrap(`
    <image href="data:image/png;base64,iVBORw0KGgo=" x="10" y="20" width="40" height="30"/>
    <circle cx="80" cy="80" r="10" fill="#fff">${PULSE}</circle>`);

  it('is parsed with its source and its real box', () => {
    // It used to be dropped, so an animated SVG built around a photo imported
    // with a hole where the photo was.
    const shapes = parse(DOC);
    const img = shapes.find((s) => s.imageHref);
    expect(img).toBeDefined();
    expect(img!.imageHref).toMatch(/^data:image\/png/);
    expect([img!.width, img!.height]).toEqual([40, 30]);
    expect([img!.centerX, img!.centerY]).toEqual([30, 35]);
  });

  it('inserts as an image node carrying the src', () => {
    const groupId = insertSvgShapeGroup(DOC, 'photo.svg');
    const parts = (defaultSceneGraph.getNode(groupId!)?.children ?? [])
      .map((id) => defaultSceneGraph.getNode(id))
      .filter((n): n is SceneNode => !!n);
    const imageNode = parts.find((n) => {
      const t = n.components.find((c) => c.type === 'Transform');
      return typeof t?.props.src === 'string';
    });
    expect(imageNode).toBeDefined();
    const t = imageNode!.components.find((c) => c.type === 'Transform')!;
    expect(String(t.props.src)).toMatch(/^data:image\/png/);
  });
});

describe('a <tspan> that restyles part of a label', () => {
  it('splits into one layer per styled run, laid out left to right', () => {
    // `textContent` of the whole element rendered a two-colour label in one
    // colour — the tspan exists precisely to say otherwise.
    const shapes = parse(wrap(
      `<text x="20" y="50" font-size="30" fill="#000000">Hello <tspan fill="#ff8800">World</tspan>${PULSE}</text>`,
      400, 100,
    ));
    expect(shapes).toHaveLength(2);
    expect(shapes.map((s) => s.fill)).toEqual(['#000000', '#ff8800']);
    expect(shapes[0]!.textContent?.trim()).toBe('Hello');
    expect(shapes[1]!.textContent).toBe('World');
    // Contiguous and in order: the second run starts where the first ends.
    expect(shapes[1]!.centerX).toBeGreaterThan(shapes[0]!.centerX);
    const gap = (shapes[1]!.centerX - shapes[1]!.width / 2)
      - (shapes[0]!.centerX + shapes[0]!.width / 2);
    expect(Math.abs(gap)).toBeLessThan(shapes[0]!.width);
  });

  it('stays ONE layer when the tspan changes nothing', () => {
    const shapes = parse(wrap(
      `<text x="20" y="50" font-size="30" fill="#000000">Hello <tspan>World</tspan>${PULSE}</text>`,
      400, 100,
    ));
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.textContent).toBe('Hello World');
  });
});

describe('what still cannot be reproduced is named', () => {
  it('reports textPath rather than letting the curve vanish quietly', () => {
    const unsupported = new Set<string>();
    parse(wrap(`
      <defs><path id="p" d="M10 50 H190"/></defs>
      <text font-size="20" fill="#000"><textPath href="#p">curved</textPath>${PULSE}</text>`, 200, 100),
    unsupported);
    expect([...unsupported].join(' ')).toMatch(/textPath/);
  });

  it('reports a finite animation cut short by the composition', () => {
    const unsupported = new Set<string>();
    parseSvgToShapes(wrap(
      `<rect x="0" y="0" width="10" height="10" fill="#fff">
         <animateTransform attributeName="transform" type="translate" from="0 0" to="50 0" dur="30s" fill="freeze"/>
       </rect>`),
    { maxDurationSeconds: 5, measureText: measureSvgText, unsupportedOut: unsupported });
    expect([...unsupported].join(' ')).toMatch(/longer than the composition/);
  });

  it('says nothing about an endless animation hitting the same ceiling', () => {
    // That one is the loop being BAKED, which is by design — reporting it would
    // train the user to ignore the message that matters.
    const unsupported = new Set<string>();
    parseSvgToShapes(wrap(`<rect x="0" y="0" width="10" height="10" fill="#fff">${PULSE}</rect>`),
      { maxDurationSeconds: 5, measureText: measureSvgText, unsupportedOut: unsupported });
    expect([...unsupported].join(' ')).not.toMatch(/longer than the composition/);
  });
});

describe('relative font sizes resolve against what they inherit', () => {
  it('resolves em against the parent and % against it too', () => {
    const size = (attr: string): number => only(parse(wrap(
      `<g font-size="40"><text x="10" y="50" ${attr} fill="#000">Hi${PULSE}</text></g>`, 200, 100,
    ))).fontSize!;
    expect(size('font-size="1.5em"')).toBeCloseTo(60, 6);
    expect(size('font-size="50%"')).toBeCloseTo(20, 6);
    expect(size('font-size="24"')).toBeCloseTo(24, 6);
    // rem is the ROOT size, not the parent's.
    expect(size('font-size="2rem"')).toBeCloseTo(32, 6);
  });
});
