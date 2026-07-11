/**
 * Application-wide event names. Centralized as a const tuple so we get
 * exhaustive type inference from the EventBus.
 *
 * Convention: PascalCase, past-tense verbs (SelectionChanged, PanelOpened).
 */

export const APP_EVENTS = [
  // Lifecycle
  'ApplicationReady',
  'ApplicationShutdown',

  // Workspace
  'WorkspaceChanged',
  'WorkspaceFocused',
  'WorkspaceBlurred',

  // Panels / layout
  'PanelOpened',
  'PanelClosed',
  'PanelFocused',
  'PanelResized',
  'PanelMoved',
  'PanelDocked',
  'PanelUndocked',
  'LayoutChanged',
  'ThemeChanged',

  // Project (future engine integration)
  'ProjectLoaded',
  'ProjectUnloaded',
  'ProjectSaved',
  'ProjectDirtyChanged',

  // Selection (future scene graph integration)
  'SelectionChanged',

  // Scene graph
  'NodeUpdated',

  // Animation
  'AnimationChanged',

  // Timeline (future timeline engine integration)
  'TimelineFocused',
  'TimelineBlurred',
  'TimeChanged',
  'PlayStateChanged',

  // Undo / redo
  'UndoStackChanged',

  // Engine lifecycle (future)
  'EngineReady',
  'EngineError',
] as const;

export type AppEventName = (typeof APP_EVENTS)[number];

/** Payload types per event — engines may extend this union in the future. */
export interface AppEventPayloads {
  ApplicationReady: void;
  ApplicationShutdown: void;

  WorkspaceChanged: { from: string; to: string };
  WorkspaceFocused: { workspaceId: string };
  WorkspaceBlurred: { workspaceId: string };

  PanelOpened:    { panelId: string };
  PanelClosed:    { panelId: string };
  PanelFocused:   { panelId: string };
  PanelResized:   { panelId: string; size: number };
  PanelMoved:     { panelId: string; area: string };
  PanelDocked:    { panelId: string };
  PanelUndocked:  { panelId: string };
  LayoutChanged:  undefined;
  ThemeChanged:   { from: string; to: string };

  ProjectLoaded:   { projectId: string };
  ProjectUnloaded: { projectId: string };
  ProjectSaved:    { projectId: string };
  ProjectDirtyChanged: { dirty: boolean };

  SelectionChanged: { ids: ReadonlyArray<string> };

  NodeUpdated: { nodeId: string; componentId: string; propName: string; value: unknown };

  AnimationChanged: { nodeId: string };

  TimelineFocused: undefined;
  TimelineBlurred: undefined;
  TimeChanged:     { time: number; frame: number };
  PlayStateChanged: { playing: boolean };

  UndoStackChanged: { canUndo: boolean; canRedo: boolean };

  EngineReady: { engine: string };
  EngineError: { engine: string; error: Error };
}
