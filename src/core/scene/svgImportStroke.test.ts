/**
 * SVG stroke geometry reaches the created stroke.
 *
 * The parser read `stroke`, `stroke-width` and `stroke-opacity` and nothing
 * else, and the insert path hard-coded butt caps, miter joins and no dashes —
 * so a rounded outline icon imported with square ends and every dashed line
 * imported solid.
 */



import { parseSvgToShapes } from '@utils/svgParser';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

beforeAll(() => {
});

describe('SVG stroke attributes → created stroke', () => {

  it('parser: none, percentages and pathLength do not produce a dash', () => {
    const shapes = parseSvgToShapes(wrap(`
      <path d="M0 10 L90 10" stroke="#000" stroke-dasharray="none"/>
      <path d="M0 20 L90 20" stroke="#000" stroke-dasharray="10%"/>
      <path d="M0 30 L90 30" stroke="#000" stroke-dasharray="1" pathLength="1"/>
      <path d="M0 40 L90 40" stroke="#000" stroke-dasharray="4,2" stroke-linejoin="miter-clip"/>`));
    expect(shapes.map((s) => s.strokeDash)).toEqual([undefined, undefined, undefined, [4, 2]]);
    expect(shapes[3]!.strokeJoin).toBeUndefined(); // miter-clip → miter, the default
  });
});
