/**
 * The style shelf of Properties ▸ Subjects (the approved Subjects Pro design,
 * board 2): every preset as a tile with its intensity slider and colour
 * swatch, favourites first, the user's saved styles above them, and a
 * Before / After toggle on the active subject's style stack.
 *
 * A tile applies its preset at the slider / swatch as set (one undo entry,
 * ordinary effects on the layer); the settings are remembered per preset
 * (subjectStylePrefsStore, the user's, never the document). "Save" keeps the
 * preset at those settings under a name of its own. A tile that shows a picture
 * also picks a project image and its fit, and adds nothing until one is chosen.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ColorPicker } from '@components/ColorPicker';
import { Icon } from '@components/Icon';
import { Slider } from '@components/Slider';
import { useSelectionStore } from '@stores/selectionStore';
import { useSubjectStylePrefsStore } from '@stores/subjectStylePrefsStore';
import { useMirrorStructRevision } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { edit } from '@core/engine/uiEdits';
import { t } from '@core/i18n';
import { IMAGE_FITS, applySubjectStyle, defaultParams, orderedPresets, presetById, type ImageFit, type StyleParams, type SubjectStylePreset } from '@layout/Workspace/subjectStyles';
import { ensureSubjectTracked } from '@layout/Workspace/subjectActions';
import styles from './SubjectSection.module.css';

export interface SubjectStyleShelfProps {
  nodeId: string;
  /** The subject the styles are for (null: every subject of a one-subject layer). */
  subject: string | null;
  /** The subject to keep tracked once a style is on it. */
  activeId: string;
  /** The active subject's style effects, for Before / After: id and whether it is on. */
  styled: ReadonlyArray<{ id: string; enabled: boolean }>;
}

/** Before / After: the active subject's styles all off, then back as they were. */
export function BeforeAfterToggle({ nodeId, styled = [] }: Pick<SubjectStyleShelfProps, 'nodeId' | 'styled'>): JSX.Element | null {
  const [off, setOff] = useState<string[] | null>(null);
  const offRef = useRef<string[] | null>(null);
  offRef.current = off;
  const groups = (ids: readonly string[]) => ids.map((id) => ({ layer: nodeId, path: `effects/${id}` }));
  const restore = (): void => {
    const ids = offRef.current;
    if (!ids || ids.length === 0) return;
    void edit(t('inspector.subject.afterLabel', 'Styles On'), { type: 'setGroupEnabled', groups: groups(ids), enabled: true });
  };
  // Leaving the panel (another layer, another subject) puts the styles back.
  useEffect(() => () => restore(), [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps -- restore reads the ref
  if (styled.length === 0) return null;
  return (
    <button
      type="button"
      className={off ? styles.beforeOn : styles.before}
      aria-pressed={!!off}
      title={off ? t('inspector.subject.afterTitle', 'Show the styles again') : t('inspector.subject.beforeTitle', 'See the picture without this subject’s styles (they stay on the layer)')}
      onClick={() => {
        if (off) {
          restore();
          setOff(null);
          return;
        }
        const ids = styled.filter((e) => e.enabled).map((e) => e.id);
        if (ids.length === 0) return;
        void edit(t('inspector.subject.beforeLabel', 'Styles Off'), { type: 'setGroupEnabled', groups: groups(ids), enabled: false });
        setOff(ids);
      }}
    >
      {off ? t('inspector.subject.after', 'After') : t('inspector.subject.before', 'Before')}
    </button>
  );
}

/** The project's images, for a tile that shows one. */
function useProjectImages(): Array<{ id: string; name: string }> {
  useMirrorStructRevision(true); // the item list
  return [...documentMirror().items.values()]
    .filter((i) => i.kind === 'footage' && i.mediaType === 'image' && !i.missing)
    .map((i) => ({ id: i.id, name: i.name }));
}

function StyleTile({ preset, params, name, saved, favourite, images, onParams, onApply, onFavourite, onSave, onRemove }: {
  preset: SubjectStylePreset;
  params: StyleParams;
  name: string;
  saved: boolean;
  favourite: boolean;
  images: ReadonlyArray<{ id: string; name: string }>;
  onParams: (p: StyleParams) => void;
  onApply: () => void;
  onFavourite?: () => void;
  onSave?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const hasIntensity = preset.intensity !== undefined;
  const hasColor = preset.color !== undefined;
  // A remembered image of another project is no choice here.
  const image = preset.image && images.some((i) => i.id === params.image) ? (params.image as string) : '';
  const blocked = !!preset.image && image === '';
  return (
    <div className={styles.tile} data-kind={preset.kind} data-saved={saved || undefined} style={{ '--tile-color': hasColor ? params.color : undefined } as CSSProperties}>
      <div className={styles.tileHead}>
        <button type="button" className={styles.tileApply} title={blocked ? t('inspector.subject.chooseImageFirst', 'Choose an image first') : preset.hint()} disabled={blocked} onClick={onApply}>
          <span className={styles.presetSwatch} aria-hidden="true" />
          <span className={styles.tileName}>{name}</span>
        </button>
        {hasColor && (
          <ColorPicker compact alpha={false} value={params.color} aria-label={t('inspector.subject.styleColour', '{name} colour', { name })}
            onChange={(hex) => onParams({ ...params, color: hex })} />
        )}
        {onFavourite && (
          <button type="button" className={favourite ? styles.tileStarOn : styles.tileStar} aria-pressed={favourite}
            aria-label={favourite ? t('inspector.subject.unfavourite', 'Remove from favourites') : t('inspector.subject.favourite', 'Favourite (shown first)')}
            title={favourite ? t('inspector.subject.unfavourite', 'Remove from favourites') : t('inspector.subject.favourite', 'Favourite (shown first)')}
            onClick={onFavourite}>
            <Icon name="star" size={12} />
          </button>
        )}
        {onSave && (
          <button type="button" className={styles.icon} aria-label={t('inspector.subject.saveStyle', 'Save as my style')} title={t('inspector.subject.saveStyleTitle', 'Keep this preset at these settings as a style of your own')} onClick={onSave}>
            <Icon name="plus" size={12} />
          </button>
        )}
        {onRemove && (
          <button type="button" className={styles.icon} aria-label={t('inspector.subject.removeSaved', 'Delete saved style')} title={t('inspector.subject.removeSaved', 'Delete saved style')} onClick={onRemove}>
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
      {preset.image && (
        <div className={styles.tileImage}>
          <select className={styles.tileSelect} value={image} disabled={saved} aria-label={t('inspector.subject.styleImage', '{name} image', { name })}
            onChange={(e) => onParams({ ...params, image: e.currentTarget.value })}>
            <option value="">{images.length > 0 ? t('inspector.subject.chooseImage', 'Choose an image…') : t('inspector.subject.noImages', 'No images in the project')}</option>
            {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select className={styles.tileSelect} value={params.fit ?? 'fill'} disabled={saved} aria-label={t('inspector.subject.styleFit', '{name} fit', { name })}
            onChange={(e) => onParams({ ...params, fit: e.currentTarget.value as ImageFit })}>
            {IMAGE_FITS.map((f) => <option key={f.id} value={f.id}>{f.label()}</option>)}
          </select>
        </div>
      )}
      {hasIntensity && (
        <Slider
          size="sm"
          min={0}
          max={100}
          step={1}
          value={params.intensity}
          aria-label={t('inspector.subject.styleIntensity', '{name} intensity', { name })}
          onChange={(v) => onParams({ ...params, intensity: v })}
        />
      )}
    </div>
  );
}

export function SubjectStyleShelf({ nodeId, subject = null, activeId = '', styled = [] }: SubjectStyleShelfProps): JSX.Element {
  const favourites = useSubjectStylePrefsStore((s) => s.favourites);
  const stored = useSubjectStylePrefsStore((s) => s.params);
  const saved = useSubjectStylePrefsStore((s) => s.saved);
  const [renaming, setRenaming] = useState<string | null>(null);
  const prefs = useSubjectStylePrefsStore.getState();
  const images = useProjectImages();
  const paramsOf = (p: SubjectStylePreset): StyleParams => stored[p.id] ?? defaultParams(p);

  const apply = (preset: SubjectStylePreset, params: StyleParams): void => {
    useSelectionStore.getState().set([nodeId]);
    void applySubjectStyle(nodeId, subject, preset, params).then((ok) => { if (ok) void ensureSubjectTracked(nodeId, activeId); });
  };

  return (
    <>
      <div className={styles.shelfHead}>
        <span className={styles.meta}>{t('inspector.subject.shelfHint', 'Click a tile to add it · slider and swatch set it first')}</span>
        <BeforeAfterToggle nodeId={nodeId} styled={styled} />
      </div>
      {saved.length > 0 && (
        <div className={styles.presets} role="group" aria-label={t('inspector.subject.savedStyles', 'My styles')}>
          {saved.map((s) => {
            const preset = presetById(s.preset);
            if (!preset) return null;
            return renaming === s.id ? (
              <input
                key={s.id}
                className={styles.nameInput}
                defaultValue={s.name}
                autoFocus
                aria-label={t('inspector.subject.renameStyle', 'Rename style')}
                onBlur={(e) => { setRenaming(null); prefs.renameSaved(s.id, e.currentTarget.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <div key={s.id} onDoubleClick={() => setRenaming(s.id)}>
                <StyleTile
                  preset={preset}
                  params={s.params}
                  name={s.name}
                  saved
                  favourite={false}
                  images={images}
                  onParams={() => { /* a saved style keeps its settings; save another from the preset */ }}
                  onApply={() => apply(preset, s.params)}
                  onRemove={() => prefs.removeSaved(s.id)}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.presets} role="group" aria-label={t('inspector.subject.presets', 'Style presets')}>
        {orderedPresets(favourites).map((p) => (
          <StyleTile
            key={p.id}
            preset={p}
            params={paramsOf(p)}
            name={p.label()}
            saved={false}
            favourite={favourites.includes(p.id)}
            images={images}
            onParams={(params) => prefs.setParams(p.id, params)}
            onApply={() => apply(p, paramsOf(p))}
            onFavourite={() => prefs.toggleFavourite(p.id)}
            onSave={() => {
              const params = paramsOf(p);
              const style = prefs.saveStyle(t('inspector.subject.savedName', '{name} {n}%', { name: p.label(), n: params.intensity }), p.id, params);
              setRenaming(style.id);
            }}
          />
        ))}
      </div>
    </>
  );
}
