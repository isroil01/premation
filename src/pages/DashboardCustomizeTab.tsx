/**
 * Dedicated Editor Customization surface on the dashboard.
 *
 * Previously, editor customization could only be reached either from within
 * an active editor session or by clicking "Open Customize…" in the profile
 * Settings card, which popped open a modal dialog.
 *
 * This page gives editor preferences, workspace layout presets, shortcut bindings,
 * appearance and hardware options their own first-class dashboard home with full height,
 * URL deep-linking (?tab=customize&section=...), and accessible tabs.
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { aiEnabled } from '@core/config/edition';
import { ShortcutsTab, WorkspacesTab, AppearanceTab, type Tab as CustomizeTabId } from '@layout/Settings/CustomizeDialog';
import { tabsForEdition } from '@layout/Settings/customizeTabs';
import { AudioHardwareSection } from '@layout/Settings/AudioHardwareSection';
import { FilesTab } from '@layout/Settings/FilesTab';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import styles from './DashboardCustomizeTab.module.css';

/** Map 'workspaces' URL query parameter alias to the internal 'tabs' id */
function normalizeSection(raw: string | null): CustomizeTabId {
  if (!raw) return 'shortcuts';
  const val = raw.toLowerCase().trim();
  if (val === 'workspaces') return 'tabs';
  if (val === 'shortcuts' || val === 'tabs' || val === 'appearance' || val === 'audio' || val === 'files') {
    return val;
  }
  if (val === 'ai' && aiEnabled()) {
    return 'ai';
  }
  return 'shortcuts';
}

export function DashboardCustomizeTab(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get('section');
  const activeSection = normalizeSection(rawSection);

  const tabs = tabsForEdition();

  const handleSelectSection = useCallback(
    (tabId: CustomizeTabId) => {
      const params = new URLSearchParams(searchParams);
      // 'workspaces' is a more human-readable URL param than the internal 'tabs' id
      const urlValue = tabId === 'tabs' ? 'workspaces' : tabId;
      if (tabId === 'shortcuts') {
        params.delete('section');
      } else {
        params.set('section', urlValue);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className={styles.customizeRoot}>
      <div className={styles.viewSwitch}>
        <div className={styles.tabList} role="tablist" aria-label="Editor customization sections">
          {tabs.map((t) => {
            const isSelected = activeSection === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`customize-tab-${t.id}`}
                aria-controls="customize-panel-content"
                aria-selected={isSelected}
                className={cn(styles.tabBtn, isSelected && styles.tabBtnActive)}
                onClick={() => handleSelectSection(t.id)}
              >
                <Icon name={t.icon} size="sm" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={styles.panelHost}
        id="customize-panel-content"
        role="tabpanel"
        aria-labelledby={`customize-tab-${activeSection}`}
      >
        {activeSection === 'shortcuts' ? (
          <ShortcutsTab />
        ) : activeSection === 'tabs' ? (
          <WorkspacesTab />
        ) : activeSection === 'audio' ? (
          <AudioHardwareSection />
        ) : activeSection === 'files' ? (
          <FilesTab />
        ) : activeSection === 'ai' ? (
          <div className={styles.aiContainer}>
            <AiSettingsSection />
          </div>
        ) : (
          <AppearanceTab />
        )}
      </div>
    </div>
  );
}
