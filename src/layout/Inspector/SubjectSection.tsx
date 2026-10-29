/**
 * Properties ▸ Subjects — a footage layer's subjects and what is done with
 * them (the approved Subjects Pro design, boards 1 and 2).
 *
 *   list    every subject in its colour: click to make it the active one (the
 *           one Shift / Alt clicks, the brushes and Follow edit), rename,
 *           recolour, show / hide, lock, reorder, delete
 *   edge    the active subject's live edge — Feather, Choke, Contrast,
 *           Temporal Smooth, Invert — applied when the matte is read, every
 *           frame, nothing re-run (layer/subjects)
 *   use as  Follow, New Layer, Text Behind, Remove Background, Track with Null
 *   styles  the effects that read that subject alone, and the preset shelf
 *
 * Every change is one undo entry and leaves ordinary effects and layers.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import { useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSubjectStore } from '@stores/subjectStore';
import { edit } from '@core/engine/uiEdits';
import { t } from '@core/i18n';
import { mirrorEffects } from '@core/mirror/effects';
import { effectDisplayNames } from '@core/inspector/effectCatalog';
import {
  EDGE_DEFAULTS,
  SUBJECT_PALETTE as PALETTE,
  layerSubjects,
  moveSubjectCommands,
  removeSubjectCommands,
  subjectOutlines,
  updateSubjectCommands,
  type Subject,
  type SubjectEdge,
} from '@core/workspace/subjects';
import { followSubject, subjectActions, subjectStateOf, type SubjectState } from '@layout/Workspace/subjectActions';
import { SUBJECT_STYLES, applySubjectStyle } from '@layout/Workspace/subjectStyles';
import { openTextBehind } from '@layout/Workspace/TextBehindDialog';
import { useEngineEdit } from './useEngineEdit';
import styles from './SubjectSection.module.css';

const EMPTY: SubjectState = { selected: false, followed: false, frozen: false, cuts: false };

/** Footage layers only: a matte is cut from source pixels. */
export function isSubjectCandidate(nodeId: string): boolean {
  const m = documentMirror();
  const src = m.layer(nodeId)?.source;
  const type = src ? m.item(src)?.mediaType : undefined;
  return type === 'video' || type === 'image';
}

/** How many frames a subject was followed over (its outline's keys); 0 = selected on one frame. */
function followedFrames(nodeId: string, subject: string): number {
  const mask = subjectOutlines(nodeId).get(subject);
  return mask ? documentMirror().keyframes(nodeId, `masks/${mask}/path`).length : 0;
}

export function SubjectSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const rev = useMirrorRevisionFrame();
  const [state, setState] = useState<SubjectState>(EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  const storedActive = useSubjectStore((s) => s.active[nodeId]);
  const engineEdit = useEngineEdit();

  useEffect(() => {
    let live = true;
    void subjectStateOf(nodeId).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [nodeId, rev]);

  if (!isSubjectCandidate(nodeId)) return null;
  void rev;
  const subjects = layerSubjects(nodeId);
  const actions = subjectActions(nodeId, state, { openTextBehind });
  const select = actions.find((a) => a.id === 'select')!;

  if (subjects.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.help}>
          {t('inspector.subject.emptyHelp2', 'Select people and objects with the Object Matte tool: hover to see what can be picked, click to make a subject. Each one gets its own edge, styles and tracking here.')}
        </p>
        <button type="button" className={styles.primary} onClick={select.run}>{select.label}</button>
      </div>
    );
  }

  const active = subjects.find((s) => s.id === storedActive) ?? subjects[subjects.length - 1]!;
  const setActive = (id: string): void => useSubjectStore.getState().setActive(nodeId, id);
  const update = (label: string, id: string, patch: Partial<Omit<Subject, 'id'>>): void => {
    const commands = updateSubjectCommands(nodeId, id, patch);
    if (commands.length) void edit(label, commands);
  };
  const edgeOf = <K extends keyof SubjectEdge>(k: K): Required<SubjectEdge>[K] => (active[k] ?? EDGE_DEFAULTS[k]) as Required<SubjectEdge>[K];
  const edgeField = (k: 'feather' | 'choke' | 'contrast' | 'smooth', label: string, opts: { min: number; max: number; unit: string; step?: number }): JSX.Element => (
    <label className={styles.edgeRow}>
      <span className={styles.edgeLabel}>{label}</span>
      <ValueField
        value={edgeOf(k)}
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        precision={1}
        unit={opts.unit}
        {...engineEdit.scrub(t('inspector.subject.edgeEdit', 'Subject Edge'))}
        onScrub={(v) => engineEdit.send(t('inspector.subject.edgeEdit', 'Subject Edge'), updateSubjectCommands(nodeId, active.id, { [k]: v }))}
        onChange={(v) => engineEdit.send(t('inspector.subject.edgeEdit', 'Subject Edge'), updateSubjectCommands(nodeId, active.id, { [k]: v }))}
      />
    </label>
  );

  // The active subject's styles: the effects that read it alone (with one subject, every subject effect).
  const effects = mirrorEffects(documentMirror().tree(nodeId));
  const names = effectDisplayNames(effects);
  const styled = effects.filter((e) =>
    e.type !== 'object-matte' &&
    (subjects.length === 1
      ? !!e.subjectScope || e.subjectId === active.id || e.type === 'matte-stroke' || e.type === 'selective-color-ai'
      : e.subjectId === active.id));

  const use = actions.filter((a) => a.id === 'newLayer' || a.id === 'textBehind' || a.id === 'removeBackground' || a.id === 'trackNull');
  const followed = followedFrames(nodeId, active.id);

  return (
    <div className={styles.root}>
      <div className={styles.listHead}>
        <span className={styles.listTitle}>{t('inspector.subject.count', 'Subjects · {n}', { n: subjects.length })}</span>
        <button type="button" className={styles.secondary} onClick={select.run}>{t('inspector.subject.addMore', 'Select more')}</button>
      </div>
      <ul className={styles.list} aria-label={t('inspector.subject.listLabel', 'Subjects')}>
        {subjects.map((s, i) => {
          const isActive = s.id === active.id;
          const frames = followedFrames(nodeId, s.id);
          return (
            <li key={s.id} className={isActive ? styles.rowActive : styles.row} style={{ '--subject-color': s.color } as CSSProperties}>
              <button
                type="button"
                className={styles.swatch}
                title={t('inspector.subject.recolour', 'Change colour')}
                aria-label={t('inspector.subject.recolour', 'Change colour')}
                onClick={() => update(t('inspector.subject.recolourLabel', 'Subject Colour'), s.id, { color: PALETTE[(PALETTE.indexOf(s.color) + 1) % PALETTE.length]! })}
              />
              {renaming === s.id ? (
                <input
                  className={styles.nameInput}
                  defaultValue={s.name}
                  autoFocus
                  aria-label={t('inspector.subject.rename', 'Rename subject')}
                  onBlur={(e) => {
                    setRenaming(null);
                    const name = e.currentTarget.value.trim();
                    if (name && name !== s.name) update(t('inspector.subject.renameLabel', 'Rename Subject'), s.id, { name });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.name}
                  onClick={() => setActive(s.id)}
                  onDoubleClick={() => setRenaming(s.id)}
                  title={t('inspector.subject.nameHint', 'Click to make it the active subject · double-click to rename')}
                >
                  <span className={styles.nameText}>{s.name}</span>
                  <span className={styles.meta}>{frames > 1 ? t('inspector.subject.followedShort', '{n} frames', { n: frames }) : t('inspector.subject.oneFrameShort', 'one frame')}</span>
                </button>
              )}
              <button type="button" className={styles.icon} aria-label={s.hidden ? t('inspector.subject.show', 'Show') : t('inspector.subject.hide', 'Hide')}
                title={s.hidden ? t('inspector.subject.show', 'Show') : t('inspector.subject.hide', 'Hide')}
                onClick={() => update(s.hidden ? t('inspector.subject.showLabel', 'Show Subject') : t('inspector.subject.hideLabel', 'Hide Subject'), s.id, { hidden: !s.hidden })}>
                <Icon name={s.hidden ? 'eye-off' : 'eye'} size={14} />
              </button>
              <button type="button" className={styles.icon} aria-label={s.locked ? t('inspector.subject.unlock', 'Unlock') : t('inspector.subject.lock', 'Lock')}
                title={s.locked ? t('inspector.subject.unlock', 'Unlock') : t('inspector.subject.lock', 'Lock')}
                onClick={() => update(s.locked ? t('inspector.subject.unlockLabel', 'Unlock Subject') : t('inspector.subject.lockLabel', 'Lock Subject'), s.id, { locked: !s.locked })}>
                <Icon name={s.locked ? 'lock' : 'unlock'} size={14} />
              </button>
              <button type="button" className={styles.icon} aria-label={t('inspector.subject.up', 'Move up')} title={t('inspector.subject.up', 'Move up')} disabled={i === 0}
                onClick={() => void edit(t('inspector.subject.reorder', 'Reorder Subjects'), moveSubjectCommands(nodeId, s.id, -1))}>
                <Icon name="chevron-up" size={14} />
              </button>
              <button type="button" className={styles.icon} aria-label={t('inspector.subject.delete', 'Delete subject')} title={t('inspector.subject.delete', 'Delete subject')}
                onClick={() => void edit(t('inspector.subject.deleteLabel', 'Delete Subject'), removeSubjectCommands(nodeId, s.id))}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className={styles.block} style={{ '--subject-color': active.color } as CSSProperties}>
        <div className={styles.blockHead}>
          <span className={styles.dot} />
          <span className={styles.blockTitle}>{t('inspector.subject.edgeTitle', 'Edge · {name}', { name: active.name })}</span>
          <span className={styles.meta}>{t('inspector.subject.live', 'live, every frame')}</span>
        </div>
        {edgeField('feather', t('inspector.subject.feather', 'Feather'), { min: 0, max: 200, unit: 'px', step: 0.5 })}
        {edgeField('choke', t('inspector.subject.choke', 'Expand / Choke'), { min: -50, max: 50, unit: 'px' })}
        {edgeField('contrast', t('inspector.subject.contrast', 'Contrast'), { min: 0, max: 100, unit: '%' })}
        {edgeField('smooth', t('inspector.subject.smooth', 'Temporal smooth'), { min: 0, max: 100, unit: '%' })}
        <label className={styles.check}>
          <input type="checkbox" checked={!!active.invert}
            onChange={(e) => update(t('inspector.subject.invertLabel', 'Invert Subject'), active.id, { invert: e.currentTarget.checked })} />
          {t('inspector.subject.invert', 'Invert (everything but the subject)')}
        </label>
      </div>

      <div className={styles.block}>
        <div className={styles.blockHead}>
          <span className={styles.blockTitle}>{t('inspector.subject.useAs', 'Use {name}', { name: active.name })}</span>
        </div>
        <button type="button" className={styles.follow} disabled={active.locked}
          onClick={() => { void followSubject(nodeId, active.id); }}>
          <span className={styles.actionTitle}>{followed > 1 ? t('inspector.subject.refollow', 'Follow again through the shot') : t('workspace.subjects.action.follow', 'Follow Through Shot')}</span>
          <span className={styles.actionDesc}>{followed > 1
            ? t('inspector.subject.followedOver', 'Followed over {n} frames · fix a frame with Shift / Alt clicks, then follow again', { n: followed })
            : t('workspace.subjects.action.followDesc', 'Carry the selection to every frame')}</span>
        </button>
        <div className={styles.grid}>
          {use.map((a) => (
            <button key={a.id} type="button" className={styles.action} disabled={a.disabled} title={a.description} onClick={a.run}>
              <span className={styles.actionTitle}>{a.label}</span>
              <span className={styles.actionDesc}>{a.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockHead}>
          <span className={styles.blockTitle}>{t('inspector.subject.styles', 'Styles · {name}', { name: active.name })}</span>
        </div>
        {styled.length === 0 ? (
          <p className={styles.help}>{t('inspector.subject.noStyles', 'No style yet. Pick one below — each is ordinary effects you can tweak in Effect Controls.')}</p>
        ) : (
          <ul className={styles.styleList}>
            {styled.map((e) => (
              <li key={e.id} className={styles.styleRow}>
                <input
                  type="checkbox"
                  checked={e.enabled !== false}
                  aria-label={t('inspector.subject.styleOn', '{name} on', { name: names.get(e.id) ?? e.type })}
                  onChange={(ev) => void edit(t('inspector.subject.styleToggle', 'Toggle Style'), { type: 'setGroupEnabled', groups: [{ layer: nodeId, path: `effects/${e.id}` }], enabled: ev.currentTarget.checked })}
                />
                <span className={styles.styleName}>{names.get(e.id) ?? e.type}</span>
                {e.subjectScope === 'background' && <span className={styles.meta}>{t('inspector.subject.onBackground', 'background')}</span>}
                <button type="button" className={styles.icon} aria-label={t('inspector.subject.styleRemove', 'Remove')} title={t('inspector.subject.styleRemove', 'Remove')}
                  onClick={() => void edit(t('inspector.subject.styleRemoveLabel', 'Remove Style'), { type: 'removePropertyGroups', groups: [{ layer: nodeId, path: `effects/${e.id}` }] })}>
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.presets} role="group" aria-label={t('inspector.subject.presets', 'Style presets')}>
          {SUBJECT_STYLES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.preset}
              data-kind={p.kind}
              title={p.hint()}
              onClick={() => {
                useSelectionStore.getState().set([nodeId]);
                void applySubjectStyle(nodeId, subjects.length > 1 ? active.id : null, p);
              }}
            >
              <span className={styles.presetSwatch} aria-hidden="true" />
              {p.label()}
            </button>
          ))}
        </div>
      </div>
      <p className={styles.help}>
        {t('inspector.subject.footnote2', 'Object Matte tool: click a new object for a new subject · Shift-click adds to the active one · Alt-click cuts from it · Tab picks a part.')}
      </p>
      <button
        type="button"
        className={styles.secondary}
        onClick={() => {
          useSelectionStore.getState().set([nodeId]);
          useUIStore.getState().setActiveTool('object-matte');
        }}
      >
        {t('inspector.subject.edit', 'Edit')}
      </button>
    </div>
  );
}
