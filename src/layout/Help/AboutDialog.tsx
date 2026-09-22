/**
 * Help ▸ About.
 *
 * The dialog read "Version 0.1.0 — frontend foundation." in a build whose
 * package.json said 0.8.5: the string was typed into the command once, when it
 * was true, and nothing connected it to the version again. It now reads
 * `APP_VERSION` — package.json, inlined at build time — which is the same
 * constant What's New and the analytics context use, so the three cannot
 * disagree. (The main process's `app.getVersion()` reads that same
 * package.json; going through IPC for it would only make the browser build
 * a special case.)
 */

import { useEffect } from 'react';
import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { Logo } from '@components/Logo';
import { openModal } from '@stores/modalStore';
import { APP_VERSION } from './whatsNew';
import styles from './AboutDialog.module.css';

const MODAL_ID = 'about';

/** The line the dialog shows. Exported so the test pins the text, not the markup. */
export function aboutVersionLine(version: string = APP_VERSION): string {
  return `Version ${version}`;
}

export function AboutContent(): JSX.Element {
  return (
    <div className={styles.body}>
      <Logo variant="lockup" size={34} />
      <p className={styles.tagline}>Professional AI-native motion design application.</p>
      <p className={styles.version}>{aboutVersionLine()}</p>
    </div>
  );
}

export function openAbout(): void {
  openModal({
    // A fixed id: Help ▸ About twice is one dialog, not two.
    id: MODAL_ID,
    title: 'Premation',
    size: 'sm',
    render: () => <AboutContent />,
  });
}

/** `ProjectCommands.About` in `menuModel.ts` — the Help menu row already points here. */
export const HELP_ABOUT_COMMAND = asCommandId('help.about');

export function buildAboutCommand(): Command {
  return {
    id: HELP_ABOUT_COMMAND,
    label: 'About Premation',
    enabled: () => true,
    execute: () => {
      openAbout();
    },
  };
}

/**
 * Registers the command from INSIDE the editor route.
 *
 * Not from `installOverlayCommands` like the other Help commands: `Providers`
 * still registers its own `help.about` (the stale-version copy) during boot,
 * registration replaces by id, and the modal host mounts BEFORE boot — so an
 * install from there would be overwritten every time. Children of `Providers`
 * mount after boot has registered, and remount with it, so this one always
 * lands last. Once the copy in `Providers` is deleted this can move beside
 * its siblings in `helpCommands.ts`.
 */
export function AboutCommandInstaller(): null {
  useEffect(() => {
    try {
      getCommandRegistry().register(buildAboutCommand());
    } catch {
      /* no registry (a pre-boot render in a test) — Providers' copy stands */
    }
  }, []);
  return null;
}
