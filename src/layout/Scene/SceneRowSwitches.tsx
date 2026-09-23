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
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  describeLayerFlag,
  layerFlagAvailable,
  readLayerFlag,
  type LayerFlag,
} from '@core/scene/layerFlags';
import { anchoredLayerIds, toggleAudioAnchoredEdit, toggleLayerFlagsEdit, toggleLayerSwitchAnchored } from './layerSwitchEdits';
import { isLayerAudioMuted } from '@core/audio/audioLayerSwitches';
import { videoHasAudioTrack } from '@core/audio/audioScene';
import styles from '@layout/EditorLayout/panels.module.css';

/** Does this layer make sound? Same test the timeline's A/V column uses. */
function hasAudio(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = readNodeKind(node);
  return kind === 'audio' || (kind === 'video' && videoHasAudioTrack(node) !== false);
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
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const hidden = node.visible === false;
  const locked = node.locked === true;
  const solo = node.solo === true;
  const audible = hasAudio(nodeId);
  const muted = audible && isLayerAudioMuted(nodeId);
  // A composition root is the document, not a layer in it: it carries none of
  // the AE switches, and drawing dead buttons on it would be four more things
  // in a row that already has to earn its width.
  const isRoot = node.parent === null;

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
        if (!layerFlagAvailable(node, flag)) return null;
        // The sunburst is Collapse Transformations on a comp and Continuous
        // Rasterize on a vector layer, and Quality names the position it is in
        // — so both are asked per layer rather than read off the static table.
        const face = describeLayerFlag(node, flag);
        const on = readLayerFlag(node, flag);
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
