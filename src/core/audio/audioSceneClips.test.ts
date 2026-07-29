/**
 * The timeline clip bar is what decides when audio sounds.
 *
 * Regression guard for the bug where an audio layer ignored its bar entirely:
 * `readAudioVoices` read a private `__start`/`__in`/`__out` set on the Audio
 * component that nothing ever wrote, so dragging, trimming or splitting the bar
 * changed the picture of the timeline and not one sample of the sound.
 */

import type { SceneNode } from '@core/types';

const getLayersForNode = jest.fn();
const fpsForNode = jest.fn(() => 30);

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => ({ getLayersForNode, fpsForNode }),
}));
jest.mock('@stores/assetStore', () => ({
  useAssetStore: { getState: () => ({ assets: [] }) },
}));
jest.mock('@core/api/client', () => ({ assetUrl: (s: string) => s }));

import { readAudioVoices } from './audioScene';

/** An audio node carrying the legacy prop timing (start 0, full length). */
function audioNode(props: Record<string, unknown> = {}): SceneNode {
  return {
    id: 'audio1',
    name: 'Track',
    visible: true,
    components: [
      {
        id: 'audio1_a',
        type: 'Audio',
        props: {
          __kind: 'audio',
          __assetId: 'asset1',
          __src: 'blob:track.mp3',
          __level: 100,
          __start: 0,
          __in: 0,
          __out: 10,
          __duration: 10,
          __muted: false,
          ...props,
        },
      },
    ],
  } as unknown as SceneNode;
}

/** A fake timeline layer: `clip` geometry is in FRAMES. */
function clip(id: string, start: number, duration: number, sourceIn = 0, enabled = true) {
  return { id, enabled, clip: { start, duration, sourceIn } };
}

beforeEach(() => {
  getLayersForNode.mockReset();
  fpsForNode.mockReset().mockReturnValue(30);
});

describe('readAudioVoices — clip bars are the authority', () => {
  it('takes start and trim from the bar, not from the component props', () => {
    // Bar: starts at frame 60 (2s), runs 60 frames (2s), reading from source
    // frame 30 (1s). The props still say "0 → 10s", and must be ignored.
    getLayersForNode.mockReturnValue([clip('c1', 60, 60, 30)]);

    const [v] = readAudioVoices(audioNode());
    expect(v).toMatchObject({ startSec: 2, inSec: 1, outSec: 3 });
  });

  it('a split bar yields one independently-keyed voice per clip', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 30, 0), clip('c2', 150, 30, 30)]);

    const voices = readAudioVoices(audioNode());
    expect(voices).toHaveLength(2);
    expect(voices.map((v) => v.id)).toEqual(['c1', 'c2']);
    expect(voices[0]).toMatchObject({ startSec: 0, inSec: 0, outSec: 1 });
    expect(voices[1]).toMatchObject({ startSec: 5, inSec: 1, outSec: 2 });
  });

  it('converts through the OWNING timeline fps, not a hardcoded 30', () => {
    fpsForNode.mockReturnValue(60);
    getLayersForNode.mockReturnValue([clip('c1', 60, 60, 0)]);

    const [v] = readAudioVoices(audioNode());
    expect(v).toMatchObject({ startSec: 1, outSec: 1 });
  });

  it('a disabled clip is muted (the timeline’s own mute silences the layer)', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 60, 0, false)]);
    expect(readAudioVoices(audioNode())[0]!.muted).toBe(true);
  });

  it('a hidden or muted LAYER stays muted whatever the bar says', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 60, 0, true)]);
    expect(readAudioVoices(audioNode({ __muted: true }))[0]!.muted).toBe(true);
  });

  it('falls back to the component props when the node has no bar', () => {
    // Audio nested in a plain group has no clips of its own — it must still
    // sound, on its prop timing, rather than going silent.
    getLayersForNode.mockReturnValue([]);

    const [v] = readAudioVoices(audioNode({ __start: 4, __in: 1, __out: 6 }));
    expect(v).toMatchObject({ id: 'audio1', startSec: 4, inSec: 1, outSec: 6 });
  });

  it('yields nothing without a usable src', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 60)]);
    expect(readAudioVoices(audioNode({ __assetId: '', __src: '' }))).toEqual([]);
  });
});
