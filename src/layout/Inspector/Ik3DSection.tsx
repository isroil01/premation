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
 * Pose calls `poseIk3DAtTarget` — the SAME function the palette command
 * executes. Bake is the engine route (B3z): the same solve
 * (`planIk3DBake`, which the palette's `bakeIk3DToTarget` also runs) sent as
 * ONE batch of keyframe commands (ikEdits.ts) — one undo entry. The solver
 * options exposed here (iterations, damping, tolerance) are the real
 * `IkOptions`; leaving them at the defaults reproduces the palette's solve.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { PickWhip } from '@components/PickWhip';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { edit } from '@core/engine/uiEdits';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { eligibleParents } from '@core/scene/parenting';
import { is3DEnabled } from '@core/scene/threeD';
import { ikChainFromTip, IK_DEFAULTS, type IkOptions } from '@core/scene/boneIK3d';
import { poseIk3DAtTarget } from '@core/scene/ikCommands';
import { ik3DBakeCommands } from './ikEdits';
import s from './Ik3DSection.module.css';

const DEG = 180 / Math.PI;

/** Bake the chain against `target` across the whole composition: one engine batch, one undo entry. */
async function bakeChain(chain: string[], target: string, opts: IkOptions): Promise<void> {
  const notify = (level: 'success' | 'warning', message: string): void => {
    useUIStore.getState().notify({ level, message, durationMs: level === 'warning' ? 6000 : 4500 });
  };
  const comp = useCompositionStore.getState();
  const fps = comp.fps > 0 ? comp.fps : 30;
  const plan = await ik3DBakeCommands(chain, target, 0, Math.max(0, comp.durationSeconds), fps, opts);
  if (!plan) {
    notify('warning', 'Could not bake — chain or target failed to resolve.');
    return;
  }
  const res = await edit('Bake 3D IK', plan.commands);
  if (!res.ok) return;
  const joints = chain.length - 1;
  notify('success', `Baked IK: ${plan.frames} frames of rotation keyframes on ${joints} joint${joints === 1 ? '' : 's'}.`);
}

/** True when this layer can be the tip of a solvable 3D chain. */
export function isIk3DTip(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !is3DEnabled(node)) return false;
  return ikChainFromTip(nodeId).length >= 2;
}

export function Ik3DSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Hooks first, unconditionally — this section vanishes for most layers, and
  // a hook under that guard changes the hook count between renders
  // (conditionalHooks.test.tsx).
  useSceneRevision((st) => st.rev);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [iterations, setIterations] = useState(IK_DEFAULTS.iterations);
  const [dampingDeg, setDampingDeg] = useState(Math.round(IK_DEFAULTS.maxStepRad * DEG));
  const [tolerance, setTolerance] = useState(IK_DEFAULTS.tolerance);

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !is3DEnabled(node)) return null;

  // root→tip; the tip is this layer, so everything before it is a 3D ancestor.
  const chain = ikChainFromTip(nodeId);
  if (chain.length < 2) return null;
  const ancestors = chain.length - 1;

  // The chain's own members cannot be the target (aiming a chain at itself is
  // a fixed point, not a pose); `eligibleParents` has already dropped this
  // layer and its descendants.
  const inChain = new Set(chain);
  const options = eligibleParents(nodeId).filter((o) => !inChain.has(o.id));
  const target = targetId && defaultSceneGraph.getNode(targetId) ? targetId : null;
  const targetName = target ? options.find((o) => o.id === target)?.name ?? 'Target' : 'None';

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
        <span className={s.label}>Chain</span>
        <span className={s.chain}>
          {ancestors} 3D parent{ancestors === 1 ? '' : 's'} ({chain.length} joints)
        </span>
      </div>

      <div className={s.row}>
        <span className={s.label}>Target</span>
        <PickWhip
          label="IK target pick-whip — drag onto the layer the chain should reach for"
          accept={(t) => options.some((o) => o.id === t.nodeId)}
          onPick={(t) => setTargetId(t.nodeId)}
        />
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={s.trigger} aria-label="IK target layer">
              <span className={s.triggerValue}>{targetName}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={items}
        />
      </div>

      <span className={s.groupHeader}>Solver</span>
      <div className={s.row}>
        <span className={s.label}>Iterations</span>
        <ValueField
          value={iterations}
          min={1}
          max={64}
          step={1}
          onChange={setIterations}
          aria-label="IK iterations"
        />
      </div>
      <div className={s.row}>
        <span className={s.label}>Damping</span>
        <ValueField
          value={dampingDeg}
          min={1}
          max={90}
          step={1}
          unit="°"
          onChange={setDampingDeg}
          aria-label="IK damping"
        />
      </div>
      <div className={s.row}>
        <span className={s.label}>Tolerance</span>
        <ValueField
          value={tolerance}
          min={0}
          max={50}
          step={0.1}
          precision={1}
          unit="px"
          onChange={setTolerance}
          aria-label="IK tolerance"
        />
      </div>

      <div className={s.actions}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!target}
          onClick={() => { if (target) poseIk3DAtTarget(chain, target, opts); }}
          title="Solve once at the playhead and write the pose onto the joints"
        >
          Pose at target
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!target}
          onClick={() => { if (target) void bakeChain(chain, target, opts); }}
          title="Solve every frame of the composition and bake rotation keyframes onto the joints"
        >
          Bake to target
        </Button>
      </div>

      <p className={s.hint}>
        {target
          ? 'Bake writes real rotation keyframes on every joint but the tip — the graph editor and The Smoother work on them like any other animation.'
          : 'Pick the layer the chain should reach for. Damping is the largest turn one joint takes per solver step.'}
      </p>
    </div>
  );
}

export default Ik3DSection;
