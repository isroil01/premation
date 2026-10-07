// src/layout/SceneControls/SceneControls.tsx
/**
 * SceneControls — the 3D VIEWPORT NAVIGATION cluster in the toolbar (AE's
 * camera-tool + gizmo-mode group). Nothing else: this bar navigates and
 * manipulates, it does not create.
 *
 * Deliberately NOT here (each had exactly one other, better home):
 *  - Free/Fixed workspace lock → the lock button in the Composition tab
 *    strip (`Tabs/EditorTabs.tsx`).
 *  - Insert camera / light / cube / sphere / cylinder / 3D text → the TopNav
 *    "New layer" dropdown, the single home for creating layers.
 *
 * AE'S TOOLBAR (2026-10-07): the camera tools and the gizmo modes are each one
 * flyout, as AE's are; the axis space is AE's three Local / World / View
 * buttons; Draft 3D and the 3D Ground Plane are AE's two toggle buttons. The
 * rest of the view options stay in one checkbox menu.
 *
 * Earlier note — FOUR MENUS, NOT THIRTEEN BUTTONS. This used to spend thirteen slots of the
 * toolbar on three- and four-way choices where only ONE member of each is in
 * effect at a time: three camera tools, four gizmo modes, three axis spaces.
 * Twelve of those thirteen glyphs were therefore drawing a state you are not
 * in. Each set collapses to a menu whose trigger draws the member that IS in
 * effect — the same pattern the pointer / pen / shape tools next door have
 * always used.
 *
 * The three view toggles are the exception that proves the rule: they are
 * INDEPENDENT booleans, any combination of which can be on, so they share one
 * menu but as checkboxes rather than as a choice.
 *
 * Icon note: orbit/pan/dolly and the ground plane use dedicated glyphs
 * (`orbit`, `pan-camera`, `perspective`, `ground-grid`) instead of borrowing
 * `refresh`/`hand`/`zoom-in`/`grid`, which are the Hand tool, the Zoom tool and
 * the 2D grid overlay elsewhere in this same toolbar.
 */
import { useGuidesStore, type CameraTool, type CameraOrbitPivot, type Gizmo3dState, type Gizmo3dAxisMode } from '@stores/guidesStore';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import styles from './SceneControls.module.css';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useFocusPlaneStore } from '@stores/focusPlaneStore';

const CAMERA_TOOLS: ReadonlyArray<{ id: CameraTool; icon: IconName; label: string }> = [
  // First, like AE: one armed tool, the mouse button picks the gesture.
  { id: 'unified', icon: 'camera', label: 'Unified Camera (left orbit · middle pan · right dolly)' },
  // The orbit PIVOT (cursor / scene / POI) is the option group below the
  // tools — it steers this tool and the unified tool's left-drag alike.
  { id: 'orbit', icon: 'orbit', label: 'Orbit Camera' },
  { id: 'pan', icon: 'pan-camera', label: 'Pan Camera' },
  { id: 'dolly', icon: 'perspective', label: 'Dolly Camera (towards/away)' },
];

/** AE's orbit pivot modes. Radio-style: exactly one is in effect. */
const ORBIT_PIVOTS: ReadonlyArray<{ id: CameraOrbitPivot; label: string }> = [
  { id: 'cursor', label: 'Orbit Around Cursor' },
  { id: 'scene', label: 'Orbit Around Scene' },
  { id: 'poi', label: 'Orbit Around Camera POI' },
];

const GIZMO_MODES: ReadonlyArray<{ id: Gizmo3dState; icon: IconName; label: string }> = [
  { id: 'universal', icon: 'gizmo-universal', label: 'Universal Gizmo (move · rotate · scale)' },
  { id: 'position', icon: 'gizmo-position', label: 'Position Gizmo (move along X, Y, Z axes)' },
  { id: 'scale', icon: 'gizmo-scale', label: 'Scale Gizmo (scale along X, Y, Z axes)' },
  { id: 'rotation', icon: 'gizmo-rotation', label: 'Rotation Gizmo (rotate around X, Y, Z axes)' },
];

/**
 * Which axes the gizmo aligns to.
 *
 * `useGizmo3d` has read `gizmo3dAxisMode` all along (it feeds
 * `Gizmo3D.getGizmoBasis`), but `setGizmo3dAxisMode` had NO caller — so the
 * gizmo was permanently stuck in 'local' and world/view space were unreachable.
 * The engine half was finished; only the switch was missing.
 *
 * These were the bare letters L / W / V, on the argument that three axis glyphs
 * differing only in ORIENTATION would be harder to tell apart than initials.
 * That is true, and it is why the glyphs do not differ in orientation: one
 * tripod, three frames around it. See `axis-local` in the icon generator.
 */
const AXIS_MODES: ReadonlyArray<{ id: Gizmo3dAxisMode; icon: IconName; label: string }> = [
  { id: 'local', icon: 'axis-local', label: 'Local axes — aligned to the layer' },
  { id: 'world', icon: 'axis-world', label: 'World axes — aligned to the composition' },
  { id: 'view', icon: 'axis-view', label: 'View axes — aligned to the camera' },
];

export function SceneControls(): JSX.Element {
  const cameraTool = useGuidesStore((s) => s.cameraTool);
  const setCameraTool = useGuidesStore((s) => s.setCameraTool);
  const cameraOrbitPivot = useGuidesStore((s) => s.cameraOrbitPivot);
  const setCameraOrbitPivot = useGuidesStore((s) => s.setCameraOrbitPivot);
  const gizmo3dState = useGuidesStore((s) => s.gizmo3dState);
  const setGizmo3dState = useGuidesStore((s) => s.setGizmo3dState);
  const gizmo3dAxisMode = useGuidesStore((s) => s.gizmo3dAxisMode);
  const setGizmo3dAxisMode = useGuidesStore((s) => s.setGizmo3dAxisMode);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const toggleGroundGridVisible = useGuidesStore((s) => s.toggleGroundGridVisible);
  // A preference, not view state — see `Preferences.showLayerBounds`.
  const layerBoxesVisible = usePreferenceStore((s) => s.showLayerBounds);
  const setPreference = usePreferenceStore((s) => s.set);
  const toggleLayerBoxesVisible = (): void => setPreference('showLayerBounds', !layerBoxesVisible);
  const deviceWireframesAll = usePreferenceStore((s) => s.deviceWireframesAll);
  const toggleDeviceWireframesAll = (): void => setPreference('deviceWireframesAll', !deviceWireframesAll);

  const armedCamera = CAMERA_TOOLS.find((t) => t.id === cameraTool);
  const gizmo = GIZMO_MODES.find((g) => g.id === gizmo3dState) ?? GIZMO_MODES[0]!;
  const focusPlaneVisibility = useFocusPlaneStore((s) => s.visibility);
  const setFocusPlaneVisibility = useFocusPlaneStore((s) => s.setVisibility);
  const focusPlaneOn = focusPlaneVisibility !== 'off';
  // The focus plane defaults ON, so it does not count toward lighting the
  // trigger — a button that is lit in a fresh project is saying nothing.
  const viewOnCount = [layerBoxesVisible, deviceWireframesAll].filter(Boolean).length;

  const cameraItems: DropdownItem[] = [
    ...CAMERA_TOOLS.map((t) => ({
      type: 'item' as const,
      id: `cam-${t.id}`,
      label: t.label,
      icon: t.icon,
      onSelect: () => setCameraTool(t.id),
    })),
    { type: 'separator' },
    // Orbit pivot — a radio group in checkbox rows (exactly one is on;
    // picking one re-points the orbit gesture, it does not arm a tool).
    ...ORBIT_PIVOTS.map((p) => ({
      type: 'checkbox' as const,
      id: `cam-pivot-${p.id}`,
      label: p.label,
      checked: cameraOrbitPivot === p.id,
      onChange: () => setCameraOrbitPivot(p.id),
    })),
    { type: 'separator' },
    // The buttons armed on click and DISARMED on a second click. A menu item
    // cannot carry that: picking the row you already picked reading as "turn it
    // off" is a guess, not an affordance. So the release gets its own row, and
    // greys out when there is nothing to release.
    {
      type: 'item',
      id: 'cam-none',
      label: 'Release camera tool',
      icon: 'close',
      disabled: cameraTool === 'none',
      onSelect: () => setCameraTool('none'),
    },
  ];

  return (
    <div className={styles.sceneControls} data-tour="scene-3d">
      {/* Camera navigation — Alt uses one temporarily, C cycles. */}
      <Dropdown
        placement="bottom-start"
        items={cameraItems}
        trigger={
          <button
            type="button"
            className={armedCamera ? styles.triggerActive : styles.trigger}
            aria-label="Camera tool"
            title={
              armedCamera
                ? `${armedCamera.label} (active) — hold Alt to use temporarily, C to cycle`
                : 'Camera tool — none armed. Hold Alt to use one temporarily, C to cycle'
            }
          >
            <Icon name={armedCamera?.icon ?? 'orbit'} size="md" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
      />

      <div className={styles.divider} />

      {/* 3D gizmo mode for the selection. */}
      <Dropdown
        placement="bottom-start"
        items={GIZMO_MODES.map((g) => ({
          type: 'item' as const,
          id: `gizmo-${g.id}`,
          label: g.label,
          icon: g.icon,
          onSelect: () => setGizmo3dState(g.id),
        }))}
        trigger={
          <button
            type="button"
            className={styles.trigger}
            aria-label="Gizmo mode"
            title={`Gizmo mode — ${gizmo.label}`}
          >
            <Icon name={gizmo.icon} size="md" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
      />

      {/* Axis space for the gizmo above — AE's Local / World / View Axis Mode,
          three buttons side by side as in AE's toolbar (exactly one is lit). */}
      <div className={styles.axisModes} role="radiogroup" aria-label="Axis space">
        {AXIS_MODES.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={gizmo3dAxisMode === a.id}
            className={gizmo3dAxisMode === a.id ? styles.triggerActive : styles.trigger}
            aria-label={a.label}
            title={a.label}
            onClick={() => setGizmo3dAxisMode(a.id)}
          >
            <Icon name={a.icon} size="md" />
          </button>
        ))}
      </div>

      <div className={styles.divider} />

      {/* AE's Draft 3D and 3D Ground Plane toggles, as their own buttons. */}
      <button
        type="button"
        className={draft3d ? styles.triggerActive : styles.trigger}
        aria-label="Draft 3D"
        aria-pressed={draft3d}
        title="Draft 3D — fast preview, skips heavy lights & shadows"
        onClick={() => toggleDraft3d()}
      >
        <Icon name="draft-3d" size="md" />
      </button>
      <button
        type="button"
        className={groundGridVisible ? styles.triggerActive : styles.trigger}
        aria-label="3D ground plane"
        aria-pressed={groundGridVisible}
        title="3D ground plane"
        onClick={() => toggleGroundGridVisible()}
      >
        <Icon name="ground-grid" size="md" />
      </button>

      {/*
        Reference geometry. Checkboxes rather than a choice:
        any combination can be on.
      */}
      <Dropdown
        placement="bottom-start"
        items={[
          {
            type: 'checkbox',
            id: 'view-layer-boxes',
            label: 'Layer bounding boxes',
            checked: layerBoxesVisible,
            onChange: () => toggleLayerBoxesVisible(),
          },
          {
            type: 'checkbox',
            id: 'view-device-wireframes',
            label: 'Camera & light wireframes for unselected layers',
            checked: deviceWireframesAll,
            onChange: () => toggleDeviceWireframesAll(),
          },
          { type: 'separator' },
          // The focus plane is three-valued in its store (off / selected /
          // always) but reads as two decisions here: whether to draw it at
          // all, and whether the ACTIVE camera counts or only a selected one.
          {
            type: 'checkbox',
            id: 'view-focus-plane',
            label: 'Camera focus plane',
            checked: focusPlaneOn,
            onChange: (on) => setFocusPlaneVisibility(on ? 'always' : 'off'),
          },
          {
            type: 'checkbox',
            id: 'view-focus-plane-selected-only',
            label: 'Focus plane only for the selected camera',
            checked: focusPlaneVisibility === 'selected',
            disabled: !focusPlaneOn,
            onChange: (only) => setFocusPlaneVisibility(only ? 'selected' : 'always'),
          },
        ]}
        trigger={
          <button
            type="button"
            className={viewOnCount > 0 ? styles.triggerActive : styles.trigger}
            aria-label="3D view options"
            title="3D view — layer bounding boxes, camera & light wireframes, focus plane"
          >
            <Icon name="cube" size="md" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
      />
    </div>
  );
}
