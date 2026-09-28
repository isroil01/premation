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

import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ColorPicker } from '@components/ColorPicker';
import { flicksToSeconds, secondsToFlicks, type Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { childOrderOf } from '@core/mirror/layerTree';
import {
  mirrorMographFieldValue, mirrorMographFields, mirrorMographRoot, mographPartIds, mographWatchKeys,
} from '@core/mirror/mographFields';
import { useMirrorKeys, useRetainTrees } from '@hooks/useMirror';
import { getTime } from '@stores/playbackClockStore';
import { useGesture } from '@hooks/useGesture';
import { templateFieldCommands as fieldCommandsAt } from '@layout/Templates/templateFieldEdits';
import { useEngineEdit } from './useEngineEdit';
import { useSelectionStore } from '@stores/selectionStore';
import { getMographItem, mographDuration, mographRestTime } from '@core/library/mographLibrary';
import { previewChoreography } from '@core/library/insertPreview';
import type { TemplateField } from '@core/template/templateTypes';
import styles from './MographParamsSection.module.css';

const NO_PARTS: string[] = [];

export function MographParamsSection(): JSX.Element | null {
  const selected = useSelectionStore((s) => s.ids);
  // B4: everything from the document mirror — which group is an inserted
  // element (`LayerInfo.mographId`, up the parent chain), its parts, and each
  // part's Source Text / Fill Color (mographFields.ts). Subscribed to exactly
  // those keys, so an edit made anywhere else (canvas, layers, AI) shows here.
  const primary = selected[0] ?? null;
  const m = documentMirror();
  useMirrorKeys(mographWatchKeys(m, primary));
  const root = mirrorMographRoot(m, primary);
  useRetainTrees(root ? mographPartIds(m, root) : NO_PARTS);
  const fields = mirrorMographFields(m, root);

  if (!root || fields.length === 0) return null;

  const itemId = documentMirror().layer(root)?.mographId || null;
  const item = itemId ? getMographItem(itemId) : null;
  const name = documentMirror().layer(root)?.name ?? item?.name ?? 'Motion graphic';

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
  // The document mirror at call time: every keyframe of the element's layers (comp time).
  const m = documentMirror();
  let earliest = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const keys of m.layerKeyframes(id).values()) {
      for (const k of keys) earliest = Math.min(earliest, flicksToSeconds(k.time));
    }
    for (const child of childOrderOf(m, id)) walk(child);
  };
  walk(rootId);
  return Number.isFinite(earliest) ? earliest : 0;
}

/**
 * The engine commands for "field := value" at the playhead — the fill-in
 * panel's writer: a text part is the child layer's Source Text
 * (`text/sourceText`, style runs kept), a colour its Fill Color (`layer/fill`;
 * a key at the playhead when the fill is animated, AE). [] when the child is
 * not an addressable layer.
 */
function templateFieldCommands(field: TemplateField, value: string): Command[] {
  return fieldCommandsAt(field, value, getTime()) ?? [];
}

/**
 * A field's current value — re-read on every render (the section re-renders
 * its rows on each part's mirror keys). Text is the part's Source Text from the
 * mirror (a field exists only for un-keyed text, so no playhead is involved).
 */
function currentValue(field: TemplateField): string {
  // B4 round 5: a colour part's Fill Color (`layer/fill`) — both engines parse the catalog's CSS
  // `rgba(r,g,b,a)` fills into the colour value (it shows as `#rrggbbaa`).
  return mirrorMographFieldValue(documentMirror(), field, secondsToFlicks(getTime()));
}

function FieldRow({ field }: { field: TemplateField }): JSX.Element {
  const value = currentValue(field);
  const eng = useEngineEdit();
  // A typing session (first keystroke → blur) is ONE undo entry; the canvas
  // follows every keystroke.
  const typing = useGesture();
  const label = `Edit ${field.label}`;

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{field.label}</span>
      {field.kind === 'color' ? (
        <span style={{ display: 'contents' }} {...eng.press(label)}>
          <ColorPicker
            value={value || '#ffffff'}
            onChange={(hex) => eng.send(label, templateFieldCommands(field, hex))}
            aria-label={field.label}
          />
        </span>
      ) : (
        <Input
          value={value}
          size="sm"
          onChange={(e) => {
            const cmds = templateFieldCommands(field, e.target.value);
            if (cmds.length === 0) return;
            if (!typing.isActive()) typing.begin(label);
            typing.send(cmds);
          }}
          onBlur={() => { void typing.end(); }}
          aria-label={field.label}
        />
      )}
    </label>
  );
}
