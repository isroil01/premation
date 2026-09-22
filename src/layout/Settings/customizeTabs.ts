/**
 * The Customize dialog's tab list — a plain function kept OUT of the
 * component module so that module stays Fast-Refresh-able (see the note at
 * the end of CustomizeDialog.tsx).
 */
import type { IconName } from '@components/Icon';
import { aiEnabled } from '@core/config/edition';

export type Tab = 'shortcuts' | 'tabs' | 'appearance' | 'audio' | 'files' | 'ai';

export function tabsForEdition(): ReadonlyArray<{ id: Tab; label: string; icon: IconName }> {
  return [
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' as IconName },
    { id: 'tabs', label: 'Workspaces', icon: 'layout' as IconName },
    { id: 'appearance', label: 'Appearance', icon: 'palette' as IconName },
    // AE's Preferences ▸ Audio Hardware. Its own pane rather than a section of
    // Appearance: nothing in it is about how the app looks, and a monitoring
    // device buried under "Appearance" is a device nobody finds.
    { id: 'audio', label: 'Audio', icon: 'audio' as IconName },
    { id: 'files', label: 'Files', icon: 'folder' as IconName },
    ...(aiEnabled() ? [{ id: 'ai' as const, label: 'AI Engine', icon: 'ai' as IconName }] : []),
  ];
}
