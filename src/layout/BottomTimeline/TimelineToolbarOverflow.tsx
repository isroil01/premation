/**
 * The timeline toolbar's narrow form — View ▾'s rows behind one `⋯` when the
 * track-header column is dragged too narrow for the View trigger. Nothing is
 * merely hidden: every row reaches the same store or command as in View ▾.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import styles from './BottomTimeline.module.css';

export interface TimelineToolbarOverflowProps {
  /** The View menu's rows, built by the panel (they read a dozen stores). */
  viewItems: ReadonlyArray<DropdownItem>;
}

export function TimelineToolbarOverflow({ viewItems }: TimelineToolbarOverflowProps): JSX.Element {
  return (
    <Dropdown
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className={styles.toggleIcon}
          aria-label="More timeline tools"
          title="View — timeline tool, playhead follow, shy layers, columns, row height, preview cache. Widen the track header column to bring the View button back."
        >
          <Icon name="more-horizontal" size="sm" />
        </button>
      }
      items={[...viewItems]}
    />
  );
}
