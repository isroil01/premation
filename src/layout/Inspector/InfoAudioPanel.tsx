import { InfoReadout } from './InfoReadout';
import styles from './InfoAudioPanel.module.css';

/**
 * Info — After Effects' Info panel (the `info` dock panel): R G B A and X Y
 * under the pointer, then the selected layer's name, In, Out and Duration.
 *
 * No meter (2026-10): the Audio panel right under it carries the master
 * meter, beside the faders that answer it — two meters for one mix was one
 * too many. Rows, not cards: a readout is a list of labelled values, and a
 * rule between its two groups is all the structure it needs.
 */
export function InfoAudioPanel(): JSX.Element {
  return (
    <div className={styles.root}>
      <InfoReadout />
    </div>
  );
}

export default InfoAudioPanel;
