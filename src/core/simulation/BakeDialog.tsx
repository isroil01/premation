/**
 * The bake dialog — one component, two bakes.
 *
 * Range and sample step are the same question whether you are freezing a rigid
 * body or an emitter, so they are asked the same way; the particle-only field
 * (the layer cap) appears only when there is a cap to set. Two near-identical
 * dialogs in two Inspector sections would have drifted the first time either
 * was touched.
 *
 * It opens on the DEFAULTS the command would have used — the work area when one
 * is set, else the whole composition, every frame — so the fast path is open,
 * confirm, done, and the fields are there for the times that is not what you
 * meant.
 *
 * Lives beside the bake rather than in `components/` because it has no other
 * caller and no life of its own: it is the bake's argument list rendered.
 */

import { useState } from 'react';
import { Modal } from '@components/Modal';
import { Button } from '@components/Button';
import { PropertyRow } from '@components/PropertyRow';
import { ValueField } from '@components/ValueField';
import { defaultBakeRange } from './bakeCommands';
import { DEFAULT_PARTICLE_BAKE_CAP, type BakeRangeOptions } from './bakeDynamics';

export interface BakeDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Show the per-particle layer cap (the particle bake only). */
  withParticleCap?: boolean;
  onBake: (opts: BakeRangeOptions & { maxParticles?: number }) => void;
}

export function BakeDialog({
  open,
  onClose,
  title,
  withParticleCap = false,
  onBake,
}: BakeDialogProps): JSX.Element | null {
  // Read the defaults when the dialog MOUNTS, which — because the sections
  // render it only while open — means every opening re-reads the work area.
  // Holding them in state across closes would offer last week's range.
  const initial = defaultBakeRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [everyN, setEveryN] = useState(1);
  const [tolerance, setTolerance] = useState(0);
  const [cap, setCap] = useState(DEFAULT_PARTICLE_BAKE_CAP);

  if (!open) return null;

  const fps = initial.fps;
  const frames = Math.max(0, Math.round((to - from) * fps));
  const sampled = everyN > 0 ? Math.floor(frames / everyN) + 1 : frames + 1;

  const bake = (): void => {
    onBake({
      from: Math.max(0, Math.min(from, to)),
      to: Math.max(from, to),
      fps,
      everyNFrames: Math.max(1, Math.round(everyN)),
      simplifyTolerance: Math.max(0, tolerance),
      ...(withParticleCap ? { maxParticles: Math.max(1, Math.round(cap)) } : {}),
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={bake} disabled={to <= from}>Bake</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <PropertyRow label="Start" compact>
          <ValueField value={from} unit="s" min={0} precision={3} onChange={setFrom} aria-label="Bake range start" />
        </PropertyRow>
        <PropertyRow label="End" compact>
          <ValueField value={to} unit="s" min={0} precision={3} onChange={setTo} aria-label="Bake range end" />
        </PropertyRow>
        <PropertyRow label="Every N Frames" compact>
          <ValueField value={everyN} min={1} precision={0} onChange={setEveryN} aria-label="Sample every N frames" />
        </PropertyRow>
        <PropertyRow label="Simplify" compact>
          <ValueField value={tolerance} unit="px" min={0} precision={2} onChange={setTolerance} aria-label="Simplify tolerance" />
        </PropertyRow>
        {withParticleCap && (
          <PropertyRow label="Max Layers" compact>
            <ValueField value={cap} min={1} precision={0} onChange={setCap} aria-label="Maximum particle layers" />
          </PropertyRow>
        )}
        <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
          {`${frames} frames in range → about ${sampled} keyframes per track before simplification.`}
          {withParticleCap
            ? ' The emitter is hidden and the baked layers are parented under a new null.'
            : ' Physics is switched off on the baked layers so the keyframes drive them.'}
        </p>
      </div>
    </Modal>
  );
}

export default BakeDialog;
