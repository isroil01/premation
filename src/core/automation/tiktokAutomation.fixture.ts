/**
 * TikTok-style automation fixture — 1080×1920 vertical comp with an MP4
 * background, transparent PNG character, and keyframed position / scale /
 * rotation / opacity (multiple keyframes + easing).
 *
 * Used by integration tests and documented as the canonical automation scenario.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { TemplateField } from '@core/template/templateTypes';
import type { CompositionSettings } from '@stores/projectStore';

/** Public sample assets (HTTP(S), server-fetchable). Override in tests if needed. */
export const TIKTOK_DEFAULT_ASSETS = {
  backgroundVideo: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  character: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
} as const;

export const TIKTOK_COMP: CompositionSettings = {
  id: 'comp_root',
  name: 'TikTok Reaction',
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 30,
  background: '#000000',
  transparent: false,
  startFrame: 0,
  globalLightAngle: 90,
  globalLightAltitude: 45,
};

export const TIKTOK_FIELDS: TemplateField[] = [
  {
    id: 'character',
    label: 'Character',
    kind: 'media',
    group: 'Media',
    default: TIKTOK_DEFAULT_ASSETS.character,
    target: { nodeId: 'character', componentType: 'Transform', prop: 'src' },
  },
  {
    id: 'backgroundVideo',
    label: 'Background Video',
    kind: 'media',
    group: 'Media',
    default: TIKTOK_DEFAULT_ASSETS.backgroundVideo,
    target: { nodeId: 'backgroundVideo', componentType: 'Transform', prop: 'src' },
  },
];

export interface TikTokDocumentOptions {
  durationSeconds?: number;
  characterSrc?: string;
  backgroundSrc?: string;
  /** When true, embed `__templateFields` on the comp root (publish snapshot shape). */
  withFieldManifest?: boolean;
}

/** Full EditorDocument for the TikTok automation scenario. */
export function buildTikTokAutomationDocument(options: TikTokDocumentOptions = {}): EditorDocument {
  const durationSeconds = options.durationSeconds ?? TIKTOK_COMP.durationSeconds;
  const characterSrc = options.characterSrc ?? TIKTOK_DEFAULT_ASSETS.character;
  const backgroundSrc = options.backgroundSrc ?? TIKTOK_DEFAULT_ASSETS.backgroundVideo;
  const comp = { ...TIKTOK_COMP, durationSeconds };

  const rootMetaProps: Record<string, unknown> = { sceneKind: 'group' };
  if (options.withFieldManifest !== false) {
    rootMetaProps.__templateFields = TIKTOK_FIELDS;
  }

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
          components: [{ id: 'comp_root_meta', type: 'group', props: rootMetaProps }],
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
    comps: { comp_root: comp },
  };
}
