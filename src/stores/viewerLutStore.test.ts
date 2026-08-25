/**
 * Viewer LUT is session-only and never reaches auxiliary (export) frames.
 */
import { useViewerLutStore } from '@stores/viewerLutStore';
import {
  setActiveViewerLut,
  getActiveViewerLut,
} from '@motion/renderer';

const IDENTITY_2 = `
TITLE "identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('viewerLutStore', () => {
  beforeEach(() => {
    useViewerLutStore.getState().clear();
    setActiveViewerLut(null);
  });

  it('loads a valid .cube and exposes name + signature', () => {
    const ok = useViewerLutStore.getState().loadFromText(IDENTITY_2, '/looks/Film.cube');
    expect(ok).toBe(true);
    const s = useViewerLutStore.getState();
    expect(s.name).toBe('Film.cube');
    expect(s.lut?.size).toBe(2);
    expect(s.signature).toContain('Film.cube');
  });

  it('rejects malformed .cube text', () => {
    expect(useViewerLutStore.getState().loadFromText('not a lut', 'bad.cube')).toBe(false);
    expect(useViewerLutStore.getState().lut).toBeNull();
  });

  it('clear drops the session LUT', () => {
    useViewerLutStore.getState().loadFromText(IDENTITY_2, 'x.cube');
    useViewerLutStore.getState().clear();
    expect(useViewerLutStore.getState().lut).toBeNull();
    expect(useViewerLutStore.getState().name).toBeNull();
  });
});

describe('setActiveViewerLut (export isolation)', () => {
  afterEach(() => setActiveViewerLut(null));

  it('holds meta for the viewport blit path', () => {
    setActiveViewerLut({
      size: 2, is1d: false, intensity: 1, domainMin: 0, domainMax: 1,
    });
    expect(getActiveViewerLut()?.size).toBe(2);
  });

  it('null meta means scene-blit skips the LUT material', () => {
    setActiveViewerLut({
      size: 2, is1d: false, intensity: 1, domainMin: 0, domainMax: 1,
    });
    setActiveViewerLut(null);
    expect(getActiveViewerLut()).toBeNull();
  });
});
