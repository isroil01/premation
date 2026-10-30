/**
 * Preferences on the dashboard — one page per subject, not one page of tabs.
 *
 * It used to be a tab strip over a single panel, and its Appearance tab held
 * everything that was not a shortcut: theme, docks, scale, double-click,
 * editing, motion recording, export, caches, models, privacy and updates in one
 * scroll. Each subject is now its own page with its own sidebar entry and
 * address (`?tab=customize&section=<page>`), built from the same sections the
 * editor's Customize dialog stacks (layout/Settings/CustomizeDialog).
 */

import { useNavigate } from 'react-router-dom';
import type { IconName } from '@components/Icon';
import { aiEnabled } from '@core/config/edition';
import { t } from '@core/i18n';
import {
  AppSettings, BehaviorSettings, CacheSettings, DockSettings, OpenLayerSettings, ScaleSettings,
  ShortcutsTab, ThemeSettings, ToolModelSettings, VideoEncoderSettings, WorkspacesTab,
} from '@layout/Settings/CustomizeDialog';
import { LanguageSetting } from '@layout/Settings/LanguageSetting';
import { PerformanceSettingsSection } from '@layout/Settings/PerformanceSettingsSection';
import { ExportSettingsSection } from '@layout/Settings/ExportSettingsSection';
import { ModelsSettingsSection } from '@layout/Settings/ModelsSettingsSection';
import { AudioHardwareSection } from '@layout/Settings/AudioHardwareSection';
import { FilesTab } from '@layout/Settings/FilesTab';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import styles from './DashboardCustomizeTab.module.css';

export type PreferencePage =
  | 'general' | 'appearance' | 'workspaces' | 'shortcuts' | 'cache'
  | 'export' | 'recording' | 'audio' | 'files' | 'models' | 'ai';

export interface PreferencePageInfo {
  id: PreferencePage;
  label: string;
  icon: IconName;
  /** One line under the page title. */
  desc: string;
}

/** A function, not a constant: `t()` runs at render time. */
export function preferencePages(): readonly PreferencePageInfo[] {
  return [
    { id: 'general', label: t('dashboard.prefs.general', 'General'), icon: 'settings', desc: t('dashboard.prefs.generalDesc', 'Language, editing behaviour and updates.') },
    { id: 'appearance', label: t('dashboard.prefs.appearance', 'Appearance'), icon: 'palette', desc: t('dashboard.prefs.appearanceDesc', 'Theme, size and where panels sit.') },
    { id: 'workspaces', label: t('dashboard.prefs.workspaces', 'Workspaces'), icon: 'layout', desc: t('dashboard.prefs.workspacesDesc', 'Saved arrangements of the editor’s panels.') },
    { id: 'shortcuts', label: t('dashboard.prefs.shortcuts', 'Shortcuts'), icon: 'zap', desc: t('dashboard.prefs.shortcutsDesc', 'Every command and the keys that run it.') },
    { id: 'cache', label: t('dashboard.prefs.cache', 'Cache'), icon: 'gpu', desc: t('dashboard.prefs.cacheDesc', 'Rendered frames kept for playback.') },
    { id: 'export', label: t('dashboard.prefs.export', 'Export'), icon: 'export', desc: t('dashboard.prefs.exportDesc', 'How videos are rendered and encoded.') },
    { id: 'recording', label: t('dashboard.prefs.recording', 'Recording'), icon: 'hand', desc: t('dashboard.prefs.recordingDesc', 'Motion Sketch and hand tracking.') },
    { id: 'audio', label: t('dashboard.prefs.audio', 'Audio'), icon: 'audio', desc: t('dashboard.prefs.audioDesc', 'Output device and latency.') },
    { id: 'files', label: t('dashboard.prefs.files', 'Files'), icon: 'folder', desc: t('dashboard.prefs.filesDesc', 'Autosave and recovery snapshots.') },
    { id: 'models', label: t('dashboard.prefs.models', 'Models'), icon: 'brain', desc: t('dashboard.prefs.modelsDesc', 'Neural models that run on this computer.') },
    ...(aiEnabled()
      ? [{ id: 'ai' as const, label: t('dashboard.prefs.ai', 'AI engine'), icon: 'ai' as IconName, desc: t('dashboard.prefs.aiDesc', 'Providers and models for the assistant.') }]
      : []),
  ];
}

/**
 * A `?section=` value → a page. Older addresses keep working: `tabs` was the
 * Workspaces tab's id, and the general settings used to live under Appearance.
 */
export function normalizePreferencePage(raw: string | null): PreferencePage {
  const val = (raw ?? '').toLowerCase().trim();
  if (val === 'tabs') return 'workspaces';
  const page = preferencePages().find((p) => p.id === val);
  return page ? page.id : 'general';
}

export function DashboardPreferencePage({ page }: { page: PreferencePage }): JSX.Element {
  const navigate = useNavigate();
  switch (page) {
    case 'shortcuts':
      return <div className={styles.fill}><ShortcutsTab /></div>;
    case 'workspaces':
      return <div className={styles.fill}><WorkspacesTab /></div>;
    case 'appearance':
      return <div className={styles.page}><ThemeSettings /><ScaleSettings /><DockSettings /></div>;
    case 'cache':
      return <div className={styles.page}><CacheSettings /></div>;
    case 'export':
      return <div className={styles.page}><ExportSettingsSection /><VideoEncoderSettings /></div>;
    case 'recording':
      return <div className={styles.page}><PerformanceSettingsSection /></div>;
    case 'audio':
      return <div className={styles.page}><AudioHardwareSection /></div>;
    case 'files':
      return <div className={styles.page}><FilesTab /></div>;
    case 'models':
      return <div className={styles.page}><ModelsSettingsSection /><ToolModelSettings /></div>;
    case 'ai':
      return (
        <div className={styles.page}>
          <AiSettingsSection />
          <div className={styles.aside}>
            <span>{t('dashboard.customize.connectionsNote', 'Claude, Cursor, Antigravity and ChatGPT connect on the Connections page.')}</span>
            <button type="button" className={styles.linkButton} onClick={() => navigate('/dashboard?tab=connections')}>
              {t('dashboard.openConnections', 'Open Connections')}
            </button>
          </div>
        </div>
      );
    case 'general':
    default:
      return <div className={styles.page}><LanguageSetting /><BehaviorSettings /><OpenLayerSettings /><AppSettings /></div>;
  }
}
