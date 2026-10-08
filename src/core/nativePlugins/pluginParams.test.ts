import {
  withStopAdded,
  fileTypeList,
  fileTypeMatches,
  gradientCss,
  gradientStops,
  gradientValue,
  fileParamImportCommand,
  stopHex,
  withHex,
} from './pluginParams';

describe('plugin SDK 1.1 params, editor side', () => {
  it('reads gradients as the engine does', () => {
    expect(gradientStops('x')).toEqual([
      { position: 0, r: 0, g: 0, b: 0, a: 1 },
      { position: 1, r: 1, g: 1, b: 1, a: 1 },
    ]);
    expect(gradientStops([[1, 1, 0, 0, 1], [0], [0, 0, 0, 1, 1]])).toEqual([
      { position: 0, r: 0, g: 0, b: 1, a: 1 },
      { position: 1, r: 1, g: 0, b: 0, a: 1 },
    ]);
    expect(gradientStops([[2, -1, 0.5, 0, 1]])[0]).toEqual({ position: 1, r: 0, g: 0.5, b: 0, a: 1 });
    expect(gradientValue(gradientStops([[1, 1, 1, 1, 1], [0, 0, 0, 0, 1]]))).toEqual([[0, 0, 0, 0, 1], [1, 1, 1, 1, 1]]);
  });

  it('edits stops', () => {
    const s = gradientStops(undefined);
    expect(stopHex(s[1]!)).toBe('#ffffff');
    expect(withHex(s[0]!, '#ff8000')).toMatchObject({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(withHex(s[0]!, 'red')).toBe(s[0]);
    const three = withStopAdded(s);
    expect(three.map((x) => x.position)).toEqual([0, 0.5, 1]);
    expect(three[1]).toMatchObject({ r: 0.5, g: 0.5, b: 0.5 });
    expect(gradientCss(s)).toBe('linear-gradient(to right, rgba(0, 0, 0, 1) 0%, rgba(255, 255, 255, 1) 100%)');
  });

  it('filters files by the declared types', () => {
    expect(fileTypeList('cube|.3DL| ')).toEqual(['cube', '3dl']);
    expect(fileTypeMatches('warm.CUBE', 'cube|3dl')).toBe(true);
    expect(fileTypeMatches('warm.png', 'cube')).toBe(false);
    expect(fileTypeMatches('anything', '')).toBe(true);
    expect(fileParamImportCommand('/a/b.cube')).toEqual({
      type: 'importFiles',
      files: [{ path: '/a/b.cube', asSequence: false, createComposition: false, asData: true }],
    });
  });
});
