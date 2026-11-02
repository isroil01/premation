/**
 * Ik3DSection — 3D inverse kinematics for the selected chain tip.
 *
 * The solver (boneIK3d.ts) shipped with two palette commands and no panel, and
 * the palette form carries a rule nobody can guess: "select the tip FIRST,
 * then Ctrl/Cmd-click the target". That is a modal selection protocol standing
 * in for a control. Here the tip is simply the selected layer and the target
 * is picked explicitly — by pick-whip, the gesture an After Effects user
 * reaches for, or from a dropdown when the layer is off screen.
 *
 * Shown only for a CHAIN TIP: a 3D layer with at least one 3D ancestor, which
 * is what `ikChainFromTip` needs to solve (it walks up through consecutive 3D
 * layers and stops at an imported model's root). A lone 3D layer has nothing
 * to bend, so the section stays away rather than offering two buttons that
 * would always warn.
 *
 * Pose and Bake are the engine's `poseIk3D` / `bakeIk3D` commands (ikEdits.ts,
 * the same ones the palette commands send) — one undo entry each; the solver
 * runs in the engine. The options exposed here (iterations, damping,
 * tolerance) are the commands' `IkOptions`; leaving them at the defaults
 * reproduces the palette's solve.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { PickWhip } from '@components/PickWhip';
import { t } from '@core/i18n';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { mirrorEligibleParents } from '@core/mirror/parenting';
import { mirrorIkChainFromTip } from '@core/mirror/layerFacts';
import { settingsDurationSeconds } from '@core/mirror/compFacts';
import { IK_DEFAULTS, type IkOptions } from '@core/scene/boneIK3d';
import { bakeIk3DEdit, poseIk3DEdit } from './ikEdits';
import { getTime } from '@stores/playbackClockStore';
import { useCompLayersWatch } from './inspectorMirror';
import s from './Ik3DSection.module.css';

const DEG = 180 / Math.PI;

/** Bake the chain against `target` across the whole composition: one engine batch, one undo entry. */
async function bakeChain(chain: string[], target: string, opts: IkOptions): Promise<void> {
  const notify = (level: 'success' | 'warning', message: string): void => {
    useUIStore.getState().notify({ level, message, durationMs: level === 'warning' ? 6000 : 4500 });
  };
  // The active composition's length, read at call time (the engine solves at its own rate).
  const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  const frames = await bakeIk3DEdit(chain, target, 0, Math.max(0, settingsDurationSeconds(settings)), opts);
  if (frames === 0) {
    notify('warning', t('inspector.ik3d.bakeFailed', 'Could not bake — chain or target failed to resolve.'));
    return;
  }
  const joints = chain.length - 1;
  notify('success', joints === 1
    ? t('inspector.ik3d.bakedOne', 'Baked IK: {frames} frames of rotation keyframes on {n} joint.', { frames, n: joints })
    : t('inspector.ik3d.bakedOther', 'Baked IK: {frames} frames of rotation keyframes on {n} joints.', { frames, n: joints }));
}

/** Pose the chain at `target` once, at the playhead: one engine command, one undo entry. */
async function poseAt(chain: string[], target: string, opts: IkOptions): Promise<void> {
  const ok = await poseIk3DEdit(chain, target, getTime(), opts);
  const joints = chain.length - 1;
  if (ok) useUIStore.getState().notify({ level: 'success', message: joints === 1
    ? t('inspector.ik3d.posedOne', 'Posed {n} joint toward the target.', { n: joints })
    : t('inspector.ik3d.posedOther', 'Posed {n} joints toward the target.', { n: joints }), durationMs: 4500 });
}

/** True when this layer can be the tip of a solvable 3D chain. */
export function isIk3DTip(nodeId: string): boolean {
  const m = documentMirror();
  if (!m.layer(nodeId)?.switches.threeD) return false;
  return mirrorIkChainFromTip(m, nodeId).length >= 2;
}

export function Ik3DSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Hooks first, unconditionally — this section vanishes for most layers, and
  // a hook under that guard changes the hook count between renders
  // (conditionalHooks.test.tsx).
  // The chain walks parent headers; the target list is every layer of the comp.
  const layer = useCompLayersWatch(nodeId);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [iterations, setIterations] = useState(IK_DEFAULTS.iterations);
  const [dampingDeg, setDampingDeg] = useState(Math.round(IK_DEFAULTS.maxStepRad * DEG));
  const [tolerance, setTolerance] = useState(IK_DEFAULTS.tolerance);

  if (!layer || !layer.switches.threeD) return null;

  // root→tip; the tip is this layer, so everything before it is a 3D ancestor.
  const m = documentMirror();
  const chain = mirrorIkChainFromTip(m, nodeId);
  if (chain.length < 2) return null;
  const ancestors = chain.length - 1;

  // The chain's own members cannot be the target (aiming a chain at itself is
  // a fixed point, not a pose); `eligibleParents` has already dropped this
  // layer and its descendants.
  const inChain = new Set(chain);
  const options = mirrorEligibleParents(m, nodeId).filter((o) => !inChain.has(o.id));
  const target = targetId && m.layer(targetId) ? targetId : null;
  const targetName = target ? options.find((o) => o.id === target)?.name ?? t('inspector.ik3d.target', 'Target') : t('inspector.ik3d.none', 'None');

  const opts: IkOptions = {
    iterations: Math.max(1, Math.round(iterations)),
    maxStepRad: Math.max(0.01, dampingDeg / DEG),
    tolerance: Math.max(0, tolerance),
  };

  const items: DropdownItem[] = options.map((o): DropdownItem => ({
    type: 'item',
    id: o.id,
    label: o.name,
    ...(o.id === target ? { icon: 'check' as const } : {}),
    onSelect: () => setTargetId(o.id),
  }));

  return (
    <div className={s.stack}>
      <div className={s.row}>
        <span className={s.label}>{t('inspector.ik3d.chain', 'Chain')}</span>
        <span className={s.chain}>
          {ancestors === 1
            ? t('inspector.ik3d.chainSummaryOne', '{n} 3D parent ({joints} joints)', { n: ancestors, joints: chain.length })
            : t('inspector.ik3d.chainSummaryOther', '{n} 3D parents ({joints} joints)', { n: ancestors, joints: chain.length })}
        </span>
      </div>

      <div className={s.row}>
        <span className={s.label}>{t('inspector.ik3d.target', 'Target')}</span>
        <PickWhip
          label={t('inspector.ik3d.pickWhip', 'IK target pick-whip — drag onto the layer the chain should reach for')}
          accept={(pick) => options.some((o) => o.id === pick.nodeId)}
          onPick={(pick) => setTargetId(pick.nodeId)}
        />
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={s.trigger} aria-label={t('inspector.ik3d.targetLayer', 'IK target layer')}>
              <span className={s.triggerValue}>{targetName}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={items}
        />
      </div>

      <span className={s.groupHeader}>{t('inspector.ik3d.solver', 'Solver')}</span>
      <div className={s.row}>
        <span className={s.label}>{t('inspector.ik3d.iterations', 'Iterations')}</span>
        <ValueField
          value={iterations}
          min={1}
          max={64}
          step={1}
          onChange={setIterations}
          aria-label={t('inspector.ik3d.iterationsAria', 'IK iterations')}
        />
      </div>
      <div className={s.row}>
        <span className={s.label}>{t('inspector.ik3d.damping', 'Damping')}</span>
        <ValueField
          value={dampingDeg}
          min={1}
          max={90}
          step={1}
          unit="°"
          onChange={setDampingDeg}
          aria-label={t('inspector.ik3d.dampingAria', 'IK damping')}
        />
      </div>
      <div className={s.row}>
        <span className={s.label}>{t('inspector.ik3d.tolerance', 'Tolerance')}</span>
        <ValueField
          value={tolerance}
          min={0}
          max={50}
          step={0.1}
          precision={1}
          unit="px"
          onChange={setTolerance}
          aria-label={t('inspector.ik3d.toleranceAria', 'IK tolerance')}
        />
      </div>

      <div className={s.actions}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!target}
          onClick={() => { if (target) void poseAt(chain, target, opts); }}
          title={t('inspector.ik3d.poseHint', 'Solve once at the playhead and write the pose onto the joints')}
        >
          {t('inspector.ik3d.pose', 'Pose at target')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!target}
          onClick={() => { if (target) void bakeChain(chain, target, opts); }}
          title={t('inspector.ik3d.bakeHint', 'Solve every frame of the composition and bake rotation keyframes onto the joints')}
        >
          {t('inspector.ik3d.bake', 'Bake to target')}
        </Button>
      </div>

      <p className={s.hint}>
        {target
          ? t('inspector.ik3d.bakeHelpShort', 'Bake writes rotation keys on every joint but the tip.')
          : t('inspector.ik3d.pickHelpShort', 'Pick the layer the chain reaches for.')}
      </p>
    </div>
  );
}

export default Ik3DSection;
