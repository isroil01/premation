/**
 * OnboardingOverlay — the first-run tour.
 * A centered card sequence over a dim scrim; Back / Next / Skip.
 *
 * There is no "Coming from After Effects?" shortcut import, despite what this
 * docstring used to promise — no such control was ever built here. It is also
 * moot: `AE_PRESET` in shortcutOverrides IS the default keymap, so an AE user's
 * muscle memory already works without importing anything.
 */

import { createPortal } from 'react-dom';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import { useOnboardingStore, TOUR_STEPS } from '@stores/onboardingStore';
import styles from './OnboardingOverlay.module.css';

export function OnboardingOverlay({ onDone }: { onDone: () => void }): JSX.Element | null {
  const active = useOnboardingStore((s) => s.active);
  const step = useOnboardingStore((s) => s.step);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const finish = useOnboardingStore((s) => s.finish);

  if (!active) return null;
  const s = TOUR_STEPS[step]!;
  const isFirst = step === 0;
  const isLast = step === TOUR_STEPS.length - 1;

  const close = (): void => { finish(); onDone(); };
  const advance = (): void => { if (isLast) close(); else next(); };

  return createPortal(
    <div className={styles.scrim} role="dialog" aria-label="Welcome tour" aria-modal="true">
      <div className={styles.card}>
        <div className={styles.badge}><Icon name="sparkles" size="md" /></div>
        <h2 className={styles.title}>{s.title}</h2>
        <p className={styles.body}>{s.body}</p>
        <div className={styles.hint}><Icon name="info" size="sm" /> {s.hint}</div>

        <div className={styles.dots}>
          {TOUR_STEPS.map((_, i) => (
            <span key={i} className={cn(styles.dot, i === step && styles.dotOn)} />
          ))}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.skip} onClick={close}>Skip tour</button>
          <div className={styles.nav}>
            {!isFirst ? <Button variant="secondary" size="sm" onClick={back}>Back</Button> : null}
            <Button variant="primary" size="sm" onClick={advance}>
              {isLast ? 'Get started' : isFirst ? 'Take the tour' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default OnboardingOverlay;
