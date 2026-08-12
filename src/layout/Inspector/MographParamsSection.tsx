/**
 * The "fill in the blanks" surface for an INSERTED motion-graphics element.
 *
 * A Motion GFX card drops a finished element into the comp and, until now, left
 * its content unreachable: "Name Surname" and "Title / Role" could only be
 * changed by expanding the group in the Layers panel, picking the right child,
 * and knowing which of its props was the safe one. The element was a template
 * with no field list.
 *
 * Shown whenever the selection is inside an inserted element — including when
 * the user clicked a child on canvas, which is where selection actually lands.
 * Fields are derived from the subtree (see `mographParams`), so a preset added
 * to the catalog later gets its blanks for free.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ColorPicker } from '@components/ColorPicker';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { writeTemplateField } from '@core/template/templateFields';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { findMographRoot, mographIdOf, readMographFields } from '@core/library/mographParams';
import { getMographItem, mographDuration, mographRestTime } from '@core/library/mographLibrary';
import { previewChoreography } from '@core/library/insertPreview';
import type { TemplateField } from '@core/template/templateTypes';
import styles from './MographParamsSection.module.css';

export function MographParamsSection(): JSX.Element | null {
  const selected = useSelectionStore((s) => s.ids);
  // Field values live in the SCENE, not in a store — re-read them whenever the
  // scene changes so an edit made anywhere else (canvas, layers, AI) shows here.
  const revision = useSceneRevision();
  const primary = selected[0] ?? null;

  // `revision` is a real dependency even though neither call takes it: both read
  // the live SceneGraph, so the answer changes when the scene does and the memo
  // has to be invalidated by the revision counter. eslint can only see the
  // arguments, hence the disable.
  /* eslint-disable react-hooks/exhaustive-deps */
  const root = useMemo(() => findMographRoot(primary), [primary, revision]);
  const fields = useMemo(() => (root ? readMographFields(root) : []), [root, revision]);
  /* eslint-enable react-hooks/exhaustive-deps */

  if (!root || fields.length === 0) return null;

  const itemId = mographIdOf(root);
  const item = itemId ? getMographItem(itemId) : null;
  const name = defaultSceneGraph.getNode(root)?.name ?? item?.name ?? 'Motion graphic';

  // Replay the element's own choreography from wherever it was written. The
  // keyframes carry that start time; the item carries the length.
  const replay = (): void => {
    if (!item) return;
    const from = elementStart(root);
    const span = item.loop ? item.previewSeconds ?? 4 : mographDuration(item);
    previewChoreography({ from, to: from + span, restAt: from + mographRestTime(item) });
  };

  const groups = new Map<string, TemplateField[]>();
  for (const f of fields) {
    const key = f.group ?? 'Fields';
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <span className={styles.title}>{name}</span>
          <span className={styles.subtitle}>{item ? `${item.cat} · motion graphic` : 'motion graphic'}</span>
        </div>
        {item && (
          <Button variant="ghost" size="sm" leftIcon={<Icon name="play" size="sm" />} onClick={replay}>
            Replay
          </Button>
        )}
      </div>

      {[...groups.entries()].map(([group, groupFields]) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupLabel}>{group}</div>
          {groupFields.map((f) => (
            <FieldRow key={f.id} field={f} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Earliest keyframe time (seconds) anywhere in the element — where its
 *  choreography was written. Falls back to 0 for an element with no tracks. */
function elementStart(rootId: string): number {
  let earliest = Number.POSITIVE_INFINITY;
  const walk = (id: string): void => {
    const span = defaultAnimation.timeSpan(id);
    if (span && span.start < earliest) earliest = span.start;
    for (const child of defaultSceneGraph.getNode(id)?.children ?? []) {
      walk(typeof child === 'string' ? child : (child as { id: string }).id);
    }
  };
  walk(rootId);
  return Number.isFinite(earliest) ? earliest : 0;
}

/** Current value of a field, read from the scene rather than remembered — this
 *  panel has no store of its own, and the scene is the authority. */
function currentValue(field: TemplateField): string {
  const node = defaultSceneGraph.getNode(field.target.nodeId);
  const comp = node?.components.find((c) => c.type === field.target.componentType);
  const v = comp ? (comp.props as Record<string, unknown>)[field.target.prop] : undefined;
  return v === undefined || v === null ? String(field.default ?? '') : String(v);
}

function FieldRow({ field }: { field: TemplateField }): JSX.Element {
  useSceneRevision(); // re-read after any scene write
  const value = currentValue(field);

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{field.label}</span>
      {field.kind === 'color' ? (
        <ColorPicker
          value={value || '#ffffff'}
          onChange={(hex) => writeTemplateField(field, hex)}
          aria-label={field.label}
        />
      ) : (
        <Input
          value={value}
          size="sm"
          onChange={(e) => writeTemplateField(field, e.target.value)}
          aria-label={field.label}
        />
      )}
    </label>
  );
}
