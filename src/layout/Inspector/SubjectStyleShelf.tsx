/**
 * The style gallery of Properties ▸ Subject ▸ Styles (the 2026-11-03 panel
 * redesign): kind filters and a small tile per preset, favourites first, the
 * user's saved styles with them, and a Before / After toggle on the active
 * subject's style stack.
 *
 * A tile adds its preset in one click at its remembered settings (one undo
 * entry, ordinary effects on the layer); the tune button sets intensity,
 * colour and picture first and remembers them per preset
 * (subjectStylePrefsStore, the user's, never the document). "Save as my
 * style" keeps the preset at those settings under a name of its own. A
 * picture style opens its settings instead, and adds nothing until an image
 * is chosen.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@components/Button';
import { ColorPicker } from '@components/ColorPicker';
import { Icon } from '@components/Icon';
import { Slider } from '@components/Slider';
import { cn } from '@utils/cn';
import { useSelectionStore } from '@stores/selectionStore';
import { useSubjectStylePrefsStore } from '@stores/subjectStylePrefsStore';
import { useMirrorStructRevision } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { edit } from '@core/engine/uiEdits';
import { t } from '@core/i18n';
import { IMAGE_FITS, applySubjectStyle, defaultParams, orderedPresets, presetById, type ImageFit, type StyleParams, type StyleKind, type SubjectStylePreset } from '@layout/Workspace/subjectStyles';
import { ensureSubjectTracked } from '@layout/Workspace/subjectActions';
import styles from './SubjectSection.module.css';

export interface SubjectStyleShelfProps {
  nodeId: string;
  /** The subject the styles are for (null: every subject of a one-subject layer). */
  subject: string | null;
  /** The subject to keep tracked once a style is on it. */
  activeId: string;
}

/** Before / After: the active subject's styles all off, then back as they were. */
export function BeforeAfterToggle({ nodeId, styled = [] }: {
  nodeId: string;
  /** The active subject's style effects: id and whether it is on. */
  styled?: ReadonlyArray<{ id: string; enabled: boolean }>;
}): JSX.Element | null {
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

type Filter = 'all' | 'favourites' | 'saved' | StyleKind;

function filters(): ReadonlyArray<{ id: Filter; label: string }> {
  return [
    { id: 'all', label: t('inspector.subject.filter.all', 'All') },
    { id: 'favourites', label: t('inspector.subject.filter.favourites', 'Favourites') },
    { id: 'saved', label: t('inspector.subject.filter.saved', 'My styles') },
    { id: 'outline', label: t('inspector.subject.filter.outline', 'Outline') },
    { id: 'glow', label: t('inspector.subject.filter.glow', 'Glow') },
    { id: 'shadow', label: t('inspector.subject.filter.shadow', 'Shadow') },
    { id: 'background', label: t('inspector.subject.filter.background', 'Background') },
    { id: 'look', label: t('inspector.subject.filter.look', 'Look') },
    { id: 'motion', label: t('inspector.subject.filter.motion', 'Motion') },
  ];
}

/** A small picture of what the preset does: a figure on its ground, drawn in CSS per preset. */
function StyleThumb({ preset, color }: { preset: SubjectStylePreset; color?: string }): JSX.Element {
  return (
    <span className={styles.thumb} data-kind={preset.kind} data-preset={preset.id}
      style={{ '--tile-color': color ?? preset.color ?? 'transparent' } as CSSProperties} aria-hidden="true">
      <i />
    </span>
  );
}

/** One gallery tile: a click adds the preset at its remembered settings; the star and the tune button sit on hover. */
function GalleryTile({ preset, color, name, saved, favourite, tuning, onApply, onTune, onFavourite, onRemove, onRename }: {
  preset: SubjectStylePreset;
  color?: string;
  name: string;
  saved: boolean;
  favourite: boolean;
  tuning: boolean;
  onApply: () => void;
  onTune?: () => void;
  onFavourite?: () => void;
  onRemove?: () => void;
  onRename?: () => void;
}): JSX.Element {
  return (
    <div className={cn(styles.tile, tuning && styles.tileTuning)} data-saved={saved || undefined}>
      <button type="button" className={styles.tileApply} title={`${name} · ${preset.hint()}`} onClick={onApply}
        onDoubleClick={onRename} onContextMenu={onTune ? (e) => { e.preventDefault(); onTune(); } : undefined}>
        <StyleThumb preset={preset} color={color} />
        <span className={styles.tileName}>{name}</span>
      </button>
      <span className={styles.tileTools}>
        {onTune && (
          <button type="button" className={styles.tileTool} aria-pressed={tuning}
            aria-label={t('inspector.subject.tuneStyle', 'Settings for {name}', { name })}
            title={t('inspector.subject.tuneStyleTitle', 'Set intensity and colour before adding')}
            onClick={onTune}>
            <Icon name="sliders-h" size="sm" />
          </button>
        )}
        {onFavourite && (
          <button type="button" className={cn(styles.tileTool, favourite && styles.tileToolOn)} aria-pressed={favourite}
            aria-label={favourite ? t('inspector.subject.unfavourite', 'Remove from favourites') : t('inspector.subject.favourite', 'Favourite (shown first)')}
            title={favourite ? t('inspector.subject.unfavourite', 'Remove from favourites') : t('inspector.subject.favourite', 'Favourite (shown first)')}
            onClick={onFavourite}>
            <Icon name="star" size="sm" />
          </button>
        )}
        {onRemove && (
          <button type="button" className={styles.tileTool} aria-label={t('inspector.subject.removeSaved', 'Delete saved style')} title={t('inspector.subject.removeSaved', 'Delete saved style')} onClick={onRemove}>
            <Icon name="trash" size="sm" />
          </button>
        )}
      </span>
    </div>
  );
}

/** The settings a preset is added at, opened from a tile's tune button (and always for a picture style). */
function TuneStrip({ preset, params, images, onParams, onApply, onSave, onClose }: {
  preset: SubjectStylePreset;
  params: StyleParams;
  images: ReadonlyArray<{ id: string; name: string }>;
  onParams: (p: StyleParams) => void;
  onApply: () => void;
  onSave: () => void;
  onClose: () => void;
}): JSX.Element {
  const name = preset.label();
  // A remembered image of another project is no choice here.
  const image = preset.image && images.some((i) => i.id === params.image) ? (params.image as string) : '';
  const blocked = !!preset.image && image === '';
  return (
    <div className={styles.tune} role="group" aria-label={t('inspector.subject.tuneStyle', 'Settings for {name}', { name })}>
      <div className={styles.tuneHead}>
        <StyleThumb preset={preset} color={preset.color !== undefined ? params.color : undefined} />
        <span className={styles.tileName}>{name}</span>
        <button type="button" className={styles.icon} aria-label={t('inspector.subject.tuneClose', 'Close')} title={t('inspector.subject.tuneClose', 'Close')} onClick={onClose}>
          <Icon name="close" size="sm" />
        </button>
      </div>
      {preset.intensity !== undefined && (
        <div className={styles.edgeRow}>
          <span className={styles.edgeLabel}>{t('inspector.subject.intensity', 'Intensity')}</span>
          <Slider size="sm" min={0} max={100} step={1} value={params.intensity}
            aria-label={t('inspector.subject.styleIntensity', '{name} intensity', { name })}
            onChange={(v) => onParams({ ...params, intensity: v })} />
        </div>
      )}
      {preset.color !== undefined && (
        <div className={styles.edgeRow}>
          <span className={styles.edgeLabel}>{t('inspector.subject.colour', 'Colour')}</span>
          <ColorPicker compact alpha={false} value={params.color} aria-label={t('inspector.subject.styleColour', '{name} colour', { name })}
            onChange={(hex) => onParams({ ...params, color: hex })} />
        </div>
      )}
      {preset.image && (
        <>
          <div className={styles.edgeRow}>
            <span className={styles.edgeLabel}>{t('inspector.subject.image', 'Image')}</span>
            <select className={styles.tileSelect} value={image} aria-label={t('inspector.subject.styleImage', '{name} image', { name })}
              onChange={(e) => onParams({ ...params, image: e.currentTarget.value })}>
              <option value="">{images.length > 0 ? t('inspector.subject.chooseImage', 'Choose an image…') : t('inspector.subject.noImages', 'No images in the project')}</option>
              {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className={styles.edgeRow}>
            <span className={styles.edgeLabel}>{t('inspector.subject.fit', 'Fit')}</span>
            <select className={styles.tileSelect} value={params.fit ?? 'fill'} aria-label={t('inspector.subject.styleFit', '{name} fit', { name })}
              onChange={(e) => onParams({ ...params, fit: e.currentTarget.value as ImageFit })}>
              {IMAGE_FITS.map((f) => <option key={f.id} value={f.id}>{f.label()}</option>)}
            </select>
          </div>
        </>
      )}
      <div className={styles.trackRow}>
        <button type="button" className={styles.primary} disabled={blocked}
          title={blocked ? t('inspector.subject.chooseImageFirst', 'Choose an image first') : undefined} onClick={onApply}>
          {t('inspector.subject.addStyleNow', 'Add')}
        </button>
        <Button size="sm" variant="ghost" title={t('inspector.subject.saveStyleTitle', 'Keep this preset at these settings as a style of your own')} onClick={onSave}>
          {t('inspector.subject.saveStyle', 'Save as my style')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The style gallery: kind filters, then a tile per preset (favourites first)
 * or per saved style. One click adds at the remembered settings; the tune
 * button opens the settings first. What is added is then tuned in the applied
 * list above, through the effects' own parameters.
 */
export function SubjectStyleShelf({ nodeId, subject = null, activeId = '' }: SubjectStyleShelfProps): JSX.Element {
  const favourites = useSubjectStylePrefsStore((s) => s.favourites);
  const stored = useSubjectStylePrefsStore((s) => s.params);
  const saved = useSubjectStylePrefsStore((s) => s.saved);
  const [filter, setFilter] = useState<Filter>('all');
  const [tuning, setTuning] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const prefs = useSubjectStylePrefsStore.getState();
  const images = useProjectImages();
  const paramsOf = (p: SubjectStylePreset): StyleParams => stored[p.id] ?? defaultParams(p);

  const apply = (preset: SubjectStylePreset, params: StyleParams): void => {
    useSelectionStore.getState().set([nodeId]);
    void applySubjectStyle(nodeId, subject, preset, params).then((ok) => { if (ok) void ensureSubjectTracked(nodeId, activeId); });
  };
  // A picture style cannot be added without its picture: its click opens the settings.
  const click = (p: SubjectStylePreset): void => {
    const params = paramsOf(p);
    if (p.image && !images.some((i) => i.id === params.image)) setTuning(p.id);
    else apply(p, params);
  };
  const shown = filter === 'saved' ? [] : orderedPresets(favourites).filter((p) =>
    filter === 'all' || (filter === 'favourites' ? favourites.includes(p.id) : p.kind === filter));
  const visibleFilters = filters().filter((f) => (f.id !== 'saved' || saved.length > 0) && (f.id !== 'favourites' || favourites.length > 0));
  const tuned = tuning ? presetById(tuning) : undefined;

  return (
    <div className={styles.gallery}>
      <div className={styles.filters} role="tablist" aria-label={t('inspector.subject.filterLabel', 'Style kinds')}>
        {visibleFilters.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id}
            className={cn(styles.filter, filter === f.id && styles.filterOn)} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className={styles.tiles} role="group" aria-label={filter === 'saved' ? t('inspector.subject.savedStyles', 'My styles') : t('inspector.subject.presets', 'Style presets')}>
        {(filter === 'all' || filter === 'saved') && saved.map((s) => {
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
            <GalleryTile key={s.id} preset={preset} color={preset.color !== undefined ? s.params.color : undefined} name={s.name} saved favourite={false}
              tuning={false} onApply={() => apply(preset, s.params)} onRemove={() => prefs.removeSaved(s.id)} onRename={() => setRenaming(s.id)} />
          );
        })}
        {shown.map((p) => (
          <GalleryTile
            key={p.id}
            preset={p}
            color={p.color !== undefined ? paramsOf(p).color : undefined}
            name={p.label()}
            saved={false}
            favourite={favourites.includes(p.id)}
            tuning={tuning === p.id}
            onApply={() => click(p)}
            onTune={() => setTuning(tuning === p.id ? null : p.id)}
            onFavourite={() => prefs.toggleFavourite(p.id)}
          />
        ))}
      </div>
      {tuned && (
        <TuneStrip
          preset={tuned}
          params={paramsOf(tuned)}
          images={images}
          onParams={(params) => prefs.setParams(tuned.id, params)}
          onApply={() => { apply(tuned, paramsOf(tuned)); setTuning(null); }}
          onSave={() => {
            const params = paramsOf(tuned);
            const style = prefs.saveStyle(t('inspector.subject.savedName', '{name} {n}%', { name: tuned.label(), n: params.intensity }), tuned.id, params);
            setFilter('saved');
            setRenaming(style.id);
          }}
          onClose={() => setTuning(null)}
        />
      )}
    </div>
  );
}
