/**
 * The switches on one Layers row.
 *
 * Eye · audio · solo · lock, in the timeline's order and with its glyphs, so
 * the two panels read as one document — plus whichever of AE's layer switches
 * the user has turned on for this panel (`sceneViewStore.switches`).
 *
 * All of them are ANCHORED on the clicked row: they act on the whole selection
 * when the row is part of it and on that row alone otherwise, as one undo step.
 * That is the rule the context menu's labels already promised ("Unlock" locks
 * nothing else) and the rule the timeline follows.
 *
 * The switch VERBS are not here — they are engine commands built in
 * `./layerSwitchEdits` (availability and naming from `@core/scene/layerFlags`),
 * so this file is only the buttons over them and the timeline's copy of the
 * same buttons cannot mean something different.
 */

import { Icon, type IconName } from '@components/Icon';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { LayerFlag } from '@core/scene/layerFlags';
import {
  mirrorDescribeLayerFlag,
  mirrorLayerFlagAvailable,
  mirrorLayerFlagOn,
  mirrorLayerHasAudio,
} from '@core/mirror/layerFlagFacts';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useRetainTree } from '@hooks/useMirror';
import { anchoredLayerIds, toggleAudioAnchoredEdit, toggleLayerFlagsEdit, toggleLayerSwitchAnchored } from './layerSwitchEdits';
import styles from '@layout/EditorLayout/panels.module.css';

/** Does this layer make sound? Same test the timeline's A/V column uses (the mirror's `hasAudio`). */
function hasAudio(nodeId: string): boolean {
  return mirrorLayerHasAudio(documentMirror().layer(nodeId));
}

/** The speaker, anchored on the clicked row (`setLayerSwitches{audioEnabled}`, one entry). */
function toggleAudioAnchored(id: string): void {
  void toggleAudioAnchoredEdit(id, hasAudio);
}

export interface SceneRowSwitchesProps {
  nodeId: string;
  /** Extra AE switches to draw, in `LAYER_FLAGS` order. */
  flags: ReadonlyArray<LayerFlag>;
}

export function SceneRowSwitches({ nodeId, flags }: SceneRowSwitchesProps): JSX.Element | null {
  // B4: the row reads the layer's header from the document mirror. The 3D and
  // sunburst switches also ask the layer's property tree (a Transform, vector
  // geometry), so the tree is kept loaded only while one of them is shown.
  const needsTree = flags.includes('threeD') || flags.includes('collapse');
  useRetainTree(needsTree ? nodeId : null);
  useMirrorKeys(needsTree ? [`layer:${nodeId}`, `tree:${nodeId}`] : [`layer:${nodeId}`]);
  const m = documentMirror();
  const layer = m.layer(nodeId);

  let hidden: boolean;
  let locked: boolean;
  let solo: boolean;
  if (layer) {
    hidden = !layer.switches.visible;
    locked = layer.switches.locked;
    solo = layer.switches.solo;
  } else {
    // B4-gap: a composition ROOT is not a layer in the API (it is an item), so its row's
    // eye / lock / solo — node flags the legacy writers still toggle — have no mirror record.
    const root = defaultSceneGraph.getNode(nodeId);
    if (!root) return null;
    hidden = root.visible === false;
    locked = root.locked === true;
    solo = root.solo === true;
  }
  const audible = mirrorLayerHasAudio(layer);
  const muted = audible && layer?.switches.audioEnabled === false;
  // A composition root is the document, not a layer in it: it carries none of
  // the AE switches, and drawing dead buttons on it would be four more things
  // in a row that already has to earn its width.
  const isRoot = !layer;

  return (
    <>
      <button
        type="button"
        className={styles.rowAction}
        data-kind="visible"
        data-on={hidden || undefined}
        aria-label={hidden ? 'Show layer' : 'Hide layer'}
        title={hidden ? 'Show' : 'Hide'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'visible'); }}
      >
        <Icon name={hidden ? 'eye-off' : 'eye'} size="sm" />
      </button>

      {/* AE's A/V Features column puts the speaker next to the eye. Layers that
          make no sound simply do not get one here — unlike the timeline, this
          row is not a fixed-width column that has to stay aligned. */}
      {audible && (
        <button
          type="button"
          className={styles.rowAction}
          data-kind="audio"
          data-on={muted || undefined}
          aria-label={muted ? 'Unmute layer audio' : 'Mute layer audio'}
          aria-pressed={muted}
          title={muted ? 'Unmute audio' : 'Mute audio'}
          onClick={(e) => { e.stopPropagation(); toggleAudioAnchored(nodeId); }}
        >
          <Icon name={muted ? 'audio-off' : 'audio'} size="sm" />
        </button>
      )}

      <button
        type="button"
        className={styles.rowAction}
        data-kind="solo"
        data-on={solo || undefined}
        aria-label={solo ? 'Unsolo layer' : 'Solo layer'}
        title={solo ? 'Unsolo' : 'Solo'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'solo'); }}
      >
        <Icon name="circle" size="sm" />
      </button>

      <button
        type="button"
        className={styles.rowAction}
        data-kind="lock"
        data-on={locked || undefined}
        aria-label={locked ? 'Unlock layer' : 'Lock layer'}
        title={locked ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); void toggleLayerSwitchAnchored(nodeId, 'locked'); }}
      >
        <Icon name={locked ? 'lock' : 'unlock'} size="sm" />
      </button>

      {!isRoot && flags.map((flag) => {
        // A switch the layer cannot carry is left out rather than drawn dead:
        // unlike the timeline, this row is not a fixed-width column that has to
        // stay aligned, so an absent switch costs nothing and a dead one lies.
        if (!mirrorLayerFlagAvailable(m, nodeId, flag)) return null;
        // The sunburst is Collapse Transformations on a comp and Continuous
        // Rasterize on a vector layer, and Quality names the position it is in
        // — so both are asked per layer rather than read off the static table.
        const face = mirrorDescribeLayerFlag(m, nodeId, flag);
        const on = mirrorLayerFlagOn(layer, flag);
        // `aria-pressed` says "this is a two-state toggle", which Quality is
        // not — it cycles three positions, and its NAME carries the state.
        const cycles = flag === 'quality';
        return (
          <button
            key={flag}
            type="button"
            className={styles.rowAction}
            data-kind={flag}
            data-on={on || undefined}
            aria-label={face.label}
            {...(cycles ? {} : { 'aria-pressed': on })}
            data-quality={cycles ? face.glyph : undefined}
            title={face.title}
            onClick={(e) => {
              e.stopPropagation();
              // One `setLayerSwitches` entry over the anchored set, with the
              // feedback the legacy toggle gave (camera tip, motion-blur comp switch).
              if (flag === 'shy') void toggleLayerSwitchAnchored(nodeId, 'shy');
              else void toggleLayerFlagsEdit(anchoredLayerIds(nodeId), flag, nodeId);
            }}
          >
            {face.glyph
              ? <span className={styles.switchGlyph}>{face.glyph}</span>
              : <Icon name={face.icon as IconName} size="sm" />}
          </button>
        );
      })}
    </>
  );
}
