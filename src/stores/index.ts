export { useUIStore, subscribeUI } from './uiStore';
export type { UIStore, Notification } from './uiStore';
export { useLayoutStore, usePanel } from './layoutStore';
export type { LayoutStore, RegionId, RegionState, PanelRegistration, LayoutMap } from './layoutStore';
export { useSelectionStore } from './selectionStore';
export type { SelectionState } from './selectionStore';
export {
  usePreferenceStore,
  applyPreferencesToDocument,
  setPreferenceBackend,
  localStorageBackend,
  DEFAULT_PREFERENCES,
} from './preferenceStore';
export type { Preferences, PreferenceStore, PreferenceBackend } from './preferenceStore';
export { useProjectStore as useWorkspaceStore, useActiveTab as useActiveWorkspace } from './projectStore';
export type { TabInfo as WorkspaceInfo } from './projectStore';
