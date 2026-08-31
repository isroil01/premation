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
  'SceneGraphChanged',
  'NodeUpdated',
  'LayerReparented',

  // Animation
  'AnimationChanged',

  // Any authored state changed (drives autosave / dirty)
  'DocumentChanged',

  // Timeline (future timeline engine integration)
  'TimelineFocused',
  'TimelineBlurred',
  'TimeChanged',
  'PlayStateChanged',

  // Undo / redo
  'UndoStackChanged',

  // Timeline reveal (AE U / UU shortcuts)
  'RevealAnimatedProps',

  // Engine lifecycle (future)
  'EngineReady',
  'EngineError',

  // Monitor detection
  'MonitorDetected',
  'MonitorRemoved',
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

  SelectionChanged: { ids: string[] };
  SceneGraphChanged: undefined;
  NodeUpdated: { nodeId: string; componentId: string; propName: string; value: unknown };

  /**
   * A layer changed parent. `parentId` is the node it now hangs under (a
   * composition root when it was un-parented).
   *
   * `parent` IS the tree in this graph, so a reparent MOVES the layer into
   * another branch — and a branch that renders collapsed hides it completely.
   * Parenting to a Null, which has no children until that moment and so is
   * never in the panel's expanded set, made the layer disappear from the Scene
   * panel while it was still on canvas. Panels listen so they can open the
   * destination and keep the layer in sight.
   */
  LayerReparented: { nodeId: string; parentId: string };

  /**
   * The animation/render surface changed.
   *
   * `media: true` marks a DECODE/UPLOAD repaint — a video frame landing, a
   * texture finishing — as opposed to a document edit. The distinction matters
   * to almost every listener (see `@core/rendering/mediaRepaint`), and it is
   * set by the emitter rather than inferred from `nodeId`, because the id of a
   * media repaint is a source URL whose shape depends on the edition.
   */
  AnimationChanged: { nodeId?: string; media?: boolean };

  /**
   * Authored state that is NOT covered by SceneGraphChanged/AnimationChanged
   * changed — comp settings, timeline clips/markers/work area, motion blur.
   * Autosave listens to this; anything persisted in the project file that can
   * change without touching the scene graph must emit it, or the edit is lost.
   */
  DocumentChanged: { source: 'composition' | 'timeline' | 'render' };

  TimelineFocused: undefined;
  TimelineBlurred: undefined;
  TimeChanged:     { time: number; frame: number };
  PlayStateChanged: { playing: boolean };

  UndoStackChanged: { canUndo: boolean; canRedo: boolean };

  /**
   * Emitted by the U / UU shortcut; Timeline subscribes to expand/filter tracks.
   *
   * `force` reveals without toggling, and reads the engine rather than the
   * timeline model — for a generator that has just written keyframes and needs
   * them SEEN. U toggles because the user pressed it twice on purpose; an
   * assistant re-emitting it would collapse the very rows it just filled.
   */
  RevealAnimatedProps: { nodeIds: string[]; mode: 'animated' | 'modified'; force?: boolean };

  EngineReady: { engine: string; role?: 'viewport' | 'auxiliary' };
  EngineError: { engine: string; error: Error; role?: 'viewport' | 'auxiliary' };

  MonitorDetected: { count: number; displays: unknown[] };
  MonitorRemoved: { count: number; displays: unknown[] };
}
