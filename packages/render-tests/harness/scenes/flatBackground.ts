/**
 * Anchor scene: a flat composition background, no geometry at all.
 *
 * Purpose = colour-space / readback proof. With no shape there is no
 * antialiased edge, so every pixel is the same flat colour on BOTH engines.
 * This must match at ~0% divergence from day one — if it fails, the harness
 * itself (premultiply, sRGB, RGBA row order, GL flip) is wrong, not the
 * renderer. It is the suite's one true GPU 'expect-pass' gate at Phase 0.
 */

import { defineScene } from '../sceneKit';

export default defineScene({
  id: 'flat-background',
  description: 'Flat comp background (#2f6fd0), no layers — colour-space/readback anchor.',
  size: { w: 320, h: 200 },
  comp: { width: 320, height: 200, background: '#2f6fd0' },
  fps: 30,
  frames: [0],
  // The comparator ignores the 1px comp-frame border (a sub-pixel boundary
  // artifact — see comparator DEFAULT_IGNORE_BORDER), so the flat interior must
  // now match at the default 0.5% tolerance. Any colour-space/readback
  // regression shifts the whole interior, far past that.
  gpuParity: 'expect-pass',
  build() {
    // Intentionally empty: the composition background is the whole picture.
  },
});
