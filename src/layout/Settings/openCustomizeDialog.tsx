/**
 * Opens the Customize dialog. Separate from `CustomizeDialog.tsx` on purpose —
 * see the note at the end of that file: a component module with plain
 * function exports is not Fast-Refresh-able, and the invalidation that
 * caused looped the dev server.
 */
import { openModal } from '@stores/modalStore';
import { aiEnabled } from '@core/config/edition';
import { Customize, type Tab } from './CustomizeDialog';

export function openCustomizeDialog(initialTab?: Tab): void {
  openModal({
    id: 'customize',
    title: 'Studio Preferences & Customization',
    size: 'lg',
    render: () => <Customize {...(initialTab ? { initialTab } : {})} />,
  });
}

export function openAiSettings(): void {
  if (!aiEnabled()) return;
  openCustomizeDialog('ai');
}
