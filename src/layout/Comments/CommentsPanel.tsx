/**
 * CommentsPanel — layer- and timecode-anchored review comments (spec
 * §Collaboration V1). Add a note on the selected layer at the current time;
 * click a comment to jump the editor there.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { ReviewBar } from './ReviewBar';
import { useCommentsStore } from '@stores/commentsStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import styles from './CommentsPanel.module.css';

export function CommentsPanel(): JSX.Element {
  const comments = useCommentsStore((s) => s.comments);
  const add = useCommentsStore((s) => s.add);
  const remove = useCommentsStore((s) => s.remove);
  const primary = useSelectionStore((s) => s.primary);
  const setSelected = useSelectionStore((s) => s.set);
  const time = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time : 0)) ?? 0;
  const setTime = useWorkspaceStore((s) => s.actions.setTime);
  const fps = useCompositionStore((s) => s.fps);

  const [draft, setDraft] = useState('');
  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const anchorName = node?.name ?? null;

  const submit = (): void => {
    if (!primary || !anchorName || !draft.trim()) return;
    add({ nodeId: primary, nodeName: anchorName, time, text: draft.trim() });
    setDraft('');
  };

  const jumpTo = (c: { nodeId: string; time: number }): void => {
    setSelected([c.nodeId]);
    setTime(c.time, Math.round(c.time * fps));
  };

  return (
    <div className={styles.root}>
      <ReviewBar />
      <div className={styles.composer}>
        {anchorName ? (
          <div className={styles.anchor}>
            <Icon name="marker" size={11} /> {anchorName} · {time.toFixed(1)}s
          </div>
        ) : (
          <div className={styles.anchorMuted}>Select a layer to comment on it.</div>
        )}
        <textarea
          className={styles.input}
          value={draft}
          placeholder="Add a review note…"
          rows={2}
          disabled={!anchorName}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
        />
        <button type="button" className={styles.add} disabled={!anchorName || !draft.trim()} onClick={submit}>
          Comment
        </button>
      </div>

      <div className={styles.list}>
        {comments.length === 0 ? (
          <EmptyState icon="marker" message="No comments yet — select a layer and leave a note." />
        ) : (
          comments.map((c) => (
            <div key={c.id} className={styles.item} onClick={() => jumpTo(c)}>
              <div className={styles.itemHead}>
                <span className={styles.itemAnchor}>{c.nodeName}</span>
                <span className={styles.itemTime}>{c.time.toFixed(1)}s</span>
                <button
                  type="button"
                  className={styles.itemDel}
                  aria-label="Delete comment"
                  onClick={(e) => { e.stopPropagation(); remove(c.id); }}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              <div className={styles.itemText}>{c.text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default CommentsPanel;
