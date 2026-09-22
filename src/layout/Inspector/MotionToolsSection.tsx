/**
 * Motion tools — the two ways to drive a property over time without drawing
 * keyframes: the modifier stack and the audio driver, in one section.
 *
 * They were two top-level sections that, between them, WERE the old
 * "Animation" sub-tab. Both apply to exactly the same layers (anything with an
 * animatable numeric property — the two `has…` predicates ask the same
 * question), both are advanced tools most layers never use, and two collapsed
 * headers for them pushed Morph targets and 3D IK further down for nothing. One
 * collapsed header, two small subheads.
 */

import { useNodeRevision } from '@hooks/useNodeRevision';
import { AudioDriverSection, hasAudioDriverSection } from './AudioDriverSection';
import { ModifierStackSection, hasModifierStackSection } from './ModifierStackSection';
import styles from './MotionToolsSection.module.css';

/** Registry predicate: either tool has something to drive on this layer. */
export function hasMotionToolsSection(nodeId: string): boolean {
  return hasModifierStackSection(nodeId) || hasAudioDriverSection(nodeId);
}

export function MotionToolsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Before any early return — the hook count must not depend on the node, and
  // the predicates below have to be asked again when the layer changes.
  useNodeRevision(nodeId);
  const modifiers = hasModifierStackSection(nodeId);
  const driver = hasAudioDriverSection(nodeId);
  if (!modifiers && !driver) return null;

  return (
    <div className={styles.root}>
      {modifiers && (
        <section className={styles.group} aria-label="Modifiers">
          <h4 className={styles.subhead}>Modifiers</h4>
          <ModifierStackSection nodeId={nodeId} />
        </section>
      )}
      {driver && (
        <section className={styles.group} aria-label="Audio driver">
          <h4 className={styles.subhead}>Audio driver</h4>
          <AudioDriverSection nodeId={nodeId} />
        </section>
      )}
    </div>
  );
}

export default MotionToolsSection;
