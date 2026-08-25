/**
 * Adaptive Resolution — the viewport degrades during a drag that is measured
 * slow, and not otherwise. A drag on a comp that renders inside budget keeps
 * full quality; that is the whole point of the `slowInteract` gate.
 */

import { useRenderQualityStore, effectiveResolutionOf, bindAdaptiveResolution } from './renderQualityStore';

beforeEach(() => {
  useRenderQualityStore.setState({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false, slowInteract: false, draft: false });
});

describe('effectiveResolutionOf', () => {
  it('is the chosen resolution while idle', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false })).toBe(1);
  });
  it('a drag alone does NOT degrade — the comp renders fast enough', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: true })).toBe(1);
  });
  it('drops to the floor while interacting AND measured slow', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: true, slowInteract: true })).toBe(2);
  });
  it('slowInteract without a live drag does not degrade', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: true, adaptiveFloor: 2, interacting: false, slowInteract: true })).toBe(1);
  });
  it('never gives MORE than the user chose', () => {
    // Quarter chosen, Half floor, dragging slow → stays Quarter.
    expect(effectiveResolutionOf({ resolution: 4, adaptive: true, adaptiveFloor: 2, interacting: true, slowInteract: true })).toBe(4);
  });
  it('does nothing when adaptive is off', () => {
    expect(effectiveResolutionOf({ resolution: 1, adaptive: false, adaptiveFloor: 4, interacting: true, slowInteract: true })).toBe(1);
  });
});

describe('interact auto-quality', () => {
  it('degrades after two over-budget drag frames, not after one hitch', () => {
    const s = useRenderQualityStore.getState();
    s.setInteracting(true);
    s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
    s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
  });

  it('a fast frame in between resets the count', () => {
    const s = useRenderQualityStore.getState();
    s.reportInteractFrame(50, 30); s.reportInteractFrame(5, 30); s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
  });

  it('stays sticky across drags and restores after a long cheap run', () => {
    const s = useRenderQualityStore.getState();
    s.reportInteractFrame(50, 30); s.reportInteractFrame(50, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    // Drag ends and a new one begins — still degraded, no re-measure jank.
    s.setInteracting(false);
    s.setInteracting(true);
    expect(useRenderQualityStore.getState().slowInteract).toBe(true);
    for (let i = 0; i < 30; i++) s.reportInteractFrame(5, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
  });

  it('does nothing when adaptive is off', () => {
    useRenderQualityStore.getState().setAdaptive(false);
    for (let i = 0; i < 5; i++) useRenderQualityStore.getState().reportInteractFrame(100, 30);
    expect(useRenderQualityStore.getState().slowInteract).toBe(false);
    useRenderQualityStore.getState().setAdaptive(true);
  });
});

describe('bindAdaptiveResolution', () => {
  beforeEach(() => useRenderQualityStore.setState({ slowInteract: true }));

  it('degrades on drag start (comp known slow) and releases a frame after drag end', () => {
    jest.useFakeTimers();
    let emit: (d: boolean) => void = () => {};
    const unbind = bindAdaptiveResolution((cb) => { emit = cb; return () => {}; });
    emit(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
    emit(false);
    // Still degraded inside the debounce window…
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
    jest.advanceTimersByTime(40);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(1);
    unbind();
    jest.useRealTimers();
  });

  it('a quick re-grab inside the window never renders full-res in between', () => {
    jest.useFakeTimers();
    let emit: (d: boolean) => void = () => {};
    const seen: number[] = [];
    const unsub = useRenderQualityStore.subscribe((s) => seen.push(s.effectiveResolution()));
    const unbind = bindAdaptiveResolution((cb) => { emit = cb; return () => {}; });
    emit(true); emit(false); jest.advanceTimersByTime(10); emit(true);
    jest.advanceTimersByTime(100);
    expect(seen).not.toContain(1);
    unbind(); unsub();
    jest.useRealTimers();
  });

  it('the render key changes with the effective resolution', () => {
    const idle = useRenderQualityStore.getState().key();
    useRenderQualityStore.getState().setInteracting(true);
    expect(useRenderQualityStore.getState().key()).not.toBe(idle);
  });
});

describe('playback auto-quality', () => {
  beforeEach(() => useRenderQualityStore.getState().setSlowPlayback(false));

  it('degrades after three over-budget frames, not after one hitch', () => {
    const s = useRenderQualityStore.getState();
    s.reportPlaybackFrame(50, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(false);
    s.reportPlaybackFrame(50, 33); s.reportPlaybackFrame(50, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(true);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(2);
  });

  it('a fast frame in between resets the count', () => {
    const s = useRenderQualityStore.getState();
    s.reportPlaybackFrame(50, 33); s.reportPlaybackFrame(50, 33); s.reportPlaybackFrame(5, 33); s.reportPlaybackFrame(50, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(false);
  });

  it('restores only after a long run of cheap frames, and stopping clears it', () => {
    const s = useRenderQualityStore.getState();
    for (let i = 0; i < 3; i++) s.reportPlaybackFrame(50, 33);
    for (let i = 0; i < 44; i++) s.reportPlaybackFrame(5, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(true);
    s.reportPlaybackFrame(5, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(false);
    for (let i = 0; i < 3; i++) s.reportPlaybackFrame(50, 33);
    useRenderQualityStore.getState().setSlowPlayback(false);
    expect(useRenderQualityStore.getState().effectiveResolution()).toBe(1);
  });

  it('does nothing when adaptive is off', () => {
    useRenderQualityStore.getState().setAdaptive(false);
    for (let i = 0; i < 5; i++) useRenderQualityStore.getState().reportPlaybackFrame(100, 33);
    expect(useRenderQualityStore.getState().slowPlayback).toBe(false);
    useRenderQualityStore.getState().setAdaptive(true);
  });
});
