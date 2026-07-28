import { Logo } from '@components/Logo';
import styles from './LoadingScreen.module.css';

export interface LoadingScreenProps {
  message?: string;
  fullScreen?: boolean;
}

export function LoadingScreen({ message = 'Loading editor…', fullScreen = false }: LoadingScreenProps): JSX.Element {
  return (
    <div
      className={styles.root}
      style={fullScreen ? { position: 'fixed', zIndex: 9999 } : undefined}
      role="status"
      aria-label={message}
    >
      <div className={styles.ambientGlow} />
      <div className={styles.card}>
        <Logo variant="lockup" size={30} className={styles.brand} />
        <div className={styles.spinnerWrapper}>
          <div className={styles.spinnerTrack} />
          <div className={styles.spinnerHead} />
        </div>
        <span className={styles.label}>{message}</span>
      </div>
    </div>
  );
}

export default LoadingScreen;
