/**
 * Keyframe Velocity (AE's Ctrl+Shift+K dialog), for the timeline's keyframe
 * diamonds.
 *
 * The maths already existed — `speedGraph.ts` solves speed and influence
 * against a segment's bezier, and the Graph panel drags it — but it was
 * reachable only by dragging a handle in the speed graph. Typing "leaves at
 * 240 px/s with 33% influence" is the reason AE ships a dialog: a drag cannot
 * express an exact number, and matching two keyframes' velocities by eye is
 * not a thing anyone can do.
 *
 * This file is the form. Which keyframe owns which half of the answer — the
 * part worth getting right and worth testing — lives in `keyframeVelocity.ts`.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import {
  applyKeyframeVelocity,
  readKeyframeVelocity,
  type VelocityReading,
} from './keyframeVelocity';
import styles from './KeyframeVelocityDialog.module.css';

interface VelocityBodyProps {
  nodeId: string;
  prop: string;
  t: number;
  reading: VelocityReading;
  close: () => void;
}

function VelocityBody({ nodeId, prop, t, reading, close }: VelocityBodyProps): JSX.Element {
  const { hasIncoming, hasOutgoing, props } = reading;
  const [inSpeed, setInSpeed] = useState(reading.velocity.inSpeed);
  const [outSpeed, setOutSpeed] = useState(reading.velocity.outSpeed);
  // Influence is a fraction in the model and a percentage on screen — AE shows
  // "33.33%", and a 0..1 field would be the only such control in the app.
  const [inInfluence, setInInfluence] = useState(reading.velocity.inInfluence * 100);
  const [outInfluence, setOutInfluence] = useState(reading.velocity.outInfluence * 100);

  const apply = (): void => {
    applyKeyframeVelocity(nodeId, prop, t, {
      inSpeed,
      outSpeed,
      inInfluence: inInfluence / 100,
      outInfluence: outInfluence / 100,
    });
    close();
  };

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        Speed is in the property’s units per second; influence is how far the handle reaches into
        the segment. They are independent — changing one holds the other.
      </p>

      <fieldset className={styles.group} disabled={!hasIncoming}>
        <legend className={styles.legend}>Incoming</legend>
        <div className={styles.row}>
          <span className={styles.label}>Speed</span>
          <ValueField
            value={inSpeed}
            onChange={setInSpeed}
            min={0}
            step={1}
            precision={2}
            unit="/s"
            aria-label="Incoming speed"
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Influence</span>
          <ValueField
            value={inInfluence}
            onChange={setInInfluence}
            min={0.1}
            max={99.9}
            step={1}
            precision={1}
            unit="%"
            aria-label="Incoming influence"
          />
        </div>
        {hasIncoming ? null : <p className={styles.note}>First keyframe — nothing arrives here.</p>}
      </fieldset>

      <fieldset className={styles.group} disabled={!hasOutgoing}>
        <legend className={styles.legend}>Outgoing</legend>
        <div className={styles.row}>
          <span className={styles.label}>Speed</span>
          <ValueField
            value={outSpeed}
            onChange={setOutSpeed}
            min={0}
            step={1}
            precision={2}
            unit="/s"
            aria-label="Outgoing speed"
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Influence</span>
          <ValueField
            value={outInfluence}
            onChange={setOutInfluence}
            min={0.1}
            max={99.9}
            step={1}
            precision={1}
            unit="%"
            aria-label="Outgoing influence"
          />
        </div>
        {hasOutgoing ? null : <p className={styles.note}>Last keyframe — nothing leaves here.</p>}
      </fieldset>

      <p className={styles.note}>
        {props.length === 1
          ? `Applies to ${props[0]}.`
          : `Applies to ${props.join(', ')} — each solves its own curve for these numbers.`}
      </p>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  );
}

/**
 * Open Keyframe Velocity for the keyframe at `t` on `prop` of `nodeId`.
 * Returns false — opening nothing — when that keyframe has no segment on
 * either side, because there would be nothing to shape.
 */
export function openKeyframeVelocityDialog(nodeId: string, prop: string, t: number): boolean {
  const reading = readKeyframeVelocity(nodeId, prop, t);
  if (!reading) return false;
  openModal({
    title: 'Keyframe Velocity',
    size: 'sm',
    render: (close) => (
      <VelocityBody nodeId={nodeId} prop={prop} t={t} reading={reading} close={close} />
    ),
  });
  return true;
}
