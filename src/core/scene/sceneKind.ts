/** The editor's layer kinds, and where a stored node records its own. */

/** Scene node "kind" — mirrored into the tree for icon selection. */
export type SceneKind = 'group' | 'null' | 'shape' | 'text' | 'image' | 'video' | 'svg' | 'audio' | 'camera' | 'light' | 'adjustment' | 'particle' | 'comp';

/** Stored on each node so the UI can pick an icon without guessing. */
export const SCENE_KIND_PROP = '__kind';
