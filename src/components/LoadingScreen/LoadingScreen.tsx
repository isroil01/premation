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
      <div className={styles.wrapper}>
        <div className={styles.inner}>
          <Logo variant="lockup" size={48} className={styles.logo} />
        </div>
      </div>
      {message && <div className={styles.message}>{message}</div>}
    </div>
  );
}

export default LoadingScreen;
