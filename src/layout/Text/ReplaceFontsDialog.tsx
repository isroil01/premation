/**
 * Replace Fonts — the missing-font dialog, and AE's Find and Replace Fonts.
 *
 * One row per family the document uses: the family, a "Missing" badge when
 * this machine cannot draw it, the layers that use it, and a font picker for
 * its replacement. Replace applies every chosen substitution as ONE undo entry
 * (`replaceFontFamilies`), over layer fonts and rich-text runs alike.
 *
 * Opened two ways: from the "N fonts missing" toast after a project opens
 * (missing families only), and from the `text.replaceFonts` command (every
 * family used, missing ones first).
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { DialogFooter } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { FontPicker } from '@layout/Inspector/FontPicker';
import { collectFontUsage, familyKey, type FontUsage } from '@core/fonts/missingFonts';
import { detectFontAvailability } from '@core/fonts/fontAvailability';
import { replaceFontFamiliesEdit } from './textEdits';
import type { SceneNode } from '@core/types';
import styles from './TextDialogs.module.css';

export const REPLACE_FONTS_MODAL_ID = 'replace-fonts';

/** How many layer names a row lists before collapsing to "+N more". */
const LAYER_NAMES_SHOWN = 3;

export interface ReplaceFontsBodyProps {
  usages: ReadonlyArray<FontUsage>;
  /** Lower-cased keys of families this machine cannot draw. */
  missingKeys: ReadonlySet<string>;
  close: () => void;
}

export function ReplaceFontsBody({ usages, missingKeys, close }: ReplaceFontsBodyProps): JSX.Element {
  const [choices, setChoices] = useState<Record<string, string>>({});

  const ordered = useMemo(
    () => [...usages].sort((a, b) =>
      Number(missingKeys.has(familyKey(b.family))) - Number(missingKeys.has(familyKey(a.family)))
      || a.family.localeCompare(b.family)),
    [usages, missingKeys],
  );

  const pending = Object.entries(choices).filter(([from, to]) => to && familyKey(to) !== familyKey(from));

  const apply = (): void => {
    // One engine batch: `text/fontFamily` + `text/styleRuns` on every layer that uses a replaced font.
    void replaceFontFamiliesEdit(new Map(pending)).then((layers) => {
      useUIStore.getState().notify({
        level: 'success',
        message: `Replaced fonts on ${layers} layer${layers === 1 ? '' : 's'}`,
        durationMs: 2600,
      });
    });
    close();
  };

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        {missingKeys.size > 0
          ? 'These fonts are not installed on this computer, so their layers draw in a fallback font. Pick a replacement for each — one undo puts them all back.'
          : 'Every font this project uses. Pick a replacement to swap it on every layer and styled run that uses it.'}
      </p>
      <ul className={styles.fontRows} aria-label="Fonts used in this project">
        {ordered.map((u) => {
          const missing = missingKeys.has(familyKey(u.family));
          const names = u.layers.map((l) => l.name);
          const shown = names.slice(0, LAYER_NAMES_SHOWN).join(', ');
          const more = names.length - LAYER_NAMES_SHOWN;
          return (
            <li key={u.family} className={styles.fontRow} aria-label={u.family}>
              <div className={styles.fontInfo}>
                <span className={styles.fontName}>
                  {u.family}
                  {missing ? <span className={styles.missingBadge}>Missing</span> : null}
                </span>
                <span className={styles.fontLayers} title={names.join(', ')}>
                  {u.layers.length} layer{u.layers.length === 1 ? '' : 's'}: {shown}{more > 0 ? ` +${more} more` : ''}
                </span>
              </div>
              <div className={styles.fontChoice}>
                <FontPicker
                  value={choices[u.family] || u.family}
                  onChange={(family) => setChoices((c) => ({ ...c, [u.family]: family }))}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <DialogFooter
        note={pending.length > 0 ? `${pending.length} replacement${pending.length === 1 ? '' : 's'} chosen` : undefined}
        secondary={<Button variant="secondary" onClick={close}>Cancel</Button>}
        primary={
          <Button variant="primary" disabled={pending.length === 0} onClick={apply}>
            Replace
          </Button>
        }
      />
    </div>
  );
}

/** Open the dialog for known usages. */
export function openReplaceFontsDialog(usages: ReadonlyArray<FontUsage>, missingKeys: ReadonlySet<string>): void {
  openModal({
    id: REPLACE_FONTS_MODAL_ID,
    title: missingKeys.size > 0 ? 'Replace Missing Fonts' : 'Find and Replace Fonts',
    size: 'md',
    render: (close) => <ReplaceFontsBody usages={usages} missingKeys={missingKeys} close={close} />,
  });
}

/** Every text node in the document. */
function allNodes(): SceneNode[] {
  const out: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => { out.push(n); });
  return out;
}

/**
 * Find and Replace Fonts: every family used, with missing ones marked.
 * Resolves false (and says so) when the project uses no fonts.
 */
export async function openFindAndReplaceFonts(): Promise<boolean> {
  const usages = collectFontUsage(allNodes());
  if (usages.length === 0) {
    useUIStore.getState().notify({ level: 'info', message: 'No text layer in this project sets a font', durationMs: 2600 });
    return false;
  }
  const isAvailable = await detectFontAvailability();
  const missing = new Set(usages.filter((u) => !isAvailable(u.family)).map((u) => familyKey(u.family)));
  openReplaceFontsDialog(usages, missing);
  return true;
}
