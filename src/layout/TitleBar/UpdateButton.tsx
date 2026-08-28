/**
 * "Restart to update" — the standing, unmissable form of a pending update.
 *
 * ## Why a button in the title bar and not a toast
 *
 * The toast this replaced sat in a corner, competed with every other notice,
 * auto-stacked, and could be dismissed — after which an update was waiting on
 * disk with nothing on screen saying so. Users reported simply not seeing it.
 *
 * A pending update is a standing fact, so it gets a standing control: filled in
 * the product's primary colour, in the top bar on every route, present for
 * exactly as long as the fact is true. The only thing that clears it is acting
 * on it.
 *
 * ## Why it is distinguishable from Export, which is also primary-filled
 *
 * Two identical primary pills side by side would be a coin-flip for the user.
 * This one carries a download glyph and a soft attention ring, and it sits at
 * the FAR LEFT of the right-hand cluster rather than next to Export — so the
 * two never read as a pair of equivalent actions.
 *
 * Renders nothing when no update is pending, which is almost always.
 */

import { Icon } from '@components/Icon';
import { useUpdateStore } from '@core/update/updateStore';
import styles from './TitleBar.module.css';

export function UpdateButton(): JSX.Element | null {
  const version = useUpdateStore((s) => s.readyVersion);
  const restarting = useUpdateStore((s) => s.restarting);
  if (!version) return null;

  const onClick = (): void => {
    const bridge = window.motionEditor?.updates;
    if (!bridge) return;
    // Latch immediately. `restartAndInstall` tears the window down, but not
    // instantly — without this the button stays live and invites a second click
    // during the teardown.
    useUpdateStore.getState().setRestarting(true);
    void bridge.restartAndInstall();
  };

  return (
    <button
      type="button"
      className={styles.updateBtn}
      onClick={onClick}
      disabled={restarting}
      // The version belongs in the tooltip, not the label: the label has to stay
      // the same width whatever the version number is, or the whole title bar
      // reflows when an update lands.
      title={`Premation ${version} is ready to install`}
      aria-label={`Restart to update to Premation ${version}`}
    >
      <Icon name="download" size="sm" aria-hidden />
      <span>{restarting ? 'Restarting…' : 'Restart to update'}</span>
    </button>
  );
}

export default UpdateButton;
