/**
 * Text Behind — the popover the Subject actions open (the approved Subjects
 * Pro design, board 3): which text, behind which footage, WHICH of its
 * subjects stand in front of it (text can sit between two people: in front of
 * one, behind the other), a layout, an entrance and a soft edge. The depth
 * column shows the result front to back before anything is made.
 *
 * Place Behind is one Behind Subject per text layer (placeBehindSubject.ts)
 * — no second copy of the video; no text selected makes a new title first.
 * Opened through `openTextBehind(layer)`; mounted once by the workspace.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Modal } from '@components/Modal';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { secondsToFlicks, type Command, type PropertyInit } from '@motion/engine-api';
import { values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { playheadSeconds } from '@core/timeline/timelineView';
import { layerSubjects, subjectOutlines } from '@core/workspace/subjects';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useTextBehindStore } from '@stores/textBehindStore';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { t } from '@core/i18n';
import { runPlaceBehindSubject } from './placeBehindSubjectCommand';
import { subjectBoundsInComp } from './placeBehindSubject';
import { followSubject } from './subjectActions';
import styles from './TextBehindDialog.module.css';

export function openTextBehind(layer: string): void {
  useTextBehindStore.getState().open(layer);
}

const ENTRANCES = [
  { id: 'none', label: () => t('workspace.textBehind.animate.none', 'None') },
  { id: 'Rise Up', label: () => t('workspace.textBehind.animate.rise', 'Rise from behind') },
  { id: 'Fade In', label: () => t('workspace.textBehind.animate.fade', 'Fade in') },
  { id: 'Word Rise', label: () => t('workspace.textBehind.animate.words', 'Words rise') },
] as const;

/** How a NEW title is laid out around the subjects. */
const LAYOUTS = [
  { id: 'big', label: () => t('workspace.textBehind.layout.big', 'Big word behind'), hint: () => t('workspace.textBehind.layout.bigHint', 'One bold line across the subject at chest height') },
  { id: 'wall', label: () => t('workspace.textBehind.layout.wall', 'Repeat wall'), hint: () => t('workspace.textBehind.layout.wallHint', 'The word repeated row on row, filling the frame behind them') },
  { id: 'stack', label: () => t('workspace.textBehind.layout.stack', 'Stacked'), hint: () => t('workspace.textBehind.layout.stackHint', 'Two huge lines, top and bottom of the subject') },
  { id: 'marquee', label: () => t('workspace.textBehind.layout.marquee', 'Marquee through'), hint: () => t('workspace.textBehind.layout.marqueeHint', 'A line scrolling right to left behind them') },
] as const;
type LayoutId = (typeof LAYOUTS)[number]['id'];

/** Soft Edge: the subject's edge feathered by this many px where it covers the title. */
const SOFT_EDGE_PX = 4;
/** Anton's advance is about 0.45 em a glyph (the size rules below keep a line inside the frame). */
const GLYPH_EM = 0.45;

export function TextBehindDialog(): JSX.Element | null {
  const layer = useTextBehindStore((s) => s.layer);
  const close = useTextBehindStore((s) => s.close);
  const selection = useSelectionStore((s) => s.ids);
  const [footage, setFootage] = useState<string>('');
  const [inFront, setInFront] = useState<Set<string> | null>(null);
  const [entrance, setEntrance] = useState<string>('Rise Up');
  const [layout, setLayout] = useState<LayoutId>('big');
  const [title, setTitle] = useState<string>(() => t('workspace.textBehind.newText', 'YOUR TITLE'));
  // A subject selected on one frame does not move with the footage: follow it first (AE: propagate, then stack).
  const [followFirst, setFollowFirst] = useState(true);
  // The subject's edge feathered where it covers the title (layer/behindSubjectSoftness).
  const [softEdge, setSoftEdge] = useState(true);
  const [busy, setBusy] = useState(false);

  const m = documentMirror();
  const comp = layer ? m.layer(layer)?.comp : undefined;
  // The selected text layers of the footage's composition: what goes behind.
  const texts = useMemo(() => selection.filter((id) => m.layer(id)?.kind === 'text' && m.layer(id)?.comp === comp), [selection, comp, m]);
  // Footage layers of the composition that have subjects (read while open: it must see a matte made since).
  const footages = (comp ? (m.comp(comp)?.layers ?? []) : []).filter((id) => layerSubjects(id).length > 0);

  useEffect(() => {
    if (layer) {
      setFootage(layer);
      setInFront(null);
    }
  }, [layer]);

  if (!layer) return null;
  const subjects = footage ? layerSubjects(footage) : [];
  const front = subjects.filter((s) => !s.hidden && (inFront ? inFront.has(s.id) : true));
  const back = subjects.filter((s) => !s.hidden && !front.includes(s));
  const followedOf = (id: string): boolean => {
    const mask = subjectOutlines(footage).get(id);
    return !!mask && m.keyframes(footage, `masks/${mask}/path`).length > 1;
  };
  const unfollowed = front.filter((s) => !followedOf(s.id));
  const textLabel = texts.length > 0 ? texts.map((id) => m.layer(id)?.name ?? id).join(', ') : (title || t('workspace.textBehind.newText', 'YOUR TITLE'));

  const toggleFront = (id: string): void => {
    const next = new Set(inFront ?? subjects.map((s) => s.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setInFront(next);
  };

  /** The new title's settings for the layout, sized from the subjects in front. */
  const newTitle = async (): Promise<{ init: PropertyInit[]; keys?: (id: string) => Command } | null> => {
    const text = (title.trim() || t('workspace.textBehind.newText', 'YOUR TITLE')).toUpperCase();
    const box = await subjectBoundsInComp(footage, playheadSeconds(), front.map((s) => s.id));
    const c = useCompositionStore.getState().comp();
    const compW = c.width || 1920;
    const compH = c.height || 1080;
    // The footage's part of the composition (a footage layer can be wider than the frame).
    const frame = { x0: Math.max(0, box?.frame.x0 ?? 0), x1: Math.min(compW, box?.frame.x1 ?? compW) };
    const fw = Math.min(compW, frame.x1 - frame.x0);
    const cx0 = box ? (box.x0 + box.x1) / 2 : compW / 2;
    const subjH = box ? box.y1 - box.y0 : compH * 0.6;
    const init: PropertyInit[] = [{ path: 'text/fontFamily', value: values.string('Anton') }];
    const at = (x: number, y: number): PropertyInit => ({ path: 'transform/position', value: { kind: 'vec2', value: { x, y } } });
    const fit = (chars: number, cap: number): number => Math.round(Math.max(40, Math.min(cap, (fw * 0.92) / (GLYPH_EM * Math.max(4, chars)))));
    // Centred on the subjects, slid back inside the footage's frame when the line would run off it.
    const centred = (size: number, chars: number): number => {
      const half = (GLYPH_EM * size * chars) / 2;
      const lo = frame.x0 + half;
      const hi = frame.x1 - half;
      return lo <= hi ? Math.min(hi, Math.max(lo, cx0)) : (frame.x0 + frame.x1) / 2;
    };
    if (layout === 'wall') {
      const row = Array.from({ length: 4 }, () => text).join('  ');
      const size = fit(row.length, compH / 5);
      // Rows at the font's own line height (1.2 em) down the whole frame.
      const lines = Math.max(3, Math.ceil(compH / (size * 1.2)));
      init.push({ path: 'text/sourceText', value: values.string(Array.from({ length: lines }, () => row).join('\n')) });
      init.push({ path: 'text/fontSize', value: values.scalar(size) });
      init.push(at((frame.x0 + frame.x1) / 2, compH / 2));
      return { init };
    }
    if (layout === 'stack') {
      const size = fit(text.length, subjH * 0.45);
      init.push({ path: 'text/sourceText', value: values.string(`${text}\n${text}`) });
      init.push({ path: 'text/fontSize', value: values.scalar(size) });
      init.push(at(centred(size, text.length), box ? box.y0 + subjH * 0.5 : compH / 2));
      return { init };
    }
    if (layout === 'marquee') {
      const line = `${text}  ·  ${text}  ·  ${text}`;
      const size = Math.round(Math.max(48, subjH * 0.32));
      const lineW = GLYPH_EM * size * line.length;
      const y = box ? box.y0 + subjH * 0.42 : compH / 2;
      init.push({ path: 'text/sourceText', value: values.string(line) });
      init.push({ path: 'text/fontSize', value: values.scalar(size) });
      // Right to left over four seconds from the playhead, its start off the right edge.
      const t0 = playheadSeconds();
      const startX = frame.x1 + lineW / 2;
      const endX = frame.x0 - lineW / 2;
      return {
        init,
        keys: (id) => ({
          type: 'addKeyframes',
          keys: [
            { prop: { layer: id, path: 'transform/position' }, time: secondsToFlicks(t0), value: { kind: 'vec2', value: { x: startX, y } } },
            { prop: { layer: id, path: 'transform/position' }, time: secondsToFlicks(t0 + 4), value: { kind: 'vec2', value: { x: endX, y } } },
          ],
        }) as Command,
      };
    }
    // Big word: cap height about a quarter of the person — a headline they stand in front of.
    const size = fit(text.length, subjH * 0.28);
    init.push({ path: 'text/sourceText', value: values.string(text) });
    init.push({ path: 'text/fontSize', value: values.scalar(size) });
    init.push(at(centred(size, text.length), box ? box.y0 + subjH * 0.38 : compH / 2));
    return { init };
  };

  const place = async (): Promise<void> => {
    if (!footage || !comp) return;
    setBusy(true);
    try {
      if (followFirst) for (const s of unfollowed) await followSubject(footage, s.id);
      let behind = texts;
      let keys: ((id: string) => Command) | undefined;
      if (behind.length === 0) {
        const made = await newTitle();
        if (!made) return;
        keys = made.keys;
        const res = await engine().execute({
          type: 'createLayer', comp, kind: 'text', name: title.trim() || t('workspace.textBehind.newName', 'Your Title'), init: made.init,
        });
        if (!res.ok) {
          useUIStore.getState().notify({ level: 'warning', message: res.error.message, durationMs: 4000 });
          return;
        }
        behind = [(res.value as { layer: string }).layer];
      }
      const all = subjects.filter((s) => !s.hidden);
      const named = front.length > 0 && front.length < all.length ? front.map((s) => s.id) : undefined;
      const out = await runPlaceBehindSubject([footage, ...behind], named ? { inFront: named } : {});
      if (!out.ok) return;
      const extra: Command[] = [];
      if (softEdge) {
        extra.push(...behind.map((id) => ({
          type: 'setProperty' as const, prop: { layer: id, path: 'layer/behindSubjectSoftness' }, value: values.scalar(SOFT_EDGE_PX),
        })));
      }
      if (keys) extra.push(...behind.map(keys));
      if (extra.length > 0) await edit(t('workspace.textBehind.finish', 'Text Behind'), extra);
      if (entrance !== 'none' && layout !== 'marquee') await applyAnimationPresetEdit(behind, entrance, playheadSeconds());
      useSelectionStore.getState().set(behind);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      id="text-behind-subject"
      title={t('workspace.textBehind.title', 'Text Behind Subject')}
      variant="floating"
      size="md"
      primaryAction={() => { void place(); }}
      footer={(
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={close}>{t('workspace.textBehind.cancel', 'Cancel')}</Button>
          <Button variant="primary" size="sm" loading={busy} disabled={!footage || front.length === 0} onClick={() => { void place(); }}>
            {t('workspace.textBehind.place', 'Place Behind')}
          </Button>
        </div>
      )}
    >
      <div className={styles.columns}>
        <div className={styles.grid}>
          <label className={styles.label} htmlFor="tb-text">{t('workspace.textBehind.text', 'Text')}</label>
          {texts.length > 0 ? (
            <span className={styles.value}>{textLabel}</span>
          ) : (
            <input id="tb-text" className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
          )}

          <label className={styles.label} htmlFor="tb-footage">{t('workspace.textBehind.footage', 'Footage')}</label>
          <select id="tb-footage" className={styles.select} value={footage} onChange={(e) => { setFootage(e.target.value); setInFront(null); }}>
            {(footages.length > 0 ? footages : [layer]).map((id) => <option key={id} value={id}>{m.layer(id)?.name ?? id}</option>)}
          </select>

          <span className={styles.label}>{t('workspace.textBehind.inFront', 'In front of it')}</span>
          <div className={styles.subjects}>
            {subjects.filter((s) => !s.hidden).map((s) => (
              <label key={s.id} className={styles.subjectChip} style={{ '--subject-color': s.color } as CSSProperties}>
                <input type="checkbox" checked={inFront ? inFront.has(s.id) : true} onChange={() => toggleFront(s.id)} />
                <span className={styles.dot} />
                {s.name}
              </label>
            ))}
            {subjects.length === 0 && <span className={styles.value}>{t('workspace.textBehind.noSubjects', 'Select a subject first')}</span>}
          </div>

          {texts.length === 0 && (
            <>
              <span className={styles.label}>{t('workspace.textBehind.layout', 'Layout')}</span>
              <div className={styles.layouts} role="radiogroup" aria-label={t('workspace.textBehind.layout', 'Layout')}>
                {LAYOUTS.map((l) => (
                  <button key={l.id} type="button" role="radio" aria-checked={layout === l.id} title={l.hint()}
                    className={layout === l.id ? styles.layoutOn : styles.layout} onClick={() => setLayout(l.id)}>
                    {l.label()}
                  </button>
                ))}
              </div>
            </>
          )}

          <label className={styles.label} htmlFor="tb-animate">{t('workspace.textBehind.animate', 'Animate')}</label>
          <select id="tb-animate" className={styles.select} value={layout === 'marquee' ? 'none' : entrance} disabled={layout === 'marquee'} onChange={(e) => setEntrance(e.target.value)}>
            {ENTRANCES.map((x) => <option key={x.id} value={x.id}>{x.label()}</option>)}
          </select>
        </div>

        <div className={styles.depth} aria-label={t('workspace.textBehind.depth', 'Depth, front to back')}>
          <span className={styles.depthTitle}>{t('workspace.textBehind.depth', 'Depth, front to back')}</span>
          {front.map((s) => (
            <span key={s.id} className={styles.depthRow} style={{ '--subject-color': s.color } as CSSProperties}><span className={styles.dot} />{s.name}</span>
          ))}
          <span className={styles.depthText}>T&nbsp;&nbsp;{textLabel}</span>
          {back.map((s) => (
            <span key={s.id} className={styles.depthRow} style={{ '--subject-color': s.color } as CSSProperties}><span className={styles.dot} />{s.name}</span>
          ))}
          <span className={styles.depthPlate}>{t('workspace.textBehind.plate', 'Background')}</span>
        </div>
      </div>
      {unfollowed.length > 0 && (
        <label className={styles.check}>
          <input type="checkbox" checked={followFirst} onChange={(e) => setFollowFirst(e.target.checked)} />
          {t('workspace.textBehind.followFirstMany', 'Follow {names} through the shot first (selected on one frame)', { names: unfollowed.map((s) => s.name).join(', ') })}
        </label>
      )}
      <label className={styles.check}>
        <input type="checkbox" checked={softEdge} onChange={(e) => setSoftEdge(e.target.checked)} />
        {t('workspace.textBehind.softEdgeLabel', 'Soft edge where they overlap')}
      </label>
    </Modal>
  );
}
