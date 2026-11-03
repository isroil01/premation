/**
 * Properties ▸ Subject — a footage layer's subjects and what is done with
 * them (the Subjects Pro design, regrouped by the 2026-11-03 panel redesign).
 *
 *   list    every subject in its colour: click to make it the active one (the
 *           one Shift / Alt clicks, the brushes and Track edit); hide and lock
 *           on hover (shown when on); rename, recolour, move and delete in its
 *           ⋯ menu; drag to reorder. The Object Matte tool and Add sit above.
 *   scope   everything under the list is about the active subject: a rail in
 *           its colour down the left, its name once at the top.
 *   edge    its live edge (Feather, Choke, Contrast, Temporal Smooth, Invert),
 *           applied when the matte is read, every frame, nothing re-run, and
 *           how the viewers show the matte (layer/subjects)
 *   track   a lane per subject, Track through the shot, Frames to Review,
 *           Re-track between fixes (SubjectTracking.tsx)
 *   create  New Layer, Text Behind, Remove Background, Remove from Shot,
 *           Track with Null
 *   styles  the effects that read that subject alone, each opening onto its
 *           own parameters, and the gallery that adds more
 *
 * Each group folds (the user's preference) and reports its state in its head.
 * Every change is one undo entry and leaves ordinary effects and layers.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ValueField } from '@components/ValueField';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSubjectStore } from '@stores/subjectStore';
import { edit } from '@core/engine/uiEdits';
import { t } from '@core/i18n';
import { mirrorEffects } from '@core/mirror/effects';
import { effectDisplayNames } from '@core/inspector/effectCatalog';
import { framesToTimecode } from '@core/time/timecode';
import { readStyleSpan, styleOpacityPath } from '@core/workspace/subjectStyleTime';
import {
  EDGE_DEFAULTS,
  SUBJECT_PALETTE as PALETTE,
  layerSubjects,
  moveSubjectCommands,
  moveSubjectToCommands,
  removeSubjectCommands,
  updateSubjectCommands,
  type Subject,
  type SubjectEdge,
} from '@core/workspace/subjects';
import { cancelSubjectWalk, subjectActions, subjectStateOf, type SubjectActionId, type SubjectState } from '@layout/Workspace/subjectActions';
import { openTextBehind } from '@layout/Workspace/TextBehindDialog';
import { EffectParamsBody } from '@layout/Effects/EffectStack';
import { useEngineEdit } from './useEngineEdit';
import { SubjectGroup } from './SubjectGroup';
import { SubjectTracking, SubjectViewRow } from './SubjectTracking';
import { SubjectStyleSpan } from './SubjectStyleSpan';
import { BeforeAfterToggle, SubjectStyleShelf } from './SubjectStyleShelf';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { playheadSeconds } from '@core/timeline/timelineView';
import styles from './SubjectSection.module.css';

const EMPTY: SubjectState = { selected: false, followed: false, frozen: false, cuts: false };

/** The Create group: which subject actions, in this order, with their icons. */
const CREATE: ReadonlyArray<{ id: SubjectActionId; icon: IconName }> = [
  { id: 'newLayer', icon: 'layer-plus' },
  { id: 'textBehind', icon: 'type' },
  { id: 'removeBackground', icon: 'scissors' },
  { id: 'removeFromShot', icon: 'eraser' },
  { id: 'trackNull', icon: 'crosshair' },
];

/** Footage layers only: a matte is cut from source pixels. */
export function isSubjectCandidate(nodeId: string): boolean {
  const m = documentMirror();
  const src = m.layer(nodeId)?.source;
  const type = src ? m.item(src)?.mediaType : undefined;
  return type === 'video' || type === 'image';
}

/** The Edge group's head: what differs from the defaults, or "Default". */
function edgeSummary(s: Subject): string {
  const v = <K extends keyof SubjectEdge>(k: K): Required<SubjectEdge>[K] => (s[k] ?? EDGE_DEFAULTS[k]) as Required<SubjectEdge>[K];
  const parts: string[] = [];
  if (v('feather') !== 0) parts.push(t('inspector.subject.sumFeather', 'Feather {n} px', { n: v('feather') }));
  if (v('choke') !== 0) parts.push(t('inspector.subject.sumChoke', 'Choke {n} px', { n: v('choke') }));
  if (v('contrast') !== 0) parts.push(t('inspector.subject.sumContrast', 'Contrast {n}%', { n: v('contrast') }));
  if (v('smooth') !== 0) parts.push(t('inspector.subject.sumSmooth', 'Smooth {n}%', { n: v('smooth') }));
  if (v('invert')) parts.push(t('inspector.subject.sumInverted', 'Inverted'));
  return parts.length > 0 ? parts.join(' · ') : t('inspector.subject.sumDefault', 'Default');
}

export function SubjectSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const rev = useMirrorRevisionFrame();
  const [state, setState] = useState<SubjectState>(EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [openStyles, setOpenStyles] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<Map<string, Set<string>>>(new Map());
  const storedActive = useSubjectStore((s) => s.active[nodeId]);
  const engineEdit = useEngineEdit();

  useEffect(() => {
    let live = true;
    void subjectStateOf(nodeId).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [nodeId, rev]);

  const subjects = isSubjectCandidate(nodeId) ? layerSubjects(nodeId) : [];
  const active = subjects.find((s) => s.id === storedActive) ?? subjects[subjects.length - 1];

  // The active subject's styles: the effects that read it alone (with one subject, every subject effect).
  const effects = mirrorEffects(documentMirror().tree(nodeId));
  const styled = active ? effects.filter((e) =>
    e.type !== 'object-matte' &&
    (subjects.length === 1
      ? !!e.subjectScope || e.subjectId === active.id || e.type === 'matte-stroke' || e.type === 'selective-color-ai'
      : e.subjectId === active.id)) : [];
  const styledKey = styled.map((e) => e.id).join(',');

  // A style just added opens onto its parameters (its first effect, when a preset is several): tune it once, after adding.
  useEffect(() => {
    if (!active) return;
    const ids = styledKey ? styledKey.split(',') : [];
    const before = known.current.get(active.id);
    known.current.set(active.id, new Set(ids));
    if (!before) return;
    const added = ids.filter((id) => !before.has(id));
    if (added.length > 0) setOpenStyles(new Set(added.slice(0, 1)));
  }, [active?.id, styledKey]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the id list, not the array

  if (!isSubjectCandidate(nodeId)) return null;
  void rev;
  const actions = subjectActions(nodeId, state, { openTextBehind });
  const select = actions.find((a) => a.id === 'select')!;
  const objectMatteTool = (): void => {
    useSelectionStore.getState().set([nodeId]);
    useUIStore.getState().setActiveTool('object-matte');
  };

  if (!active) {
    return (
      <div className={styles.empty}>
        <p className={styles.help}>
          {t('inspector.subject.emptyHelpShort', 'Click a person or object with the Object Matte tool to make a subject.')}
        </p>
        <button type="button" className={styles.primary} onClick={select.run}>{select.label}</button>
      </div>
    );
  }

  const setActive = (id: string): void => useSubjectStore.getState().setActive(nodeId, id);
  const update = (label: string, id: string, patch: Partial<Omit<Subject, 'id'>>): void => {
    const commands = updateSubjectCommands(nodeId, id, patch);
    if (commands.length) void edit(label, commands);
  };
  const recolour = (s: Subject): void =>
    update(t('inspector.subject.recolourLabel', 'Subject Colour'), s.id, { color: PALETTE[(PALETTE.indexOf(s.color) + 1) % PALETTE.length]! });
  const remove = (s: Subject): void => {
    cancelSubjectWalk(nodeId, s.id);
    void edit(t('inspector.subject.deleteLabel', 'Delete Subject'), removeSubjectCommands(nodeId, s.id));
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
        disabled={active.locked}
        {...engineEdit.scrub(t('inspector.subject.edgeEdit', 'Subject Edge'))}
        onScrub={(v) => engineEdit.send(t('inspector.subject.edgeEdit', 'Subject Edge'), updateSubjectCommands(nodeId, active.id, { [k]: v }))}
        onChange={(v) => engineEdit.send(t('inspector.subject.edgeEdit', 'Subject Edge'), updateSubjectCommands(nodeId, active.id, { [k]: v }))}
      />
    </label>
  );

  const names = effectDisplayNames(effects);
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  // A new style span: the playhead on for three seconds (inside the composition).
  const defaultSpan = (): { start: number; end: number } => {
    const end = settingsDurationSeconds(settings) - 1 / fps;
    const start = Math.min(playheadSeconds(), Math.max(0, end));
    return { start, end: Math.min(end, start + 3) };
  };
  // When a style shows, in its row: the whole shot, its span, or keys of its own.
  const whenOf = (effectId: string): string => {
    const keys = documentMirror().keyframes(nodeId, styleOpacityPath(effectId));
    if (keys.length === 0) return t('inspector.subject.spanWholeShot', 'Whole shot');
    const span = readStyleSpan(keys, fps);
    return span ? `${framesToTimecode(span.start, fps)} – ${framesToTimecode(span.end, fps)}` : t('inspector.subject.spanCustom', 'Keyframed');
  };
  const toggleStyle = (id: string): void => setOpenStyles((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const onCount = styled.filter((e) => e.enabled !== false).length;

  return (
    <div className={styles.root}>
      <div className={styles.listHead}>
        <span className={styles.listTitle}>
          {t('inspector.subject.listTitle', 'Subjects')}
          <span className={styles.meta}>{subjects.length}</span>
        </span>
        <button
          type="button"
          className={styles.icon}
          aria-label={t('inspector.subject.editMatte', 'Edit with Object Matte')}
          title={t('inspector.subject.footnote2', 'Object Matte tool: click a new object for a new subject · Shift-click adds to the active one · Alt-click cuts from it · Tab picks a part.')}
          onClick={objectMatteTool}
        >
          <Icon name="object-matte" size="sm" />
        </button>
        <button type="button" className={styles.secondary} title={t('inspector.subject.addMoreHint', 'Click another object in the viewer to add a subject')} onClick={select.run}>
          <Icon name="plus" size="sm" />
          {t('inspector.subject.add', 'Add')}
        </button>
      </div>
      <ul className={styles.list} aria-label={t('inspector.subject.listLabel', 'Subjects')}>
        {subjects.map((s, i) => {
          const isActive = s.id === active.id;
          return (
            <li
              key={s.id}
              className={cn(isActive ? styles.rowActive : styles.row, dragging === s.id && styles.rowDragging)}
              style={{ '--subject-color': s.color } as CSSProperties}
              draggable={renaming !== s.id && subjects.length > 1}
              onDragStart={(e) => { setDragging(s.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { if (dragging && dragging !== s.id) e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && dragging !== s.id) void edit(t('inspector.subject.reorder', 'Reorder Subjects'), moveSubjectToCommands(nodeId, dragging, i));
                setDragging(null);
              }}
            >
              <button
                type="button"
                className={styles.swatch}
                title={t('inspector.subject.recolour', 'Change colour')}
                aria-label={t('inspector.subject.recolour', 'Change colour')}
                onClick={() => recolour(s)}
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
                  aria-pressed={isActive}
                  onClick={() => setActive(s.id)}
                  onDoubleClick={() => setRenaming(s.id)}
                  title={t('inspector.subject.nameHint2', 'Click to make it the active subject · double-click to rename · drag to reorder')}
                >
                  <span className={styles.nameText}>{s.name}</span>
                </button>
              )}
              <button type="button" className={cn(styles.icon, s.hidden ? styles.iconState : styles.iconReveal)}
                aria-label={s.hidden ? t('inspector.subject.show', 'Show') : t('inspector.subject.hide', 'Hide')}
                title={s.hidden ? t('inspector.subject.show', 'Show') : t('inspector.subject.hide', 'Hide')}
                onClick={() => update(s.hidden ? t('inspector.subject.showLabel', 'Show Subject') : t('inspector.subject.hideLabel', 'Hide Subject'), s.id, { hidden: !s.hidden })}>
                <Icon name={s.hidden ? 'eye-off' : 'eye'} size="sm" />
              </button>
              <button type="button" className={cn(styles.icon, s.locked ? styles.iconState : styles.iconReveal)}
                aria-label={s.locked ? t('inspector.subject.unlock', 'Unlock') : t('inspector.subject.lock', 'Lock')}
                title={s.locked ? t('inspector.subject.unlock', 'Unlock') : t('inspector.subject.lock', 'Lock')}
                onClick={() => update(s.locked ? t('inspector.subject.unlockLabel', 'Unlock Subject') : t('inspector.subject.lockLabel', 'Lock Subject'), s.id, { locked: !s.locked })}>
                <Icon name={s.locked ? 'lock' : 'unlock'} size="sm" />
              </button>
              <Dropdown
                placement="bottom-end"
                trigger={
                  <button type="button" className={cn(styles.icon, styles.iconReveal)}
                    aria-label={t('inspector.subject.moreFor', 'More for {name}', { name: s.name })} title={t('inspector.subject.more', 'More')}>
                    <Icon name="more-horizontal" size="sm" />
                  </button>
                }
                items={[
                  { type: 'item', id: 'rename', label: t('inspector.subject.rename', 'Rename subject'), onSelect: () => setRenaming(s.id) },
                  { type: 'item', id: 'recolour', label: t('inspector.subject.recolour', 'Change colour'), onSelect: () => recolour(s) },
                  { type: 'separator' },
                  { type: 'item', id: 'up', label: t('inspector.subject.up', 'Move up'), disabled: i === 0,
                    onSelect: () => void edit(t('inspector.subject.reorder', 'Reorder Subjects'), moveSubjectCommands(nodeId, s.id, -1)) },
                  { type: 'item', id: 'down', label: t('inspector.subject.down', 'Move down'), disabled: i === subjects.length - 1,
                    onSelect: () => void edit(t('inspector.subject.reorder', 'Reorder Subjects'), moveSubjectCommands(nodeId, s.id, 1)) },
                  { type: 'separator' },
                  { type: 'item', id: 'delete', label: t('inspector.subject.delete', 'Delete subject'), danger: true, onSelect: () => remove(s) },
                ]}
              />
            </li>
          );
        })}
      </ul>

      <div className={styles.scope} style={{ '--subject-color': active.color } as CSSProperties}>
        <div className={styles.scopeHead}>
          <span>{t('inspector.subject.editing', 'Editing')}</span>
          <span className={styles.scopeName}>{active.name}</span>
          {active.locked && <span className={styles.meta}>{t('inspector.subject.lockedNote', 'locked')}</span>}
        </div>

        <SubjectGroup id="edge" title={t('inspector.subject.edgeGroup', 'Edge')} summary={edgeSummary(active)}>
          {edgeField('feather', t('inspector.subject.feather', 'Feather'), { min: 0, max: 200, unit: 'px', step: 0.5 })}
          {edgeField('choke', t('inspector.subject.choke', 'Expand / Choke'), { min: -50, max: 50, unit: 'px' })}
          {edgeField('contrast', t('inspector.subject.contrast', 'Contrast'), { min: 0, max: 100, unit: '%' })}
          {edgeField('smooth', t('inspector.subject.smooth', 'Temporal smooth'), { min: 0, max: 100, unit: '%' })}
          <div className={styles.edgeRow}>
            <span className={styles.edgeLabel}>{t('inspector.subject.invertShort', 'Invert')}</span>
            <label className={styles.check}>
              <input type="checkbox" checked={!!active.invert} disabled={active.locked}
                onChange={(e) => update(t('inspector.subject.invertLabel', 'Invert Subject'), active.id, { invert: e.currentTarget.checked })} />
              {t('inspector.subject.invertHint', 'Everything but the subject')}
            </label>
          </div>
          <SubjectViewRow />
        </SubjectGroup>

        <SubjectTracking nodeId={nodeId} subjects={subjects} active={active} rev={rev} locked={!!active.locked} />

        <SubjectGroup id="create" title={t('inspector.subject.createGroup', 'Create from subject')}>
          <div className={styles.grid}>
            {CREATE.map(({ id, icon }) => {
              const a = actions.find((x) => x.id === id);
              if (!a) return null;
              const needsTrack = id === 'trackNull' && !!a.disabled;
              return (
                <button key={a.id} type="button" className={cn(styles.action, id === 'trackNull' && styles.actionWide)}
                  disabled={a.disabled} title={a.description} onClick={a.run}>
                  <Icon name={icon} size="sm" className={styles.actionIcon} />
                  <span className={styles.actionTitle}>{a.label}</span>
                  {needsTrack && <span className={styles.meta}>{t('inspector.subject.trackFirst', 'track first')}</span>}
                </button>
              );
            })}
          </div>
        </SubjectGroup>

        <SubjectGroup
          id="styles"
          title={t('inspector.subject.stylesGroup', 'Styles')}
          summary={styled.length > 0 ? t('inspector.subject.stylesOn', '{n} on', { n: onCount }) : t('inspector.subject.stylesNone', 'None')}
        >
          {styled.length === 0 ? (
            <p className={styles.emptyNote}>{t('inspector.subject.noStylesFor', 'No styles on {name} yet.', { name: active.name })}</p>
          ) : (
            <ul className={styles.styleList}>
              {styled.map((e) => {
                const name = names.get(e.id) ?? e.type;
                const open = openStyles.has(e.id);
                return (
                  <li key={e.id} className={cn(styles.styleItem, open && styles.styleItemOpen)}>
                    <div className={styles.styleRow}>
                      <button type="button" className={styles.styleTwirl} aria-expanded={open}
                        aria-label={t('inspector.subject.styleSettings', 'Settings for {name}', { name })} onClick={() => toggleStyle(e.id)}>
                        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
                      </button>
                      <input
                        type="checkbox"
                        checked={e.enabled !== false}
                        aria-label={t('inspector.subject.styleOn', '{name} on', { name })}
                        onChange={(ev) => void edit(t('inspector.subject.styleToggle', 'Toggle Style'), { type: 'setGroupEnabled', groups: [{ layer: nodeId, path: `effects/${e.id}` }], enabled: ev.currentTarget.checked })}
                      />
                      <button type="button" className={styles.styleName} onClick={() => toggleStyle(e.id)}>{name}</button>
                      {e.subjectScope === 'background' && <span className={styles.meta}>{t('inspector.subject.onBackground', 'background')}</span>}
                      <span className={styles.meta}>{whenOf(e.id)}</span>
                      <button type="button" className={styles.icon} aria-label={t('inspector.subject.styleRemove', 'Remove')} title={t('inspector.subject.styleRemove', 'Remove')}
                        onClick={() => void edit(t('inspector.subject.styleRemoveLabel', 'Remove Style'), { type: 'removePropertyGroups', groups: [{ layer: nodeId, path: `effects/${e.id}` }] })}>
                        <Icon name="close" size="sm" />
                      </button>
                    </div>
                    {open && (
                      <div className={styles.styleBody}>
                        <EffectParamsBody nodeId={nodeId} effect={e} />
                        <SubjectStyleSpan nodeId={nodeId} effectId={e.id} name={name} defaultSpan={defaultSpan} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className={styles.trackRow}>
            <button type="button" className={cn(styles.secondary, galleryOpen && styles.secondaryOn)} aria-expanded={galleryOpen} onClick={() => setGalleryOpen((v) => !v)}>
              <Icon name={galleryOpen ? 'chevron-up' : 'plus'} size="sm" />
              {galleryOpen ? t('inspector.subject.hideGallery', 'Close styles') : t('inspector.subject.addStyle', 'Add style')}
            </button>
            <BeforeAfterToggle nodeId={nodeId} styled={styled.map((e) => ({ id: e.id, enabled: e.enabled !== false }))} />
          </div>
          {galleryOpen && (
            <SubjectStyleShelf nodeId={nodeId} subject={subjects.length > 1 ? active.id : null} activeId={active.id} />
          )}
        </SubjectGroup>
      </div>
    </div>
  );
}
