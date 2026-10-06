/**
 * The frame every signed-out screen sits in: sign in, create account, the
 * password reset pair, the email code gate, the welcome question and a failed
 * provider sign-in.
 *
 * One frame, so the flow reads as one sequence — the artwork stays put while
 * the panel beside it changes. The artwork is a fixed piece, not themed: it is
 * a picture, and a picture does not invert with the app's surface colours.
 */

import type { ReactNode } from 'react';
import { Logo } from '@components/Logo';
import { cn } from '@utils/cn';
import styles from './AuthPage.module.css';

const TRAIL = [0, 1, 2, 3, 4, 5];
const DOTS = [0, 1, 2, 3];

function AuthArtwork(): JSX.Element {
  return (
    <svg
      className={styles.artSvg}
      viewBox="0 0 632 608"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="632" height="608" fill="#14121f" />
      <circle cx="470" cy="190" r="210" fill="#2f6bff" />
      <path d="M0 608 A 330 330 0 0 1 330 278 L 330 608 Z" fill="#ff5a36" />
      <rect x="300" y="250" width="250" height="250" rx="40" fill="#ffc233" transform="rotate(18 425 375)" />
      {TRAIL.map((i) => (
        <circle key={i} cx={96 + i * 44} cy={150 - i * 12} r={10 + i * 4} fill="#f3efe6" opacity={0.12 + i * 0.17} />
      ))}
      <path d="M360 60 A 150 150 0 0 1 600 240" fill="none" stroke="#f3efe6" strokeWidth="22" strokeLinecap="round" />
      <g fill="#14121f">
        {DOTS.map((r) => DOTS.map((c) => <circle key={`${r}-${c}`} cx={60 + c * 30} cy={400 + r * 30} r="5" />))}
      </g>
      <rect x="470" y="470" width="220" height="34" rx="17" fill="#f3efe6" />
      <rect x="520" y="520" width="220" height="34" rx="17" fill="#2f6bff" />
    </svg>
  );
}

export interface AuthShellProps {
  title: string;
  /** One or two sentences under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AuthShell({ title, subtitle, children, className }: AuthShellProps): JSX.Element {
  return (
    <div className={styles.container}>
      <div className={styles.art}>
        <AuthArtwork />
        <div className={styles.artCaption}>
          <span className={styles.artTagline}>Make it move.</span>
          <span className={styles.artSub}>Motion graphics and compositing</span>
        </div>
      </div>

      <div className={styles.side}>
        <div className={styles.brandHeader}>
          <Logo variant="lockup" size={22} />
        </div>
        <div className={cn(styles.card, className)}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The two rules the server applies to a new password, shown wherever one is set. */
export function PasswordRules({ password }: { password: string }): JSX.Element {
  const long = password.length >= 8;
  const mixed = /[A-Za-z]/.test(password) && /\d/.test(password);
  return (
    <div className={styles.passwordRules} aria-live="polite">
      <span className={cn(styles.ruleChip, long && styles.ruleChipValid)}>
        <span className={styles.ruleDot} />
        <span>8 or more characters</span>
      </span>
      <span className={cn(styles.ruleChip, mixed && styles.ruleChipValid)}>
        <span className={styles.ruleDot} />
        <span>A letter and a number</span>
      </span>
    </div>
  );
}
