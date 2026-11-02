/**
 * PuppetControls — inspector for a layer's puppet rig.
 *
 * After Effects' Puppet panel is short: mesh density, then the pins you placed,
 * each showing only the properties its tool owns. Solver / rotation refinement
 * stay available but are not the first thing you see.
 *
 * Writes go through the engine API on the rig paths (rigEdits.ts,
 * ENGINE_API.md §15.9): `puppet/mesh/<field>`, `puppet/pins/<pin>/<prop>`.
 * A scrub or a slider drag is ONE gesture; a click / pick / typed value one entry.
 */

import { Slider } from '@components/Slider';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { rigPaths } from '@core/engine/rigPaths';
import { useMirrorKeyframes, useMirrorLayer, useMirrorTree, useMirrorValueAt } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import {
  PIN_KIND_CATALOG,
  pinKindOf,
  pinColor,
  type PinKind,
  type PuppetRig,
} from '@core/rig/puppet';
import { maxExactMeshDensity, SMOOTH_PLAYBACK_MAX_DENSITY } from '@core/rig/arap';
import { t } from '@core/i18n';
import { useEngineEdit, type EngineEdit } from './useEngineEdit';
import { AnimToggle } from './AnimToggle';
import { stopwatchCommands } from './inspectorEdits';
import { deletePinCommands, pinKindCommands, pinPositionCommands, pinPropCommands, puppetMeshCommands } from './rigEdits';
import type { PuppetPin } from '@core/rig/puppet';
import styles from './BoneControls.module.css';

/** Shared <select> chrome — every dropdown here must look identical. */
const selectStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 4,
  background: 'var(--color-surface, #1e1e1e)',
  color: 'var(--color-text-primary, #fff)',
  border: '1px solid var(--color-border, #333)',
};

function pinCountLabel(n: number): string {
  return n === 1 ? t('inspector.puppet.pinCountOne', '1 pin') : t('inspector.puppet.pinCountOther', '{n} pins', { n });
}

export function PuppetControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  const time = useActiveWorkspace()?.time ?? 0;
  const eng = useEngineEdit();
  // B4: the layer header and its whole rig (`layer/puppet` = fx.puppet verbatim) from the document mirror.
  const layer = useMirrorLayer(nodeId);
  const rig = useMirrorJson<PuppetRig>(nodeId, 'layer/puppet');
  // C1's mesh settings (`puppet/mesh/traceAccuracy`, `puppet/mesh/alphaThreshold`) appear once the engine lists them.
  const tree = useMirrorTree(layer ? nodeId : null);
  const hasTrace = !!tree?.nodes.has('puppet/mesh/traceAccuracy');
  const hasAlpha = !!tree?.nodes.has('puppet/mesh/alphaThreshold');
  if (!layer) return null;

  const meshLabel = 'Edit Puppet Mesh';
  const pinLabel = 'Edit Puppet Pin';
  const mesh = (label: string, patch: Parameters<typeof puppetMeshCommands>[1]): void =>
    eng.send(label, puppetMeshCommands(nodeId, patch));
  const pinProp = (pinId: string, prop: Parameters<typeof pinPropCommands>[2], v: number): void =>
    eng.send(pinLabel, pinPropCommands(nodeId, pinId, prop, v, time));

  // Stored keys as C1 names them (optional chaining: tsc passes before and after C1 lands).
  const meshAny = rig as (PuppetRig & { traceAccuracy?: number; alphaThreshold?: number }) | undefined;
  const density = rig?.meshDensity ?? 22;
  const expansion = rig?.meshExpansion ?? 0;
  const solver = rig?.solver ?? 'arap';
  const meshMode = rig?.meshMode ?? 'grid';
  const pins = rig?.pins ?? [];

  const hasStiffness = pins.some((p) => (p.stiffness ?? 0) > 0);
  const exactMax = maxExactMeshDensity(hasStiffness);
  const pastExact = solver === 'arap' && density > exactMax;
  const costly = solver === 'arap' && density > SMOOTH_PLAYBACK_MAX_DENSITY;

  return (
    <div className={styles.root}>
      <div className={styles.headerCard}>
        <div className={styles.headerTitle}>
          <Icon name="puppet-pin" size="sm" />
          <span>{t('inspector.puppet.title', 'Puppet')}</span>
          <span className={styles.badge}>{pinCountLabel(pins.length)}</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
        >
          <Icon name="plus" size="sm" /> {t('inspector.puppet.addPin', 'Add Pin')}
        </Button>
      </div>

      <div className={styles.card}>
        <div className={styles.paramRow} style={{ height: 'auto', marginBottom: 2 }}>
          <div className={styles.presetGroup}>
            <button
              type="button"
              className={`${styles.presetButton} ${meshMode === 'silhouette' ? styles.presetButtonActive : ''}`}
              title={t('inspector.puppet.characterHint', "Traces the artwork's outline and fills it with triangles (AE's Puppet mesh) — a limb becomes its own strip, so pinning a hand bends the arm instead of dragging the body.")}
              onClick={() =>
                // Density 20, not 22: the ⚓ Anchor toggle gives a pin stiffness
                // 10, and any stiffness lowers the ARAP exact-solve cap to 21 —
                // a 22 preset silently landed every anchored character in the
                // approximate Gauss–Seidel solve.
                mesh(meshLabel, { expansion: 0, density: 20, mode: 'silhouette' })
              }
            >
              <Icon name="user" size="sm" />
              <span>{t('inspector.puppet.character', 'Character (Tight)')}</span>
            </button>
            <button
              type="button"
              className={`${styles.presetButton} ${meshMode !== 'silhouette' ? styles.presetButtonActive : ''}`}
              title={t('inspector.puppet.graphicHint', 'Softer mesh with padding — ideal for shapes and banners')}
              onClick={() =>
                mesh(meshLabel, { expansion: 6, density: 16, mode: 'grid' })
              }
            >
              <Icon name="shape" size="sm" />
              <span>{t('inspector.puppet.graphic', 'Graphic (Smooth)')}</span>
            </button>
          </div>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>
            {t('inspector.puppet.density', 'Density')}
            {solver === 'arap' && (
              <span
                className={styles.subText}
                style={{ marginLeft: 6 }}
                title={t('inspector.puppet.densityHint', 'Exact solve up to {exact}. Smooth playback up to {fast} — beyond that the solve cost per frame climbs steeply.', { exact: exactMax, fast: SMOOTH_PLAYBACK_MAX_DENSITY })}
              >
                {t('inspector.puppet.densityRange', '(exact ≤ {exact} · fast ≤ {fast})', { exact: exactMax, fast: SMOOTH_PLAYBACK_MAX_DENSITY })}
              </span>
            )}
          </span>
          <span style={{ display: 'contents' }} {...eng.press(meshLabel)}>
          <Slider
            value={density}
            min={2}
            max={50}
            step={1}
            showValue
            size="sm"
            label={t('inspector.puppet.meshDensity', 'Mesh density')}
            onChange={(v) => mesh(meshLabel, { density: Math.round(v) })}
          />
          </span>
        </div>

        {costly && (
          <div className={styles.warningBox} role="note">
            {t('inspector.puppet.costly', 'Density {density} is heavy to solve — roughly {ms} per frame. Around {fast} keeps playback smooth.', {
              density,
              ms: density >= 33 ? '35–45 ms' : '10–20 ms',
              fast: SMOOTH_PLAYBACK_MAX_DENSITY,
            })}
          </div>
        )}

        {pastExact && (
          <div className={styles.warningBox} role="note">
            {hasStiffness
              ? t('inspector.puppet.pastExactStiff', 'Density {density} is above {exact} (lowered because a pin has stiffness) — ARAP falls back from exact solve to an approximate one. Lower density for maximum fidelity.', { density, exact: exactMax })
              : t('inspector.puppet.pastExact', 'Density {density} is above {exact} — ARAP falls back from exact solve to an approximate one. Lower density for maximum fidelity.', { density, exact: exactMax })}
          </div>
        )}

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title={t('inspector.puppet.meshHint', "Grid culls a uniform mesh against the artwork; Silhouette triangulates the outline (or a PNG's alpha).")}>
            {t('inspector.puppet.mesh', 'Mesh')}
          </span>
          <select
            value={rig?.meshMode ?? 'grid'}
            aria-label={t('inspector.puppet.meshMode', 'Puppet mesh mode')}
            onChange={(e) => mesh(meshLabel, { mode: e.target.value as 'grid' | 'silhouette' })}
            style={selectStyle}
          >
            <option value="grid">{t('inspector.puppet.grid', 'Grid')}</option>
            <option value="silhouette">{t('inspector.puppet.outline', 'Outline')}</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span
            className={styles.paramLabel}
            title={t('inspector.puppet.expansionHint', "How far past the artwork's edge the mesh reaches, in pixels. A few px catches a soft or antialiased edge the alpha trace clips.")}
          >
            {t('inspector.puppet.expansion', 'Expansion')}
          </span>
          <span style={{ display: 'contents' }} {...eng.press(meshLabel)}>
          <Slider
            value={expansion}
            min={0}
            max={100}
            step={1}
            showValue
            size="sm"
            label={t('inspector.puppet.meshExpansion', 'Mesh expansion')}
            onChange={(v) => mesh(meshLabel, { expansion: Math.round(v) })}
          />
          </span>
        </div>

        {hasTrace && (
          <div className={styles.paramRow}>
            <span className={styles.paramLabel} title={t('inspector.puppet.traceAccuracyHint', "How closely the outline mesh follows the artwork's edge (0–100). Higher keeps small notches; lower smooths them away.")}>
              {t('inspector.puppet.traceAccuracy', 'Trace Accuracy')}
            </span>
            <ValueField
              value={meshAny?.traceAccuracy ?? 60}
              min={0}
              max={100}
              {...eng.scrub(meshLabel)}
              onChange={(v) => mesh(meshLabel, { traceAccuracy: Math.max(0, Math.min(100, Math.round(v))) })}
              aria-label={t('inspector.puppet.traceAccuracy', 'Trace Accuracy')}
            />
          </div>
        )}

        {hasAlpha && (
          <div className={styles.paramRow}>
            <span className={styles.paramLabel} title={t('inspector.puppet.alphaThresholdHint', 'Alpha below this (0–255) counts as outside the artwork when the outline is traced.')}>
              {t('inspector.puppet.alphaThreshold', 'Alpha Threshold')}
            </span>
            <ValueField
              value={meshAny?.alphaThreshold ?? 32}
              min={0}
              max={255}
              {...eng.scrub(meshLabel)}
              onChange={(v) => mesh(meshLabel, { alphaThreshold: Math.max(0, Math.min(255, Math.round(v))) })}
              aria-label={t('inspector.puppet.alphaThreshold', 'Alpha Threshold')}
            />
          </div>
        )}

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>{t('inspector.puppet.solver', 'Solver')}</span>
          <select
            value={solver}
            aria-label={t('inspector.puppet.solverLabel', 'Puppet deform solver')}
            onChange={(e) => mesh(meshLabel, { solver: e.target.value as 'lbs' | 'arap' })}
            style={selectStyle}
          >
            <option value="arap">ARAP</option>
            <option value="lbs">LBS</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title={t('inspector.puppet.rotationLimitHint', 'Caps how far any one pin may rotate the mesh. 0 = unlimited.')}>
            {t('inspector.puppet.rotationLimit', 'Rotation Limit')}
          </span>
          <ValueField
            value={rig?.maxRotationDeg ?? 0}
            min={0}
            unit="°"
            {...eng.scrub(meshLabel)}
            // 0 = unlimited (stored as absent).
            onChange={(v) => mesh(meshLabel, { rotationRefinement: Math.max(0, v) })}
            aria-label={t('inspector.puppet.rotationRefinement', 'Mesh rotation refinement')}
          />
        </div>
      </div>

      {pins.length > 0 && pins.length < 3 && (
        <div className={styles.tipCard}>
          <Icon name="info" size="sm" style={{ flexShrink: 0, marginTop: 1, color: '#60a5fa' }} />
          <span>
            <strong>{t('inspector.puppet.tipLabel', 'Tip:')}</strong> {t('inspector.puppet.tip', 'Add anchor pins to the chest & shoulders to keep the body in place when moving limbs.')}
          </span>
        </div>
      )}

      {pins.length === 0 && (
        <div className={styles.card} style={{ textAlign: 'center', padding: '16px 12px' }}>
          <span className={styles.subText}>{t('inspector.puppet.empty', 'Click the layer to place pins.')}</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
            style={{ marginTop: 8 }}
          >
            <Icon name="puppet-pin" size="sm" style={{ color: '#ffffff' }} /> {t('inspector.puppet.pinTool', 'Puppet Pin Tool ({shortcut})', { shortcut: 'Ctrl+P' })}
          </Button>
        </div>
      )}

      {pins.map((pin) => (
        <PinCard key={pin.id} nodeId={nodeId} pin={pin} seconds={time} eng={eng} pinProp={pinProp} />
      ))}
    </div>
  );
}

/** The stopwatch (+ ◀ ◆ ▶ once animated) of ONE rig property, over its keyframe track(s). */
export function RigAnimToggle({ nodeId, path, tracks, label, seconds }: { nodeId: string; path: string; tracks: readonly string[]; label: string; seconds: number }): JSX.Element {
  const animated = useMirrorKeyframes(nodeId, path).length > 0;
  return (
    <AnimToggle
      nodeId={nodeId}
      tracks={tracks}
      label={label}
      animated={animated}
      onToggle={() => { void edit(animated ? `Stop ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], tracks, seconds)); }}
    />
  );
}

/**
 * One pin: After Effects' Puppet Pin N twirl as inspector rows — Position
 * (X / Y), Rotation, Scale, Stiffness, Overlap, each with its stopwatch and,
 * once animated, the keyframe navigator. The values are the LIVE ones at the
 * playhead (the mirror's `valueAt`, which samples the keys), not the stored
 * static numbers: a field that showed the rest value while the pin visibly
 * moved was the old behaviour. A typed value follows the one keying rule
 * (rigEdits `rigAutoKey`): a key when animated, under auto-keyframe or the
 * Puppet tool's "Always key pins", else the static value.
 */
function PinCard({ nodeId, pin, seconds, eng, pinProp }: {
  nodeId: string;
  pin: PuppetPin;
  seconds: number;
  eng: EngineEdit;
  pinProp: (pinId: string, prop: Parameters<typeof pinPropCommands>[2], v: number) => void;
}): JSX.Element {
  const pinLabel = 'Edit Puppet Pin';
  const name = pin.name || pin.id;
  // The display time: throttled during playback (never the raw clock per frame).
  const shown = compTime(useThrottledTime());
  // Hooks in a fixed order: every property is read whether or not its row shows.
  const position = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.pinProp(pin.id, 'position'), shown));
  const rotation = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.pinProp(pin.id, 'rotation'), shown))[0] ?? pin.rotation ?? 0;
  const scale = (numbersOfValue(useMirrorValueAt(nodeId, rigPaths.pinProp(pin.id, 'scale'), shown))[0] ?? (pin.scale ?? 1) * 100) / 100;
  const stiffness = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.pinProp(pin.id, 'stiffness'), shown))[0] ?? pin.stiffness ?? 0;
  const overlap = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.pinProp(pin.id, 'overlap'), shown))[0] ?? pin.overlap ?? 0;
  const px = position[0] ?? pin.position?.x ?? pin.x;
  const py = position[1] ?? pin.position?.y ?? pin.y;
  const selected = useRigSelectionStore((s) => s.nodeId === nodeId && s.pinIds.includes(pin.id));

  const kind = pinKindOf(pin);
  const showRotate = kind === 'advanced' || kind === 'bend';
  const showScale = kind === 'advanced' || kind === 'bend';
  const showStiffness = kind === 'starch' || kind === 'advanced' || stiffness > 0;
  const showOverlap = kind === 'overlap' || overlap !== 0;
  const isAnchored = stiffness >= 5;
  const track = (prop: string): string => `puppet.${pin.id}.${prop}`;
  const row = (prop: 'rotation' | 'scale' | 'stiffness' | 'overlap', label: string, field: JSX.Element, hint?: string): JSX.Element => (
    <div className={styles.paramRow}>
      <RigAnimToggle nodeId={nodeId} path={rigPaths.pinProp(pin.id, prop)} tracks={[track(prop)]} label={`${name} ${label}`} seconds={seconds} />
      <span className={styles.paramLabel} title={hint}>{label}</span>
      {field}
    </div>
  );

  return (
    <div
      className={styles.card}
      style={selected ? { outline: '1px solid var(--color-accent)', outlineOffset: -1 } : undefined}
      onClick={(e) => {
        // Click the card to select the pin on the canvas (Shift extends), as a row click selects a bone.
        if ((e.target as HTMLElement).closest('input, select, button')) return;
        const st = useRigSelectionStore.getState();
        if (e.shiftKey) st.togglePin(nodeId, pin.id);
        else st.selectPins(nodeId, [pin.id]);
      }}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: kind === 'bend' ? 'transparent' : pinColor(kind),
              border: `2px solid ${pinColor(kind)}`,
              flexShrink: 0,
            }}
          />
          <span>{name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className={`${styles.anchorToggle} ${isAnchored ? styles.anchorToggleActive : ''}`}
            title={isAnchored ? t('inspector.puppet.anchorActive', 'Anchor lock active (body stays rigid)') : t('inspector.puppet.anchorLock', 'Lock as rigid anchor (Stiffness: 10)')}
            onClick={() => pinProp(pin.id, 'stiffness', isAnchored ? 0 : 10)}
          >
            <Icon
              name={isAnchored ? 'lock' : 'anchor'}
              size="sm"
              style={{ color: isAnchored ? '#f5b041' : 'inherit' }}
            />
            <span>{isAnchored ? t('inspector.puppet.locked', 'Locked') : t('inspector.puppet.anchor', 'Anchor')}</span>
          </button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { void edit('Delete Puppet Pin', deletePinCommands(nodeId, pin.id)); }}
            aria-label={t('inspector.puppet.deletePinNamed', 'Delete pin {name}', { name })}
            title={t('inspector.puppet.deletePin', 'Delete pin')}
          >
            <Icon name="trash" size="sm" />
          </Button>
        </div>
      </div>

      <div className={styles.paramRow}>
        <span className={styles.paramLabel}>{t('inspector.puppet.type', 'Type')}</span>
        <select
          value={kind}
          aria-label={t('inspector.puppet.pinTypeLabel', '{name} pin type', { name })}
          onChange={(e) => { void edit(pinLabel, pinKindCommands(nodeId, pin.id, e.target.value as PinKind)); }}
          style={selectStyle}
        >
          {PIN_KIND_CATALOG.map((k) => (
            <option key={k.kind} value={k.kind}>{k.short}</option>
          ))}
        </select>
      </div>

      {kind === 'bend' && (
        <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
          {t('inspector.puppet.bendHint', 'Position is derived from the advanced pins around it. Rotation and scale act on the motion they already produce — at 0° and 1× this pin does nothing.')}
        </div>
      )}
      {kind === 'starch' && (
        <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
          {t('inspector.puppet.starchHint', 'Keeps this region rigid so nearby pins cannot fold it.')}
        </div>
      )}
      {kind === 'overlap' && (
        <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
          {t('inspector.puppet.overlapKindHint', 'Sets which part draws in front when the mesh folds over itself.')}
        </div>
      )}

      {kind !== 'bend' && (
        <div className={styles.paramRow}>
          <RigAnimToggle nodeId={nodeId} path={rigPaths.pinProp(pin.id, 'position')} tracks={[track('position')]} label={`${name} ${t('inspector.puppet.position', 'Position')}`} seconds={seconds} />
          <span className={styles.paramLabel} title={t('inspector.puppet.positionHint', "Where the pin is at the playhead (the layer's rest space, px).")}>
            {t('inspector.puppet.position', 'Position')}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <ValueField
              value={px}
              unit="px"
              {...eng.scrub(pinLabel)}
              onChange={(x) => eng.send(pinLabel, pinPositionCommands(nodeId, pin.id, { x, y: py }, seconds))}
              aria-label={t('inspector.puppet.pinXLabel', '{name} x', { name })}
            />
            <ValueField
              value={py}
              unit="px"
              {...eng.scrub(pinLabel)}
              onChange={(y) => eng.send(pinLabel, pinPositionCommands(nodeId, pin.id, { x: px, y }, seconds))}
              aria-label={t('inspector.puppet.pinYLabel', '{name} y', { name })}
            />
          </div>
        </div>
      )}

      {showRotate && row('rotation', t('inspector.puppet.rotation', 'Rotation'), (
        <ValueField
          value={rotation}
          unit="°"
          {...eng.scrub(pinLabel)}
          onChange={(v) => pinProp(pin.id, 'rotation', v)}
          aria-label={t('inspector.puppet.pinRotationLabel', '{name} rotation', { name })}
        />
      ))}

      {showStiffness && row('stiffness', t('inspector.puppet.stiffness', 'Stiffness'), (
        <ValueField
          value={stiffness}
          min={0}
          {...eng.scrub(pinLabel)}
          onChange={(v) => pinProp(pin.id, 'stiffness', Math.max(0, v))}
          aria-label={t('inspector.puppet.pinStiffnessLabel', '{name} stiffness', { name })}
        />
      ))}

      {showScale && row('scale', t('inspector.puppet.scale', 'Scale'), (
        <ValueField
          value={scale}
          min={0.01}
          {...eng.scrub(pinLabel)}
          onChange={(v) => pinProp(pin.id, 'scale', Math.max(0.01, v))}
          aria-label={t('inspector.puppet.pinScaleLabel', '{name} scale', { name })}
        />
      ))}

      {showOverlap && row('overlap', t('inspector.puppet.overlap', 'Overlap'), (
        <ValueField
          value={overlap}
          min={-100}
          max={100}
          {...eng.scrub(pinLabel)}
          onChange={(v) => pinProp(pin.id, 'overlap', Math.max(-100, Math.min(100, v)))}
          aria-label={t('inspector.puppet.pinOverlapLabel', '{name} overlap', { name })}
        />
      ), t('inspector.puppet.overlapHint', 'Depth ordering where the mesh folds over itself — positive draws this region in front.'))}

      {showOverlap && overlap !== 0 && (
        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>{t('inspector.puppet.overlapExtent', 'Overlap Extent')}</span>
          <ValueField
            value={pin.overlapExtent ?? 1}
            min={0.05}
            {...eng.scrub(pinLabel)}
            onChange={(v) => pinProp(pin.id, 'overlapExtent', Math.max(0.05, v))}
            aria-label={t('inspector.puppet.pinOverlapExtentLabel', '{name} overlap extent', { name })}
          />
        </div>
      )}
    </div>
  );
}

export default PuppetControls;
