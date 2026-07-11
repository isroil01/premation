/**
 * Common types used across the application.
 * Engine-agnostic — these describe the UI/architecture surface, not rendering.
 */

/** Branded id helper to make ids nominally typed. */
export type Branded<T, B extends string> = T & { readonly __brand: B };

export type PanelId   = Branded<string, 'PanelId'>;
export type CommandId = Branded<string, 'CommandId'>;
export type NodeId    = Branded<string, 'NodeId'>;     // future scene-graph
export type TrackId   = Branded<string, 'TrackId'>;    // future timeline
export type KeyId     = Branded<string, 'KeyId'>;      // future keyframe
export type ThemeId   = Branded<string, 'ThemeId'>;

export const asPanelId   = (s: string) => s as PanelId;
export const asCommandId = (s: string) => s as CommandId;
export const asNodeId    = (s: string) => s as NodeId;
export const asTrackId   = (s: string) => s as TrackId;
export const asKeyId     = (s: string) => s as KeyId;
export const asThemeId   = (s: string) => s as ThemeId;

/** Size variants used across components. */
export type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Visual intent / severity. */
export type Variant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'tertiary'
  | 'danger'
  | 'success'
  | 'warning';

/** Keyboard chord: a combination of modifiers + a main key. */
export interface KeyChord {
  readonly key: string;                       // 's', 'Enter', 'ArrowDown', 'Space', ...
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/** Anything that can be unsubscribed. */
export type Disposable = { dispose(): void };

/** Generic listener shape used by EventBus. */
export type Listener<T> = (payload: T) => void;
