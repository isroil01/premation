/**
 * Subject chips — every subject of the composition's footage, as a row above
 * the viewer while a roto tool is up (AE 26's Object Matte keeps its
 * selections as named entries). One chip per subject, in its colour: a click
 * selects its layer and makes it the active subject (what Shift / Alt clicks,
 * the brushes and Follow edit); its menu does the next thing a subject is for
 * (the same list as Properties ▸ Subjects and right-click ▸ Subject).
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { activeSubjectId, useSubjectStore } from '@stores/subjectStore';
import { documentMirror } from '@stores/documentMirror';
import { openContextMenu } from '@stores/contextMenuStore';
import { useActiveCompRootId, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { layerSubjects, subjectOutlines } from '@core/workspace/subjects';
import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import { subjectMenuItems } from './subjectActions';
import { openTextBehind } from './TextBehindDialog';
import styles from './SubjectChips.module.css';

interface Chip {
  layer: string;
  subject: string;
  name: string;
  color: string;
  /** The matte runs through the shot (keyed outline), not one frame. */
  tracked: boolean;
}

/** Every subject of the footage layers of `comp`, front layer first. */
async function chipsOf(comp: string): Promise<Chip[]> {
  const m = documentMirror();
  const layers = (m.comp(comp)?.layers ?? []).filter((id) => {
    const src = m.layer(id)?.source;
    const type = src ? m.item(src)?.mediaType : undefined;
    return type === 'video' || type === 'image';
  });
  await m.loadTrees(layers);
  const out: Chip[] = [];
  for (const layer of layers) {
    const outlines = subjectOutlines(layer);
    for (const s of layerSubjects(layer)) {
      const mask = outlines.get(s.id);
      out.push({ layer, subject: s.id, name: s.name, color: s.color, tracked: !!mask && m.keyframes(layer, `masks/${mask}/path`).length > 1 });
    }
  }
  return out;
}

export function SubjectChips(): JSX.Element | null {
  const on = useUIStore((s) => s.activeTool === 'object-matte' || s.activeTool === 'roto');
  return on ? <SubjectChipsActive /> : null;
}

function SubjectChipsActive(): JSX.Element | null {
  const tool = useUIStore((s) => s.activeTool);
  const comp = useActiveCompRootId();
  const rev = useMirrorRevisionFrame();
  const selected = useSelectionStore((s) => s.ids);
  useSubjectStore((s) => s.active);
  const [chips, setChips] = useState<Chip[]>([]);
  const on = tool === 'object-matte' || tool === 'roto';

  useEffect(() => {
    if (!on) return;
    let live = true;
    void chipsOf(comp).then((c) => { if (live) setChips(c); });
    return () => { live = false; };
  }, [on, comp, rev]);

  if (!on || chips.length === 0) return null;

  return (
    <div className={styles.row} role="toolbar" aria-label={t('workspace.subjects.aria', 'Subjects')}>
      {chips.map((c) => {
        const active = selected.includes(c.layer) && activeSubjectId(c.layer) === c.subject;
        return (
          <span key={`${c.layer}:${c.subject}`} className={active ? styles.chipActive : styles.chip} style={{ '--subject-color': c.color } as CSSProperties}>
            <button
              type="button"
              className={styles.pick}
              title={c.tracked
                ? t('workspace.subjects.titleTracked', '{name}: matte through the shot', { name: c.name })
                : t('workspace.subjects.titleFrame', '{name}: matte on one frame (Propagate to follow it)', { name: c.name })}
              aria-pressed={active}
              onClick={() => {
                useSelectionStore.getState().set([c.layer]);
                useSubjectStore.getState().setActive(c.layer, c.subject);
              }}
            >
              <span className={styles.swatch} aria-hidden="true" />
              {c.name}
              {c.tracked && <Icon name="object-matte" size="sm" />}
            </button>
            <button
              type="button"
              className={styles.more}
              aria-label={t('workspace.subjects.menu', '{label} actions', { label: c.name })}
              onClick={(e) => {
                useSubjectStore.getState().setActive(c.layer, c.subject);
                const r = e.currentTarget.getBoundingClientRect();
                openContextMenu(r.left, r.bottom + 2, subjectMenuItems(c.layer, { openTextBehind }));
              }}
            >
              <Icon name="chevron-down" size="sm" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
