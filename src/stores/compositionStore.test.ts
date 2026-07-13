import { useCompositionStore, DEFAULT_COMPOSITION } from './compositionStore';

const reset = (): void => useCompositionStore.setState({ ...DEFAULT_COMPOSITION });

describe('compositionStore', () => {
  beforeEach(reset);

  test('defaults match the previous hardcoded comp values', () => {
    const s = useCompositionStore.getState();
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(s.background).toBe('#101014');
    expect(s.transparent).toBe(false);
    expect(s.fps).toBe(30);
    expect(s.durationSeconds).toBe(10);
  });

  test('comp() returns just the render-facing slice', () => {
    const comp = useCompositionStore.getState().comp();
    expect(comp).toEqual({
      name: DEFAULT_COMPOSITION.name,
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 10,
      background: '#101014',
      transparent: false,
    });
  });

  test('update() sanitises out-of-range sizes/fps/duration', () => {
    const { update } = useCompositionStore.getState();
    update({ width: 0, height: -5, fps: 9999, durationSeconds: 0 });
    const s = useCompositionStore.getState();
    expect(s.width).toBe(1);
    expect(s.height).toBe(1);
    expect(s.fps).toBe(240);
    expect(s.durationSeconds).toBe(0.1);
  });

  test('update() rounds fractional dimensions', () => {
    useCompositionStore.getState().update({ width: 1280.7 });
    expect(useCompositionStore.getState().width).toBe(1281);
  });

  test('key() changes when a render-affecting field changes', () => {
    const before = useCompositionStore.getState().key();
    useCompositionStore.getState().setBackground('#ffffff');
    const afterBg = useCompositionStore.getState().key();
    expect(afterBg).not.toBe(before);

    useCompositionStore.getState().setTransparent(true);
    expect(useCompositionStore.getState().key()).not.toBe(afterBg);
  });

  test('setBackground / setTransparent update the slice', () => {
    useCompositionStore.getState().setBackground('#123456');
    useCompositionStore.getState().setTransparent(true);
    const comp = useCompositionStore.getState().comp();
    expect(comp.background).toBe('#123456');
    expect(comp.transparent).toBe(true);
  });
});
