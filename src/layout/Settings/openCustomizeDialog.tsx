/**
 * Opens the Customize dialog. Separate from `CustomizeDialog.tsx` on purpose —
 * see the note at the end of that file: a component module with plain
 * function exports is not Fast-Refresh-able, and the invalidation that
 * caused looped the dev server.
 */
import { openModal } from '@stores/modalStore';
import { aiEnabled } from '@core/config/edition';
import { t } from '@core/i18n';
import { useLocale } from '@hooks/useLocale';
import { Customize, type Tab } from './CustomizeDialog';

/** A component, not a string: the language can change while this dialog is open. */
function CustomizeTitle(): JSX.Element {
  useLocale();
  return <>{t('settings.customize.title', 'Studio Preferences & Customization')}</>;
}

export function openCustomizeDialog(initialTab?: Tab): void {
  openModal({
    id: 'customize',
    title: <CustomizeTitle />,
    size: 'lg',
    render: () => <Customize {...(initialTab ? { initialTab } : {})} />,
  });
}

export function openAiSettings(): void {
  if (!aiEnabled()) return;
  openCustomizeDialog('ai');
}
