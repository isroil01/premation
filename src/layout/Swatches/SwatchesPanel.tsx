/**
 * SwatchesPanel — the project palette at full size.
 *
 * The ColorPicker popover carries the same two lists, and deliberately so: one
 * is for reaching a colour while you are already editing one, this one is for
 * MANAGING the palette (naming, ordering, pruning) and for pushing a colour
 * onto a selection without opening a picker at all. Both read the same store,
 * so a rename here is visible in every picker in the app on the next render —
 * there is one palette, shown twice, not two palettes to keep in sync.
 *
 * Reordering is up/down buttons rather than drag-and-drop. A palette is
 * reordered rarely and by a few positions; buttons are keyboard-reachable,
 * need no pointer precision, and cost none of the drag machinery a swatch grid
 * would otherwise pull in.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import { useSwatchStore } from '@stores/swatchStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { batchHistory } from '@stores/historyStore';
import { setNodeFill, solidFill } from '@core/paint/fill';
import styles from './SwatchesPanel.module.css';

/**
 * Paint every selected layer with `hex`.
 *
 * Routed through `setNodeFill` — the same write the Appearance section's fill
 * ColorPicker uses — rather than touching the graph directly, because that
 * function is what keeps the fill STACK and the legacy single-fill slot
 * agreeing with each other. Writing `fx.props.fill` here would paint the layer
 * and leave a multi-fill layer's stack showing the old colour.
 *
 * One `batchHistory` group so painting eight layers is one undo, not eight.
 *
 * A gradient-filled layer becomes solid. There is no unambiguous "set the
 * colour of a gradient" — which stop? — so the honest reading of "apply this
 * swatch" is the one the user can see happen and undo.
 */
function applyToSelection(ids: readonly string[], hex: string): void {
  batchHistory(`swatch:apply:${hex}`, () => {
    for (const id of ids) setNodeFill(id, solidFill(hex));
  });
}

export function SwatchesPanel(): JSX.Element {
  const swatches = useSwatchStore((s) => s.swatches);
  const documentColors = useSwatchStore((s) => s.documentColors);
  const addSwatch = useSwatchStore((s) => s.addSwatch);
  const renameSwatch = useSwatchStore((s) => s.renameSwatch);
  const removeSwatch = useSwatchStore((s) => s.removeSwatch);
  const moveSwatch = useSwatchStore((s) => s.moveSwatch);
  const refreshDocumentColors = useSwatchStore((s) => s.refreshDocumentColors);

  const selectedIds = useSelectionStore((s) => s.ids);
  const sceneRevision = useSceneRevision((s) => s.rev);

  const [draft, setDraft] = useState('#5282b8');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  /**
   * Document colours are derived, so something has to decide WHEN. The scene
   * revision is that trigger: it bumps on a paint edit, an add or a delete —
   * exactly the events that can change the answer — and not on playback, which
   * is what a per-frame derivation would have cost.
   */
  useEffect(() => {
    refreshDocumentColors();
  }, [refreshDocumentColors, sceneRevision]);

  const commitRename = useCallback(() => {
    if (editingId) renameSwatch(editingId, draftName);
    setEditingId(null);
  }, [editingId, draftName, renameSwatch]);

  const canApply = selectedIds.length > 0;

  return (
    <div className={styles.panelRoot}>
      <div className={styles.addRow}>
        <ColorPicker value={draft} onChange={setDraft} aria-label="New swatch color" />
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => {
            const added = addSwatch(draft);
            if (added) {
              setEditingId(added.id);
              setDraftName(added.name);
            }
          }}
          title="Add this color to the project palette"
        >
          <Icon name="plus" size="sm" />
          <span>Add</span>
        </button>
      </div>

      <div className={styles.sectionLabel}>Project Swatches</div>

      {swatches.length === 0 ? (
        <p className={styles.empty}>
          No swatches yet. Pick a color above and press Add, or promote one of the document colors below.
        </p>
      ) : (
        <ul className={styles.list}>
          {swatches.map((sw, i) => (
            <li key={sw.id} className={styles.row}>
              <button
                type="button"
                className={styles.rowSwatch}
                style={{ background: sw.hex }}
                title={`Apply ${sw.name} to the selected layers`}
                aria-label={`Apply ${sw.name} to selection`}
                disabled={!canApply}
                onClick={() => applyToSelection(selectedIds, sw.hex)}
              />
              {editingId === sw.id ? (
                <input
                  className={styles.rowInput}
                  value={draftName}
                  autoFocus
                  aria-label="Swatch name"
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.rowName}
                  title="Rename"
                  onClick={() => {
                    setEditingId(sw.id);
                    setDraftName(sw.name);
                  }}
                >
                  <span className={styles.rowNameText}>{sw.name}</span>
                  <span className={styles.rowHex}>{sw.hex.toUpperCase()}</span>
                </button>
              )}
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title="Move up"
                  aria-label={`Move ${sw.name} up`}
                  disabled={i === 0}
                  onClick={() => moveSwatch(sw.id, i - 1)}
                >
                  <Icon name="chevron-up" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title="Move down"
                  aria-label={`Move ${sw.name} down`}
                  disabled={i === swatches.length - 1}
                  onClick={() => moveSwatch(sw.id, i + 1)}
                >
                  <Icon name="chevron-down" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  title="Delete swatch"
                  aria-label={`Delete ${sw.name}`}
                  onClick={() => {
                    removeSwatch(sw.id);
                    if (editingId === sw.id) setEditingId(null);
                  }}
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {swatches.length > 0 && (
        <p className={styles.hint}>
          {canApply
            ? `Click a swatch to fill ${selectedIds.length} selected layer${selectedIds.length === 1 ? '' : 's'}.`
            : 'Select layers to apply a swatch as their fill.'}
        </p>
      )}

      <div className={styles.sectionLabel}>Document Colors</div>
      {documentColors.length === 0 ? (
        <p className={styles.empty}>Nothing in this composition is painted yet.</p>
      ) : (
        <div className={styles.grid} role="listbox" aria-label="Document colors">
          {documentColors.map((hex) => (
            <button
              key={hex}
              type="button"
              className={styles.gridSwatch}
              style={{ background: hex }}
              title={`${hex.toUpperCase()} — click to add to the project palette`}
              aria-label={`Add ${hex} to project swatches`}
              onClick={() => addSwatch(hex)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default SwatchesPanel;
