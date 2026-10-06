/**
 * "Registry plugins aren't supported in 0.9 yet" — once, on the dashboard.
 *
 * Premation 0.9 removed the JavaScript plugin system and its registry; native
 * SDK plugins still run. Someone who used registry plugins deserves to be told
 * where they went and what still works, and then to be able to close it for
 * good: the × is remembered per user (core/nativePlugins, localStorage) and
 * never touches a project.
 *
 * `onLearnMore` is a prop because the Plugins page is the owning page's to
 * route to; the notice does not reach into the dashboard's tab state.
 */

import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { dismissRegistryNotice } from '@core/nativePlugins/nativePlugins';
import { useRegistryNoticeDismissed } from '@hooks/useNativePlugins';
import styles from './NativePlugins.module.css';

export const REGISTRY_NOTICE_TEXT =
  "Plugins from the plugin registry aren't supported in Premation 0.9 yet. Native plugins still work — install them by copying them into your plugins folder.";

export function RegistryPluginsNotice({ onLearnMore }: { onLearnMore?: () => void }): JSX.Element | null {
  const dismissed = useRegistryNoticeDismissed();
  if (dismissed) return null;
  return (
    <div className={styles.notice} role="status">
      <Icon name="plugin" size="sm" className={styles.noticeIcon} />
      <div className={styles.noticeBody}>
        <span>{REGISTRY_NOTICE_TEXT}</span>
        {onLearnMore ? (
          <button type="button" className={styles.noticeLink} onClick={onLearnMore}>
            Learn more
          </button>
        ) : null}
      </div>
      {/* Button, not IconButton: it needs no TooltipProvider, so the notice renders anywhere. */}
      <Button variant="ghost" size="sm" iconOnly icon={<Icon name="close" size="sm" />} onClick={dismissRegistryNotice}>
        Dismiss plugins notice
      </Button>
    </div>
  );
}
