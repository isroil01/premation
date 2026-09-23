/**
 * Find and Replace Text — across the selection, the comp, or every comp.
 *
 * AE has no such dialog; motion designers do this by opening every text
 * layer in turn, which is exactly the chore a lower-thirds package with forty
 * name layers turns into an afternoon. The rules (grapheme-safe matching,
 * Match case, Whole word, run offsets kept on the right characters) live in
 * `findReplaceText.ts`; which text is searched — content AND Source Text
 * keyframe values — lives in `textFindReplace.ts`.
 *
 * The match count is live, so the user sees what Replace All will touch
 * before it touches it. Replace All is one undo entry.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Checkbox } from '@components/Checkbox';
import { Segmented } from '@components/Segmented';
import { DialogFooter } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import {
  countInScope,
  replaceAllInScope,
  textLayersInScope,
  type FindScope,
} from '@core/textTools/textFindReplace';
import styles from './TextDialogs.module.css';

export const FIND_REPLACE_TEXT_MODAL_ID = 'find-replace-text';

const SCOPES: ReadonlyArray<{ value: FindScope; label: string }> = [
  { value: 'selected', label: 'Selected layers' },
  { value: 'comp', label: 'This comp' },
  { value: 'all', label: 'All comps' },
];

const plural = (n: number, word: 'match' | 'layer'): string =>
  `${n} ${n === 1 ? word : word === 'match' ? 'matches' : 'layers'}`;

export function FindReplaceTextBody({ close, initialScope }: { close: () => void; initialScope: FindScope }): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const animRev = useAnimationRevision();
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [scope, setScope] = useState<FindScope>(initialScope);
  const [done, setDone] = useState<string | null>(null);

  const opts = useMemo(() => ({ matchCase, wholeWord }), [matchCase, wholeWord]);
  const count = useMemo(
    () => countInScope(scope, find, opts),
    // `rev`/`animRev` re-count after an edit (or an undo) changes the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, find, opts, rev, animRev],
  );

  const replaceAll = (): void => {
    // B3-legacy: engine gap — a replace re-indexes the layers' style runs (`text/sourceText` writes drop
    // `__runs`, ENGINE_API.md §15.4) and rewrites Source Text keyframe values on layers of every comp; one runDocumentEdit entry.
    const r = replaceAllInScope(scope, find, replacement, opts);
    setDone(`Replaced ${plural(r.matches, 'match')} in ${plural(r.layers, 'layer')}.`);
  };

  const status = !find
    ? 'Type text to find.'
    : count.matches === 0
      ? 'No matches.'
      : `${plural(count.matches, 'match')} in ${plural(count.layers, 'layer')}`;

  return (
    <div className={styles.body}>
      <div className={styles.fields}>
        <Input
          label="Find"
          value={find}
          autoFocus
          fullWidth
          onChange={(e) => { setFind(e.currentTarget.value); setDone(null); }}
        />
        <Input
          label="Replace with"
          value={replacement}
          fullWidth
          onChange={(e) => { setReplacement(e.currentTarget.value); setDone(null); }}
        />
      </div>
      <div className={styles.options}>
        <Checkbox label="Match case" checked={matchCase} onChange={(e) => setMatchCase(e.currentTarget.checked)} />
        <Checkbox label="Whole word" checked={wholeWord} onChange={(e) => setWholeWord(e.currentTarget.checked)} />
      </div>
      <Segmented<FindScope>
        aria-label="Search in"
        options={SCOPES}
        value={scope}
        onChange={(s) => { setScope(s); setDone(null); }}
        fullWidth
        size="sm"
      />
      <p className={styles.status} role="status" aria-live="polite">
        {done ?? status}
      </p>
      <DialogFooter
        note="Source Text keyframes are searched too."
        secondary={<Button variant="secondary" onClick={close}>Close</Button>}
        primary={
          <Button variant="primary" disabled={!find || count.matches === 0} onClick={replaceAll}>
            Replace All
          </Button>
        }
      />
    </div>
  );
}

/** Open the dialog. Starts on "Selected layers" when the selection holds text. */
export function openFindReplaceTextDialog(): void {
  const hasSelectedText = useSelectionStore.getState().ids.length > 0 && textLayersInScope('selected').length > 0;
  const initialScope: FindScope = hasSelectedText ? 'selected' : 'comp';
  openModal({
    id: FIND_REPLACE_TEXT_MODAL_ID,
    title: 'Find and Replace Text',
    size: 'sm',
    render: (close) => <FindReplaceTextBody close={close} initialScope={initialScope} />,
  });
}
