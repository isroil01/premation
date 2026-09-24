/**
 * The Corners group of the Fill & Stroke section: the link switch, the
 * uniform radius, and the four individual corners.
 *
 * Split out of `AppearanceSection.tsx` (2026-09-04). The rows read the PRIMARY
 * layer only — with several layers selected the row says so ("1 of 3").
 *
 * B3z: through the engine API. The radii are catalog properties on the Style
 * component (`layer/cornerRadius`, `layer/cornerRadiusTL|TR|BR|BL` — latent
 * until stored, latentPropSpecs.ts, so their first write lands on the Style),
 * the link switch the field `layer/cornersLinked`. A linked edit writes the
 * uniform radius AND the four corners in ONE command list (a key at the
 * playhead where a corner is animated); an unlinked corner writes itself and
 * the uniform radius as the max (extrusion / legacy readers); link / unlink is
 * one batch of the corners and the switch. A drag is one gesture.
 */

import { useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { edit } from '@core/engine/uiEdits';
import { isTrackAnimated } from '@core/mirror/selection';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { fieldCommands } from '@layout/Text/textEdits';
import { valueCommands } from '../inspectorEdits';
import { useEngineEdit } from '../useEngineEdit';
import { AnimatablePaintRow } from './AnimatablePaintRow';
import styles from '../TransformSection.module.css';

type Corner = 'TL' | 'TR' | 'BR' | 'BL';
const CORNERS: ReadonlyArray<Corner> = ['TL', 'TR', 'BR', 'BL'];
const track = (c: Corner): string => `cornerRadius${c}`;
const RADIUS_TRACKS: ReadonlyArray<string> = ['cornerRadius', ...CORNERS.map(track)];
/** What the rows show: the five radii and the link switch (a path — the track index answers paths too). */
const WATCHED: ReadonlyArray<string> = [...RADIUS_TRACKS, 'layer/cornersLinked'];

export function CornerRows({ nodeId }: { nodeId: string }): JSX.Element | null {
  const time = useThrottledTime();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const e = useEngineEdit();
  // B4: wake on the radii / the link switch (info, keys, value) of this layer.
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorTrackWatch(watchIds, WATCHED);
  // B4-gap: the stored per-corner radii and link flag — an UNSTORED corner is
  // latent in the API and reads the registry default (0) where the renderer
  // falls back to the uniform radius (cornerRadii.ts), and an absent
  // `cornersLinked` reads `true` where a legacy doc derives it from equal
  // corners; the mirror cannot tell absent from default, so read the Style.
  const node = defaultSceneGraph.getNode(nodeId);
  const props = (node?.components.find((c) => c.type === 'Style')?.props ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const cornerRadius = num(props.cornerRadius, 0);
  const radii: Record<Corner, number> = {
    TL: num(props.cornerRadiusTL, cornerRadius),
    TR: num(props.cornerRadiusTR, cornerRadius),
    BR: num(props.cornerRadiusBR, cornerRadius),
    BL: num(props.cornerRadiusBL, cornerRadius),
  };
  const cornersLinked = (() => {
    if (props.cornersLinked === false) return false;
    if (props.cornersLinked === true) return true;
    // Legacy docs with only `cornerRadius` (or equal individuals) stay linked.
    return radii.TL === radii.TR && radii.TR === radii.BR && radii.BR === radii.BL;
  })();

  if (!node) return null;

  /** Every corner and the uniform radius := r. */
  const allValues = (r: number): Record<string, number> => ({
    cornerRadius: r, ...Object.fromEntries(CORNERS.map((c) => [track(c), r])),
  });
  /** One corner := r, the uniform radius := the max (extrusion / legacy readers stay sensible). */
  const cornerValues = (which: Corner, r: number): Record<string, number> => {
    const next = { ...radii, [which]: r };
    return { [track(which)]: r, cornerRadius: Math.max(next.TL, next.TR, next.BR, next.BL) };
  };
  const cmds = (values: Record<string, number>): Command[] => valueCommands([{ nodeId, values }], { seconds: time, autoKeyframe });
  const linkCmds = (linked: boolean): Command[] => fieldCommands(nodeId, 'layer/cornersLinked', linked);

  const toggleCornersLinked = (): void => {
    if (cornersLinked) {
      // Unlink: seed each corner from the current values so fields don't jump.
      void edit('Unlink Corners', [...cmds(Object.fromEntries(CORNERS.map((c) => [track(c), radii[c]]))), ...linkCmds(false)]);
    } else {
      void edit('Link Corners', [...cmds(allValues(cornerRadius)), ...linkCmds(true)]);
    }
  };

  /** Primary-only READ accessor: the value shown. */
  const primaryAccess = (value: number): PropertyAccess => ({ read: (id) => (id === nodeId ? value : undefined) });

  const isCornerAnimated = RADIUS_TRACKS.some((p) => isTrackAnimated(documentMirror(), nodeId, p));

  return (
    <>
      <div className={styles.subhead} style={{ marginTop: 10 }}>
        <span>Corners</span>
        <button
          type="button"
          onClick={toggleCornersLinked}
          className={`${styles.lockBtn} ${cornersLinked ? styles.lockBtnActive : ''}`}
          title={cornersLinked ? 'Unlink corners (edit individually)' : 'Link corners (same radius)'}
          style={{ marginLeft: 6 }}
          aria-pressed={cornersLinked}
        >
          <Icon name={cornersLinked ? 'lock' : 'unlock'} size="sm" style={{ color: cornersLinked ? '#f59e0b' : '#94a3b8' }} />
        </button>
        {isCornerAnimated && <span className={styles.animatedDot} />}
      </div>
      {cornersLinked ? (
        <AnimatablePaintRow
          nodeId={nodeId}
          prop="cornerRadius"
          label="All"
          access={primaryAccess(cornerRadius)}
          valuesFor={(_id, v) => allValues(Math.max(0, v))}
        />
      ) : (
        <>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>All</span>
            <ValueField
              value={Math.max(radii.TL, radii.TR, radii.BR, radii.BL)}
              unit="px"
              min={0}
              onChange={(v) => e.send('Set Corner Radius', cmds(allValues(Math.max(0, Number(v)))))}
              {...e.scrub('Set Corner Radius')}
              aria-label="Corner radius"
            />
          </div>
          <div className={styles.cornerGrid} role="group" aria-label="Individual corner radii">
            {(['TL', 'TR', 'BL', 'BR'] as const).map((c) => (
              <AnimatablePaintRow
                key={c}
                nodeId={nodeId}
                prop={track(c)}
                label={c}
                access={primaryAccess(radii[c])}
                valuesFor={(_id, v) => cornerValues(c, Math.max(0, v))}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default CornerRows;
