import { mediaSourceFrames } from './TimelineController';
import { useAssetStore } from '@stores/assetStore';
import type { SceneNode } from '@core/types';

const node = (kind: string, components: SceneNode['components']): SceneNode =>
  ({
    id: 'n1',
    name: 'N',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: 'n1_t', type: 'Transform', props: { __kind: kind } },
      ...components,
    ],
  }) as unknown as SceneNode;

describe('mediaSourceFrames', () => {
  it('video: reads the asset store metadata duration (seconds → frames)', () => {
    useAssetStore.setState({
      assets: [
        { id: 'a1', name: 'clip.mp4', type: 'video', src: 'blob:x', metadata: { duration: 4.5 } },
      ] as never,
    });
    const n = node('video', []);
    const t = n.components.find((c) => c.type === 'Transform')!;
    (t.props as Record<string, unknown>).assetId = 'a1';
    expect(mediaSourceFrames(n, 30)).toBe(135);
  });

  it('video with unknown asset or missing duration → unbounded (null)', () => {
    useAssetStore.setState({ assets: [] as never });
    const n = node('video', []);
    (n.components[0]!.props as Record<string, unknown>).assetId = 'missing';
    expect(mediaSourceFrames(n, 30)).toBeNull();
  });

  it('audio: reads the Audio component __duration', () => {
    const n = node('audio', [
      { id: 'n1_a', type: 'Audio', props: { __duration: 2 } } as never,
    ]);
    expect(mediaSourceFrames(n, 30)).toBe(60);
  });

  it('generative kinds are unbounded', () => {
    expect(mediaSourceFrames(node('shape', []), 30)).toBeNull();
    expect(mediaSourceFrames(node('text', []), 30)).toBeNull();
    expect(mediaSourceFrames(node('image', []), 30)).toBeNull();
  });
});
