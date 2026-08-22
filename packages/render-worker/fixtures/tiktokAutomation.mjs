/**
 * TikTok automation document for render-worker smoke/benchmark scripts.
 * Keep in sync with src/core/automation/tiktokAutomation.fixture.ts
 */

export const TIKTOK_DEFAULT_ASSETS = {
  backgroundVideo: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  character: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
};

/** @param {{ durationSeconds?: number, characterSrc?: string, backgroundSrc?: string }} [options] */
export function buildTikTokDocument(options = {}) {
  const durationSeconds = options.durationSeconds ?? 30;
  const characterSrc = options.characterSrc ?? TIKTOK_DEFAULT_ASSETS.character;
  const backgroundSrc = options.backgroundSrc ?? TIKTOK_DEFAULT_ASSETS.backgroundVideo;

  return {
    version: '1.1.0',
    scene: {
      version: '1.0.0',
      nodes: [
        {
          id: 'comp_root',
          name: 'TikTok Reaction',
          parent: null,
          children: ['backgroundVideo', 'character'],
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          visible: true,
          locked: false,
          components: [{ id: 'comp_root_meta', type: 'group', props: { sceneKind: 'group' } }],
        },
        {
          id: 'backgroundVideo',
          name: 'Background Video',
          parent: 'comp_root',
          children: [],
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          visible: true,
          locked: false,
          components: [
            {
              id: 'bg_t',
              type: 'Transform',
              props: {
                sceneKind: 'video',
                src: backgroundSrc,
                x: 0,
                y: 0,
                width: 1080,
                height: 1920,
              },
            },
          ],
        },
        {
          id: 'character',
          name: 'Character',
          parent: 'comp_root',
          children: [],
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          visible: true,
          locked: false,
          components: [
            {
              id: 'char_t',
              type: 'Transform',
              props: {
                sceneKind: 'image',
                src: characterSrc,
                x: 540,
                y: 1400,
                width: 420,
                height: 420,
                opacity: 1,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
              },
            },
          ],
        },
      ],
    },
    animation: {
      tracks: {
        character: {
          x: {
            nodeId: 'character',
            prop: 'x',
            keyframes: [
              { t: 0, value: 540, easing: 'easeOut', bezier: [0, 0, 2 / 3, 1] },
              { t: 4, value: 200, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
              { t: 8, value: 880, easing: 'easeInOut' },
              { t: 15, value: 540, easing: 'linear' },
              { t: durationSeconds, value: 540, easing: 'linear' },
            ],
          },
          y: {
            nodeId: 'character',
            prop: 'y',
            keyframes: [
              { t: 0, value: 1400, easing: 'easeOut', bezier: [0, 0, 2 / 3, 1] },
              { t: 6, value: 1100, easing: 'bezier', bezier: [0.33, 0, 0.67, 1] },
              { t: 12, value: 1500, easing: 'easeInOut' },
              { t: durationSeconds, value: 1400, easing: 'linear' },
            ],
          },
          rotation: {
            nodeId: 'character',
            prop: 'rotation',
            keyframes: [
              { t: 0, value: -12, easing: 'easeOut' },
              { t: 5, value: 18, easing: 'bezier', bezier: [0.25, 0.1, 0.25, 1] },
              { t: 10, value: -8, easing: 'easeInOut' },
              { t: durationSeconds, value: 0, easing: 'linear' },
            ],
          },
          scaleX: {
            nodeId: 'character',
            prop: 'scaleX',
            keyframes: [
              { t: 0, value: 0.6, easing: 'easeOut' },
              { t: 3, value: 1.15, easing: 'bezier', bezier: [0.34, 1.56, 0.64, 1] },
              { t: 7, value: 0.95, easing: 'easeInOut' },
              { t: durationSeconds, value: 1, easing: 'linear' },
            ],
          },
          scaleY: {
            nodeId: 'character',
            prop: 'scaleY',
            keyframes: [
              { t: 0, value: 0.6, easing: 'easeOut' },
              { t: 3, value: 1.15, easing: 'bezier', bezier: [0.34, 1.56, 0.64, 1] },
              { t: 7, value: 0.95, easing: 'easeInOut' },
              { t: durationSeconds, value: 1, easing: 'linear' },
            ],
          },
          opacity: {
            nodeId: 'character',
            prop: 'opacity',
            keyframes: [
              { t: 0, value: 0, easing: 'easeIn' },
              { t: 0.8, value: 1, easing: 'linear' },
              { t: durationSeconds - 1, value: 1, easing: 'linear' },
              { t: durationSeconds, value: 0.85, easing: 'easeOut' },
            ],
          },
        },
      },
      expressions: {},
    },
    comps: {
      comp_root: {
        id: 'comp_root',
        name: 'TikTok Reaction',
        width: 1080,
        height: 1920,
        fps: 30,
        durationSeconds,
        background: '#000000',
        transparent: false,
        startFrame: 0,
        globalLightAngle: 90,
        globalLightAltitude: 45,
      },
    },
  };
}
