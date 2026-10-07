/**
 * The composition switches in the timeline header (2026-10-07): Hide Shy
 * Layers and Enable Motion Blur — AE's two — and Auto-Keyframe, the timeline's
 * recording mode (AE keeps it in the Timeline panel menu; here it needs a
 * lit state you can see while you drag, so it is a switch). Each is a toggle
 * lit while on.
 *
 * Draft 3D is not here: it is the Composition panel's button (AE 2022+, the
 * viewer's 3D cluster) and a Preview menu row.
 */

import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useUIStore } from '@stores/uiStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { useActiveMotionBlur } from '@hooks/useMirrorFrame';
import { edit } from '@core/engine/uiEdits';
import styles from './BottomTimeline.module.css';

export function TimelineCompSwitches(): JSX.Element {
  const globalShy = useUIStore((s) => s.globalShy);
  const setGlobalShy = useUIStore((s) => s.setGlobalShy);
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
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
        className={cn(styles.compSwitch, autoKeyframe && styles.compSwitchOn, autoKeyframe && styles.compSwitchRec)}
        aria-pressed={autoKeyframe}
        aria-label="Auto-Keyframe mode"
        title={autoKeyframe ? 'Auto-Keyframe is ON — every change sets a keyframe (click to turn off)' : 'Auto-Keyframe: set a keyframe whenever a property changes'}
        onClick={() => usePreferenceStore.getState().set('timelineAutoKeyframe', !autoKeyframe)}
      >
        <Icon name="stopwatch" size="sm" />
      </button>
    </span>
  );
}
