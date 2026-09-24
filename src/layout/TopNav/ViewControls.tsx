/**
 * The Preview menu, and the 3D-view labels it shares with the viewport.
 *
 * This file used to be the whole "View Options" surface — a dropdown of
 * grid / rulers / channel / layout / motion paths / auto-keyframe rows, the
 * zoom field, and the Preview menu — rendered inside the transport bar. Every
 * one of those rows had a second home somewhere else, which is why nobody
 * could find the channel picker. The View Options menu is gone: its display
 * rows live in the display controls in the transport row under the stage
 * (`Workspace/ViewportDisplayControls.tsx`), the zoom field is
 * `Workspace/ZoomField.tsx`, and Motion Paths / Auto-Keyframe are the buttons
 * that already existed in `ViewportTools`.
 *
 * What is left is what the display controls import: `PreviewMenu` and the
 * 3D-view labels — `CAMERA_VIEW_LABEL`, `cameraViewLabel` and the per-comp
 * camera-view list every view picker shares.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useMirrorSelect } from '@hooks/useMirror';
import { mirrorLookThroughCamera, mirrorLookThroughCameras } from '@core/mirror/cameras';
import { cameraViewMode, cameraViewNodeId, isCameraViewMode, type CameraViewMode } from '@core/scene/cameraViewMode';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  useRenderQualityStore,
  RESOLUTION_LABELS,
  type AdaptiveFloor,
} from '@stores/renderQualityStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { Dropdown, type DropdownItem, type DropdownProps } from '@components/Dropdown';
import { OnionSkinSettingsPopover } from '@layout/BottomTimeline/OnionSkinSettings';
import { cacheWorkAreaNow, installPreviewCacheCommands } from '@layout/Timeline/previewCacheCommands';
import { describePreviewCache, previewCacheStats } from '@layout/Timeline/previewCacheStats';
import styles from './TopNav.module.css';

/**
 * Human labels for the FIXED 3D view modes. A camera view has no fixed label —
 * it is named after its camera layer — so it is not a key here; go through
 * `cameraViewLabel`, which covers every mode.
 */
export const CAMERA_VIEW_LABEL: Record<Exclude<Camera3dMode, CameraViewMode>, string> = {
  active: 'Active Camera', front: 'Front', back: 'Back',
  left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom',
  ...CUSTOM_VIEW_LABEL,
};

/** A camera layer's name as a menu shows it — a blank name is still a row. */
function cameraName(name: string | undefined): string {
  return name && name.trim() ? name : 'Camera';
}

function compRootOr(rootId?: string): string | undefined {
  return rootId ?? activeCompIdNow();
}

/**
 * The mode a view is EFFECTIVELY in. A camera view whose camera can no longer
 * be looked through renders as the Active Camera (`viewCameraNode`), so it is
 * labelled and ticked as one too — a menu still ticking a deleted camera would
 * claim a view the frame is not showing.
 */
export function effectiveViewMode(mode: Camera3dMode, rootId?: string): Camera3dMode {
  if (!isCameraViewMode(mode)) return mode;
  return mirrorLookThroughCamera(documentMirror(), cameraViewNodeId(mode), compRootOr(rootId)) ? mode : 'active';
}

/** The label for ANY view mode — a camera view by its layer's name. */
export function cameraViewLabel(mode: Camera3dMode, rootId?: string): string {
  if (!isCameraViewMode(mode)) return CAMERA_VIEW_LABEL[mode];
  const node = mirrorLookThroughCamera(documentMirror(), cameraViewNodeId(mode), compRootOr(rootId));
  return node ? cameraName(node.name) : CAMERA_VIEW_LABEL.active;
}

export interface CameraViewOption {
  nodeId: string;
  mode: CameraViewMode;
  label: string;
}

/**
 * The camera views a comp offers — one per enabled camera, topmost first, by
 * layer name (AE's 3D View list) — re-listed only when that list changes.
 *
 * Subscribes to a SIGNATURE of the list rather than to the scene revision. The
 * transport row hosts this, and a drag bumps the revision once per pointer
 * event: re-rendering the whole row per bump to rebuild a list that almost
 * never changes would be pure waste. The selector still runs per bump, but it
 * is one walk of the comp and a string compare.
 */
export function useCompCameraViews(rootId: string): CameraViewOption[] {
  const signature = useMirrorSelect(['doc'], (m) =>
    JSON.stringify(mirrorLookThroughCameras(m, rootId).map((l) => [l.id, cameraName(l.name)])),
  );
  return useMemo(
    () =>
      (JSON.parse(signature) as Array<[string, string]>).map(([nodeId, label]) => ({
        nodeId,
        mode: cameraViewMode(nodeId),
        label,
      })),
    [signature],
  );
}

/**
 * Live cache coverage, as the Preview menu's header line.
 *
 * Its own component so the sampling lives — and only lives — inside the open
 * menu: `Popover` mounts its children on open and unmounts them on close, so
 * this timer exists for exactly as long as somebody is reading it. Putting the
 * same numbers in `PreviewMenu`'s render would have made a control in the
 * chrome re-render twice a second, for ever, to keep a string nobody was
 * looking at up to date.
 */
function PreviewCacheHeader(): JSX.Element {
  const [stats, setStats] = useState(previewCacheStats);
  useEffect(() => {
    const id = setInterval(() => setStats(previewCacheStats()), 500);
    return () => clearInterval(id);
  }, []);
  return <>{describePreviewCache(stats)}</>;
}

/**
 * The Preview menu's rows — exported so the tabs row can list them under an
 * overflow `⋯` submenu when it has had to shed the trigger.
 *
 * Resolution is NOT here. The four fixed resolutions have exactly one control,
 * the Resolution dropdown beside this menu; what stays is the rule about them
 * (Auto / adaptive floor) and everything else that trades fidelity for speed.
 */
export function usePreviewMenuItems(): { items: DropdownItem[]; degraded: boolean } {
  const useProxies = usePreferenceStore((p) => p.useProxies);
  const setPreference = usePreferenceStore((p) => p.set);
  const resolution = useRenderQualityStore((s) => s.resolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const setAdaptive = useRenderQualityStore((s) => s.setAdaptive);
  const adaptiveFloor = useRenderQualityStore((s) => s.adaptiveFloor);
  const setAdaptiveFloor = useRenderQualityStore((s) => s.setAdaptiveFloor);
  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);

  const motionBlur = useMotionBlurStore((s) => s.enabled);
  const setMotionBlur = useMotionBlurStore((s) => s.setEnabled);

  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);

  const onionEnabled = useOnionSkinStore((s) => s.enabled);
  const toggleOnion = useOnionSkinStore((s) => s.toggle);

  const roi = useGuidesStore((s) => s.roi);
  const setRoi = useGuidesStore((s) => s.setRoi);
  // Set the ROI to the composition's centre half — a sensible starting region
  // the user then drags to taste on the canvas.
  const setCentreRoi = (): void => {
    const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
    const comp = { width: settings?.width ?? 1920, height: settings?.height ?? 1080 };
    setRoi({ x: Math.round(comp.width / 4), y: Math.round(comp.height / 4), width: Math.round(comp.width / 2), height: Math.round(comp.height / 2) });
  };

  // The cache actions are commands as well as buttons, so the palette and any
  // future menu row can reach them even with the timeline panel collapsed —
  // the cache lane's own group, which also installs them, unmounts with it.
  useEffect(() => {
    installPreviewCacheCommands();
  }, []);

  /** On when the viewport is showing something cheaper than the real thing. */
  const degraded = resolution !== 1 || draftQuality || draft3d;

  const items: DropdownItem[] = [
    { type: 'label', label: <PreviewCacheHeader /> },
    {
      type: 'item',
      id: 'preview-cache-now',
      label: 'Cache Work Area Now',
      icon: 'refresh',
      onSelect: cacheWorkAreaNow,
    },
    { type: 'separator' },
    {
      /*
        "Auto" IS the adaptive-resolution flag: not a fifth fixed resolution
        but a rule about the four in the Resolution dropdown — drop to the
        floor while a drag is in flight or playback is measured slow, never
        below what the user picked.
      */
      type: 'checkbox',
      id: 'res-auto',
      label: `Auto resolution — drop to ${RESOLUTION_LABELS[adaptiveFloor]} while dragging or when playback is slow`,
      checked: adaptive,
      onChange: setAdaptive,
    },
    {
      type: 'item',
      id: 'res-floor',
      label: `Auto floor: ${RESOLUTION_LABELS[adaptiveFloor]}`,
      disabled: !adaptive,
      submenu: ([2, 3, 4] as AdaptiveFloor[]).map<DropdownItem>((f) => ({
        type: 'checkbox',
        id: `res-floor-${f}`,
        label: RESOLUTION_LABELS[f],
        checked: adaptiveFloor === f,
        onChange: () => setAdaptiveFloor(f),
      })),
    },
    {
      // Proxies substitute pixels in the viewport only; export always
      // decodes the original, by construction (see proxyManager).
      type: 'checkbox',
      id: 'preview-use-proxies',
      label: 'Use proxies — faster scrubbing, never in output',
      checked: useProxies,
      onChange: (v) => setPreference('useProxies', v),
    },
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'preview-motion-blur',
      label: 'Motion Blur',
      checked: motionBlur,
      onChange: setMotionBlur,
    },
    {
      /*
        The composition-wide motion-blur gate above and this one are a pair:
        Draft Quality skips the multi-sample pass, so motion blur can be ON and
        still cost nothing.
      */
      type: 'checkbox',
      id: 'preview-draft-quality',
      label: 'Draft Quality — skip motion-blur samples',
      checked: draftQuality,
      onChange: setDraftQuality,
    },
    {
      type: 'checkbox',
      id: 'preview-draft-3d',
      label: 'Draft 3D — skip heavy lights & shadows',
      checked: draft3d,
      onChange: () => toggleDraft3d(),
    },
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'preview-onion-skin',
      label: 'Onion Skin — ghosts of nearby frames, while paused',
      checked: onionEnabled,
      onChange: () => toggleOnion(),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'preview-roi',
      label: roi ? 'Region of Interest: on' : 'Region of Interest',
      submenu: [
        // Drag the region on the canvas after setting it (the handles are
        // painted by the renderer); these are the quick set/clear entries.
        { type: 'checkbox', id: 'roi-on', label: 'Restrict to Region', checked: !!roi, onChange: (on: boolean) => (on ? setCentreRoi() : setRoi(null)) },
        { type: 'item', id: 'roi-centre', label: 'Region to Centre', onSelect: setCentreRoi },
        { type: 'item', id: 'roi-clear', label: 'Clear Region', disabled: !roi, onSelect: () => setRoi(null) },
      ],
    },
  ];

  return { items, degraded };
}

export interface PreviewMenuProps {
  /** The trigger's class while nothing is degraded. Defaults to the TopNav tool trigger. */
  className?: string;
  /** The trigger's class while the viewport shows something cheaper than the real thing. */
  activeClassName?: string;
  placement?: DropdownProps['placement'];
}

/**
 * The Preview menu — the one home for what the viewport spends its pixels on.
 *
 * Adaptive resolution, proxies, motion blur, draft quality, draft 3D, onion
 * skin, region of interest and the cache actions. They are all the same kind
 * of setting — fidelity traded for speed — and they are all here.
 *
 * Draft 3D is deliberately a MIRROR: the 3D menu in `SceneControls` still owns
 * it for people working in that menu, and both read the same store, so neither
 * copy can drift.
 */
export function PreviewMenu({ className, activeClassName, placement = 'bottom-start' }: PreviewMenuProps): JSX.Element {
  const { items, degraded } = usePreviewMenuItems();
  const onionEnabled = useOnionSkinStore((s) => s.enabled);

  return (
    <>
      <Dropdown
        placement={placement}
        trigger={
          <button
            type="button"
            className={degraded ? (activeClassName ?? styles.toolDropdownTriggerActive) : (className ?? styles.toolDropdownTrigger)}
            title="Preview quality, motion blur, onion skin, region of interest"
            aria-label="Preview"
          >
            <Icon name="tv" size="sm" />
            <Icon name="chevron-down" size="sm" className={styles.triggerChevron} />
          </button>
        }
        items={items}
      />

      {/*
        Onion skin's before / after / step / opacity, in the popover the
        timeline's switch row used to carry. Only while onion skinning is ON:
        these are working values you change WHILE looking at the ghosts, so with
        the feature off the chevron is a permanent button for a panel that
        cannot show you anything.
      */}
      {onionEnabled && <OnionSkinSettingsPopover className={className ?? styles.tool} />}
    </>
  );
}
