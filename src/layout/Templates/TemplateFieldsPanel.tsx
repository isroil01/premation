/**
 * TemplateFieldsPanel — the strict "fill-in-the-blanks" surface. When no
 * template is loaded it shows the gallery; once one is applied it shows ONLY
 * that template's exposed fields (text / colour / number), grouped. Editing a
 * field writes straight through the scene graph via the template store, so the
 * design and animation stay locked and only the data changes.
 *
 * Gallery cards animate continuously through the shared preview controller (one
 * capped rAF loop, off-screen cards paused), rendering the REAL snapshot so a
 * card shows exactly what applying/inserting produces.
 */

import { useEffect, useMemo, useRef, type ChangeEvent } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { customConfirm } from '@components/Modal';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { TEMPLATES } from '@core/template/registry';
import { templateThumbnail, createTemplatePlayer } from '@core/template/templatePreview';
import { ANIM_PRESETS, insertAnimPreset, animPresetThumbnail, createAnimPresetPlayer, type AnimPreset } from '@core/template/animPresets';
import type { TemplateDefinition, TemplateField } from '@core/template/templateTypes';
import {
  readAuthoredFields, exposeNodeAsField, removeAuthoredField, renameAuthoredField,
} from '@core/template/templateAuthoring';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { useTemplateStore } from '@stores/templateStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import styles from './TemplateFieldsPanel.module.css';

export function TemplateFieldsPanel(): JSX.Element {
  const active = useTemplateStore((s) => s.active);
  return active ? <ActiveTemplateFields /> : <TemplateGallery />;
}

function TemplateGallery(): JSX.Element {
  const apply = useTemplateStore((s) => s.apply);

  // Applying a template REPLACES the current composition. Confirm first when
  // there's real work in the scene (more than a lone root node) so a stray click
  // can't wipe it.
  const pick = async (id: string): Promise<void> => {
    if (defaultSceneGraph.size > 1) {
      const ok = await customConfirm(
        'Apply template?',
        'This replaces everything in the current composition and cannot be undone.',
        { confirmLabel: 'Apply', isDanger: true },
      );
      if (!ok) return;
    }
    apply(id);
  };

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.groupLabel}>Animated presets</span>
        </div>
        <p className={styles.introText}>
          Click to add at centre, or drag onto the canvas — then just edit the text.
        </p>
        <div className={styles.presetGrid}>
          {ANIM_PRESETS.map((p) => (
            <AnimPresetCard key={p.id} preset={p} />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.groupLabel}>Full-scene templates</span>
        </div>
        <p className={styles.introText}>Replaces the whole composition with an editable, animated scene.</p>
        <div className={styles.gallery}>
          {TEMPLATES.map((t) => (
            <TemplateCard key={t.id} template={t} onPick={() => void pick(t.id)} />
          ))}
        </div>
      </section>

      <AuthoringSection />
    </div>
  );
}

/** A drop-in animated element — full-bleed live preview that loops; click to add
 *  at centre / drag to place at the drop point. */
function AnimPresetCard({ preset }: { preset: AnimPreset }): JSX.Element {
  const poster = useMemo(() => animPresetThumbnail(preset), [preset]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const player = createAnimPresetPlayer(canvas, preset);
    return () => player.stop();
  }, [preset]);

  return (
    <button
      type="button"
      className={styles.presetCard}
      title={`${preset.name} — click to add, drag to place`}
      draggable
      onDragStart={(e) => setCanvasDrag(e, { kind: 'animPreset', presetId: preset.id })}
      onClick={() => insertAnimPreset(preset.id)}
    >
      <span className={styles.previewFrame} data-aspect="16:9">
        {poster && <img className={styles.poster} src={poster} alt="" aria-hidden />}
        <canvas ref={canvasRef} className={styles.previewCanvas} aria-hidden />
        <span className={styles.addBadge} aria-hidden><Icon name="plus" size={13} /></span>
      </span>
      <span className={styles.cardLabel}>{preset.name}</span>
    </button>
  );
}

/** One scene-template card — full-bleed looping preview of the real scene. */
function TemplateCard({ template, onPick }: { template: TemplateDefinition; onPick: () => void }): JSX.Element {
  const poster = useMemo(() => templateThumbnail(template), [template]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const player = createTemplatePlayer(canvas, template);
    return () => player.stop();
  }, [template]);

  return (
    <button type="button" className={styles.card} title={template.name} onClick={onPick}>
      <span className={styles.previewFrame} data-aspect={template.aspect}>
        {poster && <img className={styles.poster} src={poster} alt="" aria-hidden />}
        <canvas ref={canvasRef} className={styles.previewCanvas} aria-hidden />
      </span>
      <span className={styles.cardMeta}>
        <span className={styles.cardLabel}>{template.name}</span>
        {template.aspect && <span className={styles.aspectBadge}>{template.aspect}</span>}
      </span>
    </button>
  );
}

/** "Make this composition a template" — expose selected layers as fields. */
function AuthoringSection(): JSX.Element {
  useSceneRevision(); // re-read the authored manifest after any scene change
  const selectedId = useSelectionStore((s) => s.ids[0]);
  const previewAuthored = useTemplateStore((s) => s.previewAuthored);
  const fields = readAuthoredFields();

  const exposeSelected = (): void => {
    if (!selectedId) return;
    exposeNodeAsField(selectedId);
  };

  return (
    <div className={styles.authoring}>
      <div className={styles.groupLabel}>Make this a template</div>
      <div className={styles.introText}>
        Select a text, image or shape layer and expose it as an editable field.
      </div>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Icon name="plus" size={12} />}
        onClick={exposeSelected}
        disabled={!selectedId}
      >
        {selectedId ? 'Expose selected layer' : 'Select a layer first'}
      </Button>

      {fields.length > 0 && (
        <>
          <div className={styles.authoredList}>
            {fields.map((f) => (
              <div key={f.id} className={styles.authoredRow}>
                <Input
                  value={f.label}
                  onChange={(e) => renameAuthoredField(f.id, e.target.value)}
                  aria-label="Field label"
                />
                <span className={styles.kindBadge}>{f.kind}</span>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title="Remove field"
                  onClick={() => removeAuthoredField(f.id)}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
          <Button variant="primary" size="sm" onClick={previewAuthored}>
            Preview fill-in ({fields.length})
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The exposed fields of the applied template.
 *
 * Exported so the inspector can host it. The whole `TemplateFieldsPanel` was
 * only reachable through a renderer id that was never registered — a built
 * MOGRT-style field editor with no way in — and its other half (the gallery)
 * duplicates the Library panel's Templates section, so surfacing THIS half is
 * the part that adds something.
 */
export function ActiveTemplateFields(): JSX.Element {
  const active = useTemplateStore((s) => s.active)!;
  const exit = useTemplateStore((s) => s.exit);

  // Group fields by their `group` label, preserving first-seen order.
  const groups = useMemo(() => {
    const map = new Map<string, TemplateField[]>();
    for (const f of active.fields) {
      const key = f.group ?? 'Fields';
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [active]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <div className={styles.templateName}>{active.name}</div>
          <div className={styles.templateHint}>Editing template content</div>
        </div>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="grid" size={12} />} onClick={exit}>
          Change
        </Button>
      </div>

      {groups.map(([group, fields]) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupLabel}>{group}</div>
          {fields.map((f) => (
            <FieldRow key={f.id} field={f} />
          ))}
        </div>
      ))}
    </div>
  );
}

function FieldRow({ field }: { field: TemplateField }): JSX.Element {
  const value = useTemplateStore((s) => s.values[field.id]);
  const setField = useTemplateStore((s) => s.setField);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImage = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    // A blob URL renders immediately with no CSP issues. (Note: object URLs are
    // session-scoped — a saved project would need the asset re-imported.)
    setField(field.id, URL.createObjectURL(file));
    e.target.value = ''; // allow re-picking the same file
  };

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{field.label}</span>
      {field.kind === 'text' && (
        <Input
          value={String(value ?? '')}
          onChange={(e) => setField(field.id, e.target.value)}
          aria-label={field.label}
        />
      )}
      {field.kind === 'color' && (
        <ColorPicker
          value={String(value ?? '#000000')}
          onChange={(hex) => setField(field.id, hex)}
          className={styles.colorTrigger}
          aria-label={field.label}
        />
      )}
      {field.kind === 'number' && (
        <ValueField
          value={Number(value ?? 0)}
          onChange={(v) => setField(field.id, v)}
          aria-label={field.label}
        />
      )}
      {field.kind === 'image' && (
        <div className={styles.imageField}>
          <span className={styles.imageThumb} aria-hidden>
            {value ? <img src={String(value)} alt="" /> : <Icon name="media" size={16} />}
          </span>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="media" size={12} />}
            onClick={() => fileRef.current?.click()}
          >
            {value ? 'Replace image' : 'Choose image'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onPickImage}
            aria-label={field.label}
          />
        </div>
      )}
    </label>
  );
}
