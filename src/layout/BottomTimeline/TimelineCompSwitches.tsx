/**
 * The composition switches After Effects puts in its timeline header
 * (2026-10-07): Hide Shy Layers, Enable Motion Blur (the comp's master switch
 * for every layer with its Motion Blur switch on) and Draft 3D. Each is a
 * toggle lit while on; each was only reachable from a menu before.
 */

import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useUIStore } from '@stores/uiStore';
import { useGuidesStore } from '@stores/guidesStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { useActiveMotionBlur } from '@hooks/useMirrorFrame';
import { edit } from '@core/engine/uiEdits';
import styles from './BottomTimeline.module.css';

export function TimelineCompSwitches(): JSX.Element {
  const globalShy = useUIStore((s) => s.globalShy);
  const setGlobalShy = useUIStore((s) => s.setGlobalShy);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const motionBlur = useActiveMotionBlur().enabled === true;
  const setMotionBlur = (on: boolean): void => {
    // `setCompositionSettings{motionBlur}` (B4), as the Preview menu writes it.
    const comp = activeCompIdNow();
    const mb = comp ? documentMirror().comp(comp)?.settings.motionBlur : undefined;
    if (!comp || !mb) return;
    void edit(on ? 'Enable Motion Blur' : 'Disable Motion Blur', { type: 'setCompositionSettings', comp, patch: { motionBlur: { ...mb, enabled: on } } });
  };
  return (
    <span className={styles.compSwitches} role="group" aria-label="Composition switches">
      <button
        type="button"
        className={cn(styles.compSwitch, globalShy && styles.compSwitchOn)}
        aria-pressed={globalShy}
        aria-label="Hide Shy Layers"
        title={globalShy ? 'Shy layers are hidden — click to show them' : 'Hide all layers with the Shy switch on'}
        onClick={() => setGlobalShy(!globalShy)}
      >
        <Icon name="shy" size="sm" />
      </button>
      <button
        type="button"
        className={cn(styles.compSwitch, motionBlur && styles.compSwitchOn)}
        aria-pressed={motionBlur}
        aria-label="Enable Motion Blur"
        title={motionBlur ? 'Motion blur on for layers with their Motion Blur switch set — click to turn off' : 'Enable motion blur for all layers with the Motion Blur switch set'}
        onClick={() => setMotionBlur(!motionBlur)}
      >
        <Icon name="motion-blur" size="sm" />
      </button>
      <button
        type="button"
        className={cn(styles.compSwitch, draft3d && styles.compSwitchOn)}
        aria-pressed={draft3d}
        aria-label="Draft 3D"
        title={draft3d ? 'Draft 3D on — click for full-quality 3D' : 'Draft 3D: fast preview, skips heavy lights and shadows'}
        onClick={() => toggleDraft3d()}
      >
        <Icon name="draft-3d" size="sm" />
      </button>
    </span>
  );
}
