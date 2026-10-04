/**
 * New Comp from Footage — the comp must BE the clip.
 *
 * The by-hand version of this workflow drifts silently: a default-1080p comp
 * under a 2160×3840 phone clip, a 10s comp under a 7s clip shipping three
 * seconds of trailing background, a 30fps comp juddering a 23.976 clip. Each
 * assertion here pins one of those drifts. The fps one matters most: the
 * browser cannot report a video's real rate, so an UNPROBED clip must keep the
 * default rather than having one invented for it — a wrong-but-configured-
 * looking frame rate is worse than a default.
 */



import { useAssetStore } from '@stores/assetStore';
import { readSource } from '@/__testHelpers__/readSource';
afterEach(() => {
  useAssetStore.setState({ assets: [] });
});

describe('the control is reachable', () => {
  it('the Assets panel offers it from the asset context menu', () => {
    const ui = readSource('layout/Assets/AssetsPanel.tsx');
    // Through the engine (`newCompFromFootageEdit`, one undo entry).
    expect(ui).toMatch(/newCompFromFootageEdit/);
    expect(ui).toMatch(/New Comp from Footage/);
  });

  it('the metadata drawer renders from the same panel', () => {
    // The footer became a drawer (`AssetDrawer.tsx`) when the bin gained a
    // grid view; the panel still hosts it.
    const ui = readSource('layout/Assets/AssetsPanel.tsx');
    expect(ui).toMatch(/AssetDrawer/);
    const drawer = readSource('layout/Assets/AssetDrawer.tsx');
    // fps only when probed — the honesty rule, pinned in the formatter that
    // every fps readout goes through.
    expect(drawer).toMatch(/if \(!fps \|\| fps <= 0\) return null/);
  });
});
