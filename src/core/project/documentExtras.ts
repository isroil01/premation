/**
 * Document state the engine API defines that no editor store held before B2:
 * the API's project settings (ENGINE_API.md §4.1 `setProjectSettings`) and the
 * render queue as SAVED WITH THE PROJECT (§4.2, After Effects' behaviour — the
 * running render jobs stay in `renderQueueStore`, which is session state).
 *
 * A plain module, not a zustand store: nothing renders from it yet (B4 reads
 * it through the engine mirror), and it is small enough to snapshot whole.
 * Captured and restored by `cloudDocument` like every other authored part;
 * absent from a document when default, so older files read back unchanged.
 */

import type { ProjectSettings, RenderItemInfo } from '@motion/engine-api';

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  bitDepth: 'u8',
  workingSpace: 'srgbLinear',
  linearBlending: false,
  ocioConfig: '',
  timeDisplay: 'timecode',
  expressionEngine: 'premation',
  framesStartAt: 0,
  audioSampleRate: 48000,
};

export interface DocumentExtras {
  projectSettings?: ProjectSettings;
  renderQueue?: RenderItemInfo[];
}

let state: { projectSettings: ProjectSettings; renderQueue: RenderItemInfo[] } = {
  projectSettings: { ...DEFAULT_PROJECT_SETTINGS },
  renderQueue: [],
};

export function getProjectSettings(): ProjectSettings {
  return { ...state.projectSettings };
}

export function setProjectSettingsState(next: ProjectSettings): void {
  state = { ...state, projectSettings: { ...next } };
}

export function getRenderQueue(): RenderItemInfo[] {
  return structuredClone(state.renderQueue);
}

export function setRenderQueueState(items: RenderItemInfo[]): void {
  state = { ...state, renderQueue: structuredClone(items) };
}

/** For `captureDocument`: only what differs from a fresh project. */
export function captureDocumentExtras(): DocumentExtras {
  const out: DocumentExtras = {};
  if (JSON.stringify(state.projectSettings) !== JSON.stringify(DEFAULT_PROJECT_SETTINGS)) {
    out.projectSettings = { ...state.projectSettings };
  }
  if (state.renderQueue.length > 0) out.renderQueue = structuredClone(state.renderQueue);
  return out;
}

/** For `restoreDocument`: a document states its extras whole (absent = default). */
export function restoreDocumentExtras(doc: DocumentExtras): void {
  state = {
    projectSettings: { ...DEFAULT_PROJECT_SETTINGS, ...(doc.projectSettings ?? {}) },
    renderQueue: structuredClone(doc.renderQueue ?? []),
  };
}
