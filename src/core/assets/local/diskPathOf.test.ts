import { diskPathOf } from './diskPathOf';

type Bridge = { file?: { pathOf?: (f: File) => string } };
const w = window as unknown as { motionEditor?: Bridge };

describe('diskPathOf', () => {
  const file = new File(['x'], 'clip.mov');
  afterEach(() => {
    delete w.motionEditor;
  });

  it('is undefined in the browser build (no bridge)', () => {
    expect(diskPathOf(file)).toBeUndefined();
  });

  it('ignores the removed File.path even when a runtime still sets it', () => {
    Object.defineProperty(file, 'path', { value: '/stale/clip.mov', configurable: true });
    expect(diskPathOf(file)).toBeUndefined();
  });

  it('returns the path webUtils.getPathForFile gives through the preload', () => {
    const pathOf = jest.fn(() => '/Users/me/clip.mov');
    w.motionEditor = { file: { pathOf } };
    expect(diskPathOf(file)).toBe('/Users/me/clip.mov');
    expect(pathOf).toHaveBeenCalledWith(file);
  });

  it("treats '' (a File with no disk backing) and a throwing bridge as no path", () => {
    w.motionEditor = { file: { pathOf: () => '' } };
    expect(diskPathOf(file)).toBeUndefined();
    w.motionEditor = { file: { pathOf: () => { throw new TypeError('not a File'); } } };
    expect(diskPathOf(file)).toBeUndefined();
  });
});
