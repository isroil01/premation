/**
 * The preload bridge surface (`window.motionEditor`) — the single, shared
 * contract between the Electron main process and the renderer. Preload,
 * FileManager, and the menu wiring all reference THIS type, so the shape can
 * never drift between the two sides of the IPC boundary.
 *
 * Every member is optional: in a plain browser build `window.motionEditor` is
 * undefined and the app degrades to its web adapters.
 */

export interface MotionEditorFile {
  path: string;
  name: string;
  contents: string;
}

export interface MotionEditorApi {
  readonly platform: string;
  readonly version: string;
  project?: {
    /** Native open dialog → the chosen project file (or null if cancelled). */
    open?(): Promise<MotionEditorFile | null>;
    /** Native save dialog → the chosen path (or null if cancelled). */
    chooseSavePath?(defaultName: string): Promise<string | null>;
  };
  file?: {
    read?(path: string): Promise<string | null>;
    write?(path: string, contents: string): Promise<void>;
  };
  window?: {
    minimize?(): Promise<void>;
    maximize?(): Promise<void>;
    close?(): Promise<void>;
  };
  app?: {
    quit?(): Promise<void>;
    version?(): Promise<string>;
  };
  /** Subscribe to native menu command ids. Returns an unsubscribe fn. */
  onMenuCommand?(handler: (commandId: string) => void): () => void;
  // NOTE: there is deliberately no `ai` surface any more. AI runs through the
  // backend gateway (POST /ai/stream) — keys are stored server-side, so the
  // desktop shell holds no AI privileges at all.
}

declare global {
  interface Window {
    motionEditor?: MotionEditorApi;
    electronAPI?: MotionEditorApi;
  }
}

export {};
