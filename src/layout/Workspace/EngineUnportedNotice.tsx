/**
 * D5: what the C++ engine could not draw in the active composition.
 *
 * With the engine as the viewport, a layer that uses a feature its scene
 * builder has not ported yet is drawn WITHOUT that feature (the engine reports
 * it on `layerErrors` with stage 'unported'; a failed effect / decode / plugin
 * reports its own stage). The frame still shows everything else — never a blank
 * viewport — and this says, without blocking anything, what is missing and on
 * how many layers. Dismissable until the set changes.
 *
 * Reads: the `errors:<comp>` mirror key as the trigger (the engine announces
 * changes only), `getLayerErrors` for the set (so a notice mounted after the
 * announcement still knows it). React renders only when the set changes.
 */

import { useEffect, useMemo, useState } from 'react';
import type { LayerError } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useActiveCompId, useMirrorKeys, useMirror } from '@hooks/useMirror';
import styles from './EngineUnportedNotice.module.css';

interface Group {
  what: string;
  unported: boolean;
  layers: number;
  names: string[];
}

function groupErrors(errors: readonly LayerError[], nameOf: (id: string) => string): Group[] {
  const by = new Map<string, Group & { ids: Set<string> }>();
  for (const e of errors) {
    const unported = e.stage === 'unported';
    const what = unported ? e.message : `${e.stage}: ${e.message}`;
    let g = by.get(what);
    if (!g) {
      g = { what, unported, layers: 0, names: [], ids: new Set() };
      by.set(what, g);
    }
    if (!g.ids.has(e.layer)) {
      g.ids.add(e.layer);
      g.layers += 1;
      if (g.names.length < 3) g.names.push(nameOf(e.layer));
    }
  }
  return [...by.values()]
    .map(({ ids: _ids, ...g }) => g)
    .sort((a, b) => Number(b.unported) - Number(a.unported) || b.layers - a.layers || a.what.localeCompare(b.what));
}

export function EngineUnportedNotice(): JSX.Element | null {
  const comp = useActiveCompId();
  const mirror = useMirror();
  const trigger = useMirrorKeys(comp ? [`errors:${comp}`] : []);
  const [errors, setErrors] = useState<readonly LayerError[]>([]);
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!comp) {
      setErrors([]);
      return;
    }
    let live = true;
    void engine().query({ type: 'getLayerErrors', comp }).then((r) => {
      if (!live) return;
      // The mirror's copy when the query cannot answer (an older engine).
      setErrors(r.ok && r.value.errors.length > 0 ? r.value.errors : mirror.layerErrors(comp));
    });
    return () => {
      live = false;
    };
  }, [comp, trigger, mirror]);

  const groups = useMemo(
    () => groupErrors(errors, (id) => mirror.layer(id)?.name ?? id),
    [errors, mirror],
  );
  const signature = groups.map((g) => `${g.what}×${g.layers}`).join('|');
  if (groups.length === 0 || dismissed === signature) return null;

  const layerCount = new Set(errors.map((e) => e.layer)).size;
  return (
    <div className={styles.notice} role="status" data-engine-unported="">
      <div className={styles.head}>
        <span className={styles.title}>
          Drawn without {groups.length === 1 ? 'one feature' : `${groups.length} features`} the C++ engine does not render yet
          {' '}({layerCount} layer{layerCount === 1 ? '' : 's'})
        </span>
        <button type="button" className={styles.close} onClick={() => setDismissed(signature)} aria-label="Dismiss">×</button>
      </div>
      <ul className={styles.list}>
        {groups.slice(0, 6).map((g) => (
          <li key={g.what}>
            <span className={styles.what}>{g.what}</span>
            <span className={styles.layers}>
              {g.layers} layer{g.layers === 1 ? '' : 's'}: {g.names.join(', ')}{g.layers > g.names.length ? ', …' : ''}
            </span>
          </li>
        ))}
        {groups.length > 6 && <li className={styles.layers}>and {groups.length - 6} more</li>}
      </ul>
    </div>
  );
}
