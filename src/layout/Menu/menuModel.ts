/**
 * Application menu model — a data-driven map of menu groups → items, each
 * bound to a command id. This is the extension point: future engines append
 * items (or whole groups) here, and the CommandRegistry supplies the label /
 * enabled state / shortcut, so the menu bar stays a thin renderer.
 *
 * SHAPE. Each top-level group is meant to fit on screen without scrolling —
 * roughly what After Effects and Premiere manage: the handful of entries a
 * user reaches for constantly stay at the top level, and every long family
 * (five reframe aspects, five caption verbs, eight keyframe assistants…)
 * collapses into a parent carrying `children`. `menuSubmenus.test.ts` pins
 * the ceiling, so a group that grows past it has to fold something rather
 * than run off the bottom of the window again.
 */

import { BuiltinCommands } from '@core/commands/Command';
import { cloudProjectsEnabled } from '@core/config/edition';
// `tryCoreServices`, not `getFileManager`: this model's `visible` predicates are
// evaluated wherever the menu renders, and TitleBar renders on /login and
// /dashboard, where the core has not booted. `coreServices()` throws there.
import { tryCoreServices } from '@core/services/coreServices';
import { buildWorkspaceMenuItems } from './workspaceMenu';
import { pluginPanelMenuItems } from './pluginPanelsMenu';

/** Project-lifecycle command ids (registered against ProjectManager at boot). */
export const ProjectCommands = {
  New: 'project.new',
  Open: 'project.open',
  Save: 'project.save',
  SaveAs: 'project.saveAs',
  SaveToComputer: 'project.saveToComputer',
  /**
   * Fork the project on the SERVER. This is what Save As did in the cloud
   * editor, which is why Save As could not write a file to the user's machine
   * there. Split out so both things exist and each says what it does.
   */
  SaveCopyToCloud: 'project.saveCopyToCloud',
  IncrementAndSave: 'project.incrementAndSave',
  /**
   * End-to-end encrypted sync of the open `.motion` bundle.
   *
   * The whole stack — cipher, chunk diff, three-way reconcile, HTTP transport,
   * and the `/api/sync` endpoints behind it — shipped without a single way to
   * invoke it. This is that way.
   */
  Sync: 'project.sync',
  Close: 'project.close',
  About: 'help.about',
} as const;

export interface MenuItemModel {
  commandId?: string;
  /** Overrides the command's label. */
  label?: string;
  separator?: boolean;
  /**
   * A nested menu. Either a fixed list, or a thunk evaluated by the RENDERER
   * every time the menu is drawn — which is what a submenu built from user data
   * needs (see `workspaceMenu.ts`: saving a layout must make it appear without
   * a reload, and `useAppMenuGroups` memoises).
   *
   * A parent carrying `children` needs no `commandId`; it is not itself an
   * action, so the renderers must not grey it out for lacking one.
   */
  children?: ReadonlyArray<MenuItemModel> | (() => ReadonlyArray<MenuItemModel>);
  /**
   * A direct action, for entries that CANNOT be commands — a workspace the user
   * invented at runtime has no registration to point at. Ignored when
   * `commandId` is set; the registry stays the single source for anything that
   * can live in it (label, enabled state, shortcut, palette entry).
   */
  onSelect?: () => void;
  /** Checked state for an `onSelect` entry. Command-backed items use `Command.isChecked`. */
  checked?: () => boolean;
  /**
   * Hide the item entirely when this returns false. Evaluated per render by
   * `useAppMenuGroups`, which also collapses the separators left behind.
   *
   * For EDITION differences, not for enabled/disabled state — a command that
   * exists but cannot run right now should stay visible and grey out, which is
   * what `Command.enabled` already does. This is for entries whose command is
   * never registered in this build, and which would otherwise sit permanently
   * disabled next to items that work.
   */
  visible?: () => boolean;
}

export interface MenuGroupModel {
  id: string;
  label: string;
  items: MenuItemModel[];
}

/**
 * Label of the Layer ▸ New submenu. `useAppMenuGroups` appends plugin layer
 * kinds inside it, so the two files agree on the name through this constant
 * rather than through a string that has to be kept in step by hand.
 */
export const LAYER_NEW_SUBMENU_LABEL = 'New';

export const APP_MENU: MenuGroupModel[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { commandId: ProjectCommands.New, label: 'New Project' },
      { commandId: ProjectCommands.Open, label: 'Open Project…' },
      // Next to Open, not under Import: what arrives is a whole DOCUMENT —
      // compositions, footage, a folder tree — and it replaces what is open
      // rather than adding to it, which is what Open means and Import does not.
      { commandId: 'file.openAfterEffects', label: 'Open After Effects Project…' },
      { separator: true },
      { commandId: ProjectCommands.Save, label: 'Save' },
      { commandId: ProjectCommands.SaveAs, label: 'Save As…' },
      /**
       * Only where it is a DIFFERENT command from Save As.
       *
       * Save As now opens a save dialog and writes a portable `.motion` file in
       * every build. On the desktop that is genuinely distinct from Save As,
       * which writes the local-first directory bundle that Sync reconciles
       * against — so both belong there. Anywhere else the two would run the
       * identical code under two names, which is two menu entries for one
       * feature and a user wondering which one is the real save.
       */
      {
        commandId: ProjectCommands.SaveToComputer,
        label: 'Save Portable Copy…',
        visible: () => tryCoreServices()?.files.environment === 'electron',
      },
      {
        commandId: ProjectCommands.SaveCopyToCloud,
        label: 'Save Copy to Cloud…',
        visible: cloudProjectsEnabled,
      },
      { commandId: ProjectCommands.IncrementAndSave, label: 'Increment and Save' },
      { separator: true },
      { commandId: ProjectCommands.Sync, label: 'Sync Project…' },
      { separator: true },
      // Import sits with Export rather than under Layer: what arrives is a
      // FILE from outside the project, and the layer tree it becomes is the
      // consequence, not the request.
      {
        // Three doors into the same library. Nested so File stays under its
        // entry cap; the panel's own Import button offers the same three.
        label: 'Import',
        children: [
          { commandId: 'assets.importFiles', label: 'Files…' },
          { commandId: 'assets.importFolder', label: 'Folder…' },
          { commandId: 'file.import3DModel', label: '3D Model…' },
        ],
      },
      { commandId: 'file.export', label: 'Export…' },
      { separator: true },
      // Registered ONLY under `cloudProjectsEnabled()` (see Providers) —
      // snapshots live on the backend, keyed by project id. The registration
      // comment says it stays unregistered locally so there is no
      // "permanently-disabled menu item next to a feature that does work"…
      // but this model is static, so the disabled item appeared anyway. Same
      // predicate on both sides now, which is what that intent required.
      { commandId: 'file.versionHistory', label: 'Version History…', visible: cloudProjectsEnabled },
      { separator: true },
      { commandId: ProjectCommands.Close, label: 'Close Project' },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { commandId: BuiltinCommands.Undo, label: 'Undo' },
      { commandId: BuiltinCommands.Redo, label: 'Redo' },
      { separator: true },
      { commandId: 'edit.cut', label: 'Cut' },
      { commandId: 'edit.copy', label: 'Copy' },
      { commandId: 'edit.paste', label: 'Paste' },
      { separator: true },
      { commandId: BuiltinCommands.SelectAll, label: 'Select All' },
      { commandId: BuiltinCommands.Deselect, label: 'Deselect' },
      { separator: true },
      { commandId: BuiltinCommands.DuplicateSelected, label: 'Duplicate' },
      { separator: true },
      { commandId: 'text.findReplace', label: 'Find and Replace Text…' },
      { commandId: 'text.replaceFonts', label: 'Find and Replace Fonts…' },
      { separator: true },
      {
        // Text-based editing. Both act on the transcript panel's selection
        // rather than on layers — delete the selected words' time range from
        // every layer, closing the gap; or select the filler words to delete.
        // Folded beside Delete because that is the verb they refine.
        label: 'Transcript',
        children: [
          { commandId: 'transcript.deleteSelection', label: 'Delete Transcript Selection' },
          { commandId: 'transcript.selectFillers', label: 'Select Filler Words' },
        ],
      },
      { commandId: BuiltinCommands.DeleteSelected, label: 'Delete' },
    ],
  },
  {
    id: 'composition',
    label: 'Composition',
    items: [
      // "New Composition…" was removed on the rationale that compositions are
      // created only from the dashboard, one project per composition. That is
      // no longer true: `openNewCompositionDialog` is live in the empty-comp
      // start cards and the Composition panel menu, so the menu was simply
      // missing an entry for a working feature.
      { commandId: 'comp.new', label: 'New Composition…' },
      {
        // All three act on FOOTAGE rather than on the open comp, which is why
        // they sit beside New Composition rather than under Layer: the result
        // of each is a composition that did not exist before (or, for Assemble
        // on a layer, a comp whose whole cut did not exist before).
        label: 'New From Footage',
        children: [
          { commandId: 'comp.multicam', label: 'New Multicam from Selected Assets…' },
          { commandId: 'comp.newFromSelectedClips', label: 'New Composition from Selected Clips…' },
          { commandId: 'comp.assembleFromFootage', label: 'Assemble from Footage…' },
        ],
      },
      { separator: true },
      { commandId: 'comp.settings', label: 'Composition Settings…' },
      { commandId: 'comp.delete', label: 'Delete Composition' },
      { commandId: 'comp.openPrevious', label: 'Open Previous Composition' },
      { commandId: 'comp.miniFlowchart', label: 'Composition Mini-Flowchart' },
      { separator: true },
      {
        // One entry per target shape rather than a dialog: the only input is
        // the aspect, and this way the whole feature is reachable by typing
        // '9:16' into the command palette. Each greys itself out for a comp
        // already at that aspect, which would have nothing to pan within.
        label: 'Auto-Reframe',
        children: [
          { commandId: 'comp.autoReframe.9:16', label: '9:16 Vertical' },
          { commandId: 'comp.autoReframe.1:1', label: '1:1 Square' },
          { commandId: 'comp.autoReframe.4:5', label: '4:5 Portrait' },
          { commandId: 'comp.autoReframe.16:9', label: '16:9 Widescreen' },
          { commandId: 'comp.autoReframe.4:3', label: '4:3 Classic' },
        ],
      },
      {
        // Captions sit under Composition rather than Layer: they are a
        // property of the whole comp (its spoken words), and every one of
        // these acts on all of them at once, not on a selection.
        label: 'Captions',
        children: [
          { commandId: 'captions.import', label: 'Import…' },
          { commandId: 'captions.generate', label: 'Generate from Audio' },
          { commandId: 'captions.exportSrt', label: 'Export .srt…' },
          { commandId: 'captions.exportVtt', label: 'Export .vtt…' },
          { commandId: 'captions.clear', label: 'Remove All' },
        ],
      },
      {
        // The transcript panel's verbs: the same spoken words, as an editable list.
        label: 'Transcript',
        children: [
          { commandId: 'transcript.transcribe', label: 'Transcribe Composition' },
          { commandId: 'transcript.addCaptions', label: 'Convert to Captions' },
          { commandId: 'transcript.exportSrt', label: 'Export .srt…' },
          { commandId: 'transcript.exportVtt', label: 'Export .vtt…' },
        ],
      },
      { separator: true },
      {
        // In / out marking, beside the composition they apply to. The shuttle
        // itself (J / K / L) is a chord, not a menu row.
        label: 'Transport',
        children: [
          { commandId: 'transport.markIn', label: 'Mark In' },
          { commandId: 'transport.markOut', label: 'Mark Out' },
          { commandId: 'transport.goToIn', label: 'Go to In Point' },
          { commandId: 'transport.goToOut', label: 'Go to Out Point' },
          { commandId: 'transport.clearInOut', label: 'Clear In and Out' },
          { separator: true },
          // What a preview includes, then the two audio-only previews those
          // flags exist to serve (AE's Numpad . and Alt+Numpad .).
          { commandId: 'transport.includeVideo', label: 'Include Video in Preview' },
          { commandId: 'transport.includeAudio', label: 'Include Audio in Preview' },
          { separator: true },
          { commandId: 'transport.previewAudioOnly', label: 'Preview Only Audio' },
          { commandId: 'transport.previewAudioOnlyWorkArea', label: 'Preview Only Audio in Work Area' },
          { separator: true },
          { commandId: 'transport.audioScrub', label: 'Audio Scrubbing' },
        ],
      },
      { separator: true },
      { commandId: 'comp.saveFrame', label: 'Save Frame As PNG' },
      { commandId: 'comp.copyFrame', label: 'Copy Frame to Clipboard' },
      { separator: true },
      // A demo-scene loader, not a composition verb — last, below a rule, so
      // it does not read as part of the working set above it.
      { commandId: 'scene.loadBlockTower', label: 'Load: Block Tower' },
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      {
        // Everything that creates a layer, under one parent — the shape AE
        // uses (Layer ▸ New ▸ …), and the one `useAppMenuGroups` extends with
        // plugin layer kinds, so a plugin's layer sits beside Text and Solid
        // rather than under a menu named after the mechanism providing it.
        label: LAYER_NEW_SUBMENU_LABEL,
        children: [
          { commandId: 'layer.newText', label: 'Text' },
          { commandId: 'layer.newSolid', label: 'Solid…' },
          { commandId: 'layer.newCamera', label: 'Camera…' },
          { commandId: 'layer.newLight', label: 'Light…' },
          { commandId: 'layer.newNull', label: 'Null Object' },
          { commandId: 'layer.newAdjustment', label: 'Adjustment Layer' },
          { separator: true },
          {
            // The 3D inserts existed only in the TopNav "+" dropdown — a place
            // you browse rather than search. They belong beside the other New
            // entries.
            label: '3D Primitive',
            children: [
              { commandId: 'layer.new3d.cube', label: 'Cube' },
              { commandId: 'layer.new3d.sphere', label: 'Sphere' },
              { commandId: 'layer.new3d.cylinder', label: 'Cylinder' },
              { commandId: 'layer.new3d.plane', label: 'Plane' },
              { commandId: 'layer.new3d.cone', label: 'Cone' },
              { commandId: 'layer.new3d.torus', label: 'Torus' },
              { commandId: 'layer.new3d.capsule', label: 'Capsule' },
              { commandId: 'layer.new3d.box', label: 'Box (mesh)' },
            ],
          },
        ],
      },
      { separator: true },
      {
        /**
         * AE's Layer ▸ Transform, in AE's order. Fit, Fill, Native Size and both
         * Centre commands were registered with no menu line at all — reachable
         * only by a chord (Ctrl+Alt+F) or by typing their names into the
         * palette. Reset, the two Flips and Auto-Orient are new.
         */
        label: 'Transform',
        children: [
          { commandId: 'layer.resetTransform', label: 'Reset' },
          {
            label: 'Anchor Point',
            children: [
              { commandId: 'layer.centreAnchor', label: 'Center Anchor Point in Layer Content' },
            ],
          },
          { commandId: 'layer.flipHorizontal', label: 'Flip Horizontal' },
          { commandId: 'layer.flipVertical', label: 'Flip Vertical' },
          { commandId: 'layer.centreInComp', label: 'Center In View' },
          { separator: true },
          { commandId: 'layer.fitToComp', label: 'Fit to Comp' },
          { commandId: 'layer.fitToCompWidth', label: 'Fit to Comp Width' },
          { commandId: 'layer.fitToCompHeight', label: 'Fit to Comp Height' },
          { commandId: 'layer.fillComp', label: 'Fill Comp' },
          { commandId: 'layer.nativeSize', label: 'Set to Native Size' },
          { separator: true },
          { commandId: 'layer.autoOrient', label: 'Auto-Orient…' },
        ],
      },
      { commandId: 'layer.settings', label: 'Layer Settings…' },
      {
        // Text-layer verbs AE keeps on the layer: point ↔ paragraph conversion
        // (no visual jump) and the Character panel's fill/stroke swap (Shift+X).
        label: 'Text',
        children: [
          { commandId: 'text.convertToParagraphText', label: 'Convert to Paragraph Text' },
          { commandId: 'text.convertToPointText', label: 'Convert to Point Text' },
          { commandId: 'text.toggleOrientation', label: 'Convert to Vertical/Horizontal Text' },
          { separator: true },
          { commandId: 'text.swapFillStroke', label: 'Swap Fill and Stroke' },
          { commandId: 'text.sourceTextExpression', label: 'Source Text Expression…' },
        ],
      },
      {
        // AE's Layer ▸ Mask and Shape Path. Acts on the vertices selected with
        // Direct Selection, else on the selected layers' paths (pathCommands.ts).
        label: 'Mask and Shape Path',
        children: [
          { commandId: 'path.toggleClosed', label: 'Closed' },
          { commandId: 'path.setFirstVertex', label: 'Set First Vertex' },
          { commandId: 'path.toggleRotoBezier', label: 'RotoBezier' },
          { commandId: 'path.reverse', label: 'Reverse Path Direction' },
          { separator: true },
          { commandId: 'path.freeTransformPoints', label: 'Free Transform Points' },
          { commandId: 'path.keyframe', label: 'Set Mask / Path Keyframe' },
          { separator: true },
          { commandId: 'path.convertMaskToShape', label: 'Convert Mask to Shape Layer' },
        ],
      },
      // AE's Layer ▸ Guide Layer. Registered, with no menu line until now.
      { commandId: 'layer.toggleGuide', label: 'Guide Layer' },
      {
        label: 'Arrange',
        children: [
          { commandId: 'layer.bringToFront', label: 'Bring to Front' },
          { commandId: 'layer.bringForward', label: 'Bring Forward' },
          { commandId: 'layer.sendBackward', label: 'Send Backward' },
          { commandId: 'layer.sendToBack', label: 'Send to Back' },
        ],
      },
      { commandId: 'layer.precompose', label: 'Pre-compose…' },
      { separator: true },
      {
        // Derive new layers from the selection — nulls from a path's points,
        // shapes from text, a traced outline from footage.
        label: 'Create',
        children: [
          { commandId: 'layer.nullsFromPath', label: 'Nulls From Path Points' },
          { commandId: 'layer.nullsFromPathLive', label: 'Nulls From Path Points (Points Follow Nulls)' },
          { commandId: 'layer.shapesFromText', label: 'Shapes From Text' },
          { commandId: 'layer.masksFromText', label: 'Masks From Text' },
          { commandId: 'layer.autoTrace', label: 'Auto-trace…' },
        ],
      },
      {
        // AE's Layer ▸ Camera: the rig verbs. Every one existed as a prop you
        // could type into; none existed as a thing you could ask for.
        label: 'Camera',
        children: [
          { commandId: 'camera.createOrbitNull', label: 'Create Orbit Null' },
          { commandId: 'camera.distributeZ', label: 'Distribute Layers in Z' },
          { separator: true },
          { commandId: 'camera.setFocusToLayer', label: 'Set Focus Distance to Layer' },
          { commandId: 'camera.linkFocusToLayer', label: 'Link Focus Distance to Layer' },
          { commandId: 'camera.linkFocusToPoi', label: 'Link Focus Distance to Point of Interest' },
        ],
      },
      {
        /**
         * Boolean path ops. Both engines shipped complete and lived in ONE
         * place: the Scene panel's node kebab, found only by right-clicking a
         * multi-selection. Live first, because it is the one to reach for —
         * the operands stay animatable — with the destructive bakes below a
         * rule, which is the same order the kebab uses.
         */
        label: 'Path Operations',
        children: [
          { commandId: 'shape.boolean.union', label: 'Union (Add)' },
          { commandId: 'shape.boolean.subtract', label: 'Subtract' },
          { commandId: 'shape.boolean.intersect', label: 'Intersect' },
          { commandId: 'shape.boolean.exclude', label: 'Exclude (XOR)' },
          { separator: true },
          { commandId: 'shape.mergeUnion', label: 'Merge Paths (Bake): Union' },
          { commandId: 'shape.mergeSubtract', label: 'Merge Paths (Bake): Subtract' },
          { commandId: 'shape.mergeIntersect', label: 'Merge Paths (Bake): Intersect' },
          { commandId: 'shape.mergeExclude', label: 'Merge Paths (Bake): Exclude' },
        ],
      },
      { separator: true },
      {
        // AE puts Scene Edit Detection under Layer, and so did the code's own
        // comment on the clip menu — which was the only place it could be run.
        label: 'Scene Edit Detection',
        children: [
          { commandId: 'layer.sceneEditDetect.markers', label: 'Markers' },
          { commandId: 'layer.sceneEditDetect.split', label: 'Split Clips' },
        ],
      },
    ],
  },
  {
    id: 'effect',
    label: 'Effect',
    items: [
      // Short enough to stay flat; ruled into families so it scans like AE's
      // Effect menu rather than like the order the shaders were written in.
      { commandId: 'effect.blur', label: 'Fast Box Blur' },
      { separator: true },
      { commandId: 'effect.brightness', label: 'Brightness & Contrast' },
      { commandId: 'effect.contrast', label: 'Contrast' },
      { commandId: 'effect.saturate', label: 'Hue/Saturation' },
      { commandId: 'effect.hue', label: 'Hue Rotate' },
      { separator: true },
      { commandId: 'effect.glow', label: 'Glow' },
      { commandId: 'effect.grayscale', label: 'Grayscale' },
      { commandId: 'effect.sepia', label: 'Sepia' },
    ],
  },
  {
    // AE's Animation menu — keyframe assistants that were shortcut-only.
    id: 'animation',
    label: 'Animation',
    items: [
      // The three eases stay at the top level: they are the entries a user
      // reaches for on every other keyframe, and AE keeps them there too.
      { commandId: 'anim.easyEase', label: 'Easy Ease' },
      { commandId: 'anim.easyEaseIn', label: 'Easy Ease In' },
      { commandId: 'anim.easyEaseOut', label: 'Easy Ease Out' },
      {
        label: 'Keyframe Interpolation',
        children: [
          { commandId: 'anim.interpLinear', label: 'Linear' },
          { commandId: 'anim.interpHold', label: 'Hold' },
        ],
      },
      {
        // AE Animation ▸ Keyframe Assistant — engines lived in the palette /
        // TopNav only; this menu is where AE muscle memory looks first.
        label: 'Keyframe Assistant',
        children: [
          { commandId: 'animation.easyEaseAll', label: 'Easy Ease All Keyframes' },
          { commandId: 'animation.timeReverseKeyframes', label: 'Time-Reverse Keyframes' },
          { commandId: 'animation.exponentialScale', label: 'Exponential Scale' },
          { commandId: 'animation.smoother', label: 'The Smoother…' },
          { commandId: 'animation.wiggler', label: 'The Wiggler…' },
          { separator: true },
          // The two that act across LAYERS rather than within one property's
          // keyframes, below a rule.
          { commandId: 'animation.sequenceLayerBars', label: 'Sequence Layers…' },
          { commandId: 'animation.staggerLayers', label: 'Stagger Layers…' },
          { commandId: 'animation.sequenceLayers', label: 'Stagger Animations…' },
        ],
      },
      { separator: true },
      {
        // Creates animation on layers that have none — the counterpart to
        // Stagger Animations above, which only offsets keyframes that exist.
        label: 'Animate',
        children: [
          { commandId: 'animation.animateIn', label: 'Animate In' },
          { commandId: 'animation.animateOut', label: 'Animate Out' },
          { separator: true },
          {
            label: 'Motion Feel',
            children: [
              { commandId: 'animation.motionFeel.snappy', label: 'Snappy' },
              { commandId: 'animation.motionFeel.smooth', label: 'Smooth' },
              { commandId: 'animation.motionFeel.bouncy', label: 'Bouncy' },
            ],
          },
        ],
      },
      {
        // Everything driven by the comp's sound: the beat-driven verbs, the
        // two edits that read the waveform, and the bake to keyframes.
        label: 'Audio',
        children: [
          { commandId: 'audio.fadeIn', label: 'Fade In' },
          { commandId: 'audio.fadeOut', label: 'Fade Out' },
          { separator: true },
          { commandId: 'animation.animateInOnBeats', label: 'Animate In on Beats' },
          { commandId: 'audio.markBeats', label: 'Markers on Beats' },
          { separator: true },
          { commandId: 'audio.removeSilence', label: 'Remove Silence…' },
          { commandId: 'audio.gate', label: 'Noise Gate…' },
          { commandId: 'audio.duckMusic', label: 'Duck Under Voice…' },
          { separator: true },
          { commandId: 'animation.convertAudioToKeyframes', label: 'Convert Audio to Keyframes' },
        ],
      },
      {
        label: 'Time',
        children: [
          // AE's Layer ▸ Time, in AE's order. All of these existed as switches
          // in the Compositing section and the viewport's Video submenu; the
          // menu listed only the ramps, so the app looked unable to reverse
          // or freeze footage.
          { commandId: 'time.enableTimeRemap', label: 'Enable Time Remapping' },
          { commandId: 'time.reverseLayer', label: 'Time-Reverse Layer' },
          { commandId: 'time.timeStretch', label: 'Time Stretch…' },
          { commandId: 'time.freezeFrame', label: 'Freeze Frame' },
          { commandId: 'time.freezeOnLastFrame', label: 'Freeze On Last Frame' },
          { separator: true },
          // Twixtor / Timewarp's two modes. The one-click ramps and the seven
          // velocity presets stay in the command palette and the Speed section.
          { commandId: 'time.retime.speed', label: 'Retime: Speed %' },
          { commandId: 'time.retime.frames', label: 'Retime: Frame Number' },
          { commandId: 'time.speedRamp.quarter', label: 'Speed Ramp to 25%' },
          { separator: true },
          { commandId: 'time.frameBlend.none', label: 'Frame Blend: Off' },
          { commandId: 'time.frameBlend.mix', label: 'Frame Blend: Frame Mix' },
          { commandId: 'time.frameBlend.pixelMotion', label: 'Frame Blend: Pixel Motion' },
        ],
      },
      {
        // The three that turn something procedural into plain keyframes.
        label: 'Bake',
        children: [
          { commandId: 'dynamics.bakePhysics', label: 'Bake Physics to Keyframes…' },
          { commandId: 'dynamics.bakeParticles', label: 'Bake Particles to Layers…' },
          {
            commandId: 'animation.convertExpressionToKeyframes',
            label: 'Convert Expression to Keyframes',
          },
        ],
      },
      { separator: true },
      { commandId: 'animation.motionSketch', label: 'Motion Sketch' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      { commandId: BuiltinCommands.ToggleLeftSidebar, label: 'Toggle Scene Panel' },
      { commandId: BuiltinCommands.ToggleRightInspector, label: 'Toggle Inspector' },
      { commandId: BuiltinCommands.ToggleTimeline, label: 'Toggle Timeline' },
      {
        // The one-key modes (` / Shift+`, AE's maximize-panel key — Tab is
        // the Composition Mini-Flowchart). Beside the three toggles they
        // compose, so the menu shows the chord a user would otherwise only
        // discover by pressing it and wondering where the panels went.
        label: 'Focus Mode',
        children: [
          { commandId: 'view.focusMode.viewportTimeline', label: 'Viewport + Timeline' },
          { commandId: 'view.focusMode.viewport', label: 'Viewport Only' },
        ],
      },
      { separator: true },
      {
        label: 'Guides & Grid',
        children: [
          { commandId: 'view.grid', label: 'Show Grid' },
          { commandId: 'view.proportionalGrid', label: 'Show Proportional Grid' },
          { commandId: 'view.snapToGrid', label: 'Snap to Grid' },
          { commandId: 'view.snapToPixel', label: 'Snap to Pixel' },
          { commandId: 'view.rulers', label: 'Toggle Rulers' },
          { commandId: 'view.safeAreas', label: 'Toggle Safe Areas' },
          { separator: true },
          { commandId: 'view.guides.show', label: 'Show Guides' },
          { commandId: 'view.guides.lockAll', label: 'Lock Guides' },
          { commandId: 'view.guides.unlockAll', label: 'Unlock Guides' },
          { commandId: 'view.guides.clear', label: 'Clear Guides' },
        ],
      },
      // A PREVIEW setting, like the guides above it: proxies change what the
      // viewport decodes and nothing about what an export writes.
      { commandId: 'view.useProxies', label: 'Use Proxies' },
      {
        // The Assets panel's own view state. Nested rather than listed flat:
        // these act on one panel, and View is already close to its entry cap.
        label: 'Assets Panel',
        children: [
          { commandId: 'assets.toggleGridView', label: 'Grid View' },
          { commandId: 'assets.toggleUnusedFilter', label: 'Show Unused Only' },
          { commandId: 'assets.toggleMetadataDrawer', label: 'Metadata Drawer' },
          { commandId: 'assets.revealInFolder', label: 'Reveal in File Manager' },
        ],
      },
      { separator: true },
      { commandId: 'view.fitSelection', label: 'Fit Selection in View' },
      {
        // Everything that frames or reshapes the timeline PANEL, kept apart
        // from the edit-mode tools below it. Nested because View is capped at
        // fourteen top-level entries and these four zooms were most of the
        // pressure on it.
        label: 'Timeline',
        children: [
          { commandId: 'timeline.zoomToFit', label: 'Fit Composition' },
          { commandId: 'timeline.zoomToWorkArea', label: 'Fit Work Area' },
          { commandId: 'timeline.fitSelection', label: 'Fit Selection' },
          { separator: true },
          { commandId: 'timeline.expandAll', label: 'Expand All Layers' },
          { commandId: 'timeline.collapseAll', label: 'Collapse All Layers' },
          { separator: true },
          { commandId: 'timeline.toggleSnap', label: 'Snap in Timeline' },
        ],
      },
      {
        // How the viewport DRAWS: the display mode, the readout over it, and
        // the monitor-only look. Nothing here changes a rendered frame.
        label: 'Viewport',
        children: [
          { commandId: 'view.displayMode.shaded', label: 'Shaded' },
          { commandId: 'view.displayMode.wireframe', label: 'Wireframe' },
          { commandId: 'view.displayMode.bounds', label: 'Bounding Boxes' },
          { separator: true },
          { commandId: 'view.hud', label: 'Performance HUD' },
          { commandId: 'view.pixelAspectCorrection', label: 'Pixel Aspect Correction' },
          { separator: true },
          { commandId: 'view.viewerLut.load', label: 'Load Viewer LUT…' },
          { commandId: 'view.viewerLut.clear', label: 'Clear Viewer LUT' },
          { separator: true },
          {
            // Snapshot and compare are one workflow: take a frame, then look
            // at it against the live one.
            label: 'Snapshot & Compare',
            children: [
              { commandId: 'view.snapshot', label: 'Take Snapshot' },
              { commandId: 'view.compareToggle', label: 'Show Snapshot' },
              { commandId: 'view.compareFlip', label: 'Flip Comparison' },
              { separator: true },
              { commandId: 'view.compareMode.toggle', label: 'Mode: Toggle' },
              { commandId: 'view.compareMode.side-by-side', label: 'Mode: Side by Side' },
              { commandId: 'view.compareMode.wipe', label: 'Mode: Wipe' },
              { commandId: 'view.compareMode.difference', label: 'Mode: Difference' },
              { separator: true },
              { commandId: 'view.compareClear', label: 'Clear Snapshot' },
            ],
          },
          {
            label: 'Camera Bookmarks',
            children: [
              { commandId: 'view.cameraBookmark.recall1', label: 'Recall 1' },
              { commandId: 'view.cameraBookmark.recall2', label: 'Recall 2' },
              { commandId: 'view.cameraBookmark.recall3', label: 'Recall 3' },
              { commandId: 'view.cameraBookmark.recall4', label: 'Recall 4' },
              { commandId: 'view.cameraBookmark.recall5', label: 'Recall 5' },
              { commandId: 'view.cameraBookmark.recall6', label: 'Recall 6' },
              { commandId: 'view.cameraBookmark.recall7', label: 'Recall 7' },
              { commandId: 'view.cameraBookmark.recall8', label: 'Recall 8' },
              { commandId: 'view.cameraBookmark.recall9', label: 'Recall 9' },
              { separator: true },
              { commandId: 'view.cameraBookmark.save1', label: 'Save to 1' },
              { commandId: 'view.cameraBookmark.save2', label: 'Save to 2' },
              { commandId: 'view.cameraBookmark.save3', label: 'Save to 3' },
              { commandId: 'view.cameraBookmark.save4', label: 'Save to 4' },
              { commandId: 'view.cameraBookmark.save5', label: 'Save to 5' },
              { commandId: 'view.cameraBookmark.save6', label: 'Save to 6' },
              { commandId: 'view.cameraBookmark.save7', label: 'Save to 7' },
              { commandId: 'view.cameraBookmark.save8', label: 'Save to 8' },
              { commandId: 'view.cameraBookmark.save9', label: 'Save to 9' },
            ],
          },
          {
            // AE's View ▸ Switch 3D View + Look At. The two view switches had
            // shortcuts (1 / 2) and no menu line; Look At is new. Inside
            // Viewport because View sits at its fourteen-entry cap.
            label: '3D View',
            children: [
              { commandId: 'view.activeCamera', label: 'Active Camera' },
              { commandId: 'view.lastCustom', label: 'Last Custom View' },
              { separator: true },
              { commandId: 'view.lookAtSelected', label: 'Look at Selected Layers' },
              { commandId: 'view.lookAtAll', label: 'Look at All Layers' },
            ],
          },
        ],
      },
      {
        label: 'Timeline Tools',
        children: [
          { commandId: 'timeline.editMode.select', label: 'Selection Tool' },
          { commandId: 'timeline.editMode.razor', label: 'Razor Tool' },
          { commandId: 'timeline.editMode.slip', label: 'Slip Tool' },
          { commandId: 'timeline.editMode.slide', label: 'Slide Tool' },
          { commandId: 'timeline.editMode.roll', label: 'Roll Tool' },
        ],
      },
      { separator: true },
      {
        label: 'Cache',
        children: [
          { commandId: 'preview.cacheWorkArea', label: 'Cache Work Area Now' },
          { commandId: 'preview.purgeRam', label: 'Purge RAM Preview' },
          { commandId: 'preview.purgeDisk', label: 'Purge Disk Cache' },
        ],
      },
      { separator: true },
      // No Reset Layout here: Window ▸ Workspace owns it, beside the layout
      // presets it resets to. It was listed in both, which is two menu entries
      // for one command.
      { commandId: BuiltinCommands.SwitchTheme, label: 'Switch Theme' },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      // Its chord (Ctrl/Cmd+Shift+P) is the palette's own listener, not a
      // registry binding — see the command's registration for why.
      { commandId: 'view.commandPalette', label: 'Command Palette' },
      { commandId: 'view.presentation', label: 'Present (Preview)' },
      { separator: true },
      { commandId: 'view.audio', label: 'Audio' },
      { commandId: 'view.paint', label: 'Paint' },
      { commandId: 'view.brushes', label: 'Brushes' },
      { commandId: 'view.history', label: 'History' },
      { commandId: 'view.transcript', label: 'Transcript' },
      { commandId: 'view.effectControls', label: 'Effect Controls' },
      { commandId: 'view.renderQueue', label: 'Render Queue' },
      { commandId: 'view.export', label: 'Export' },
      { commandId: 'view.graphEditor', label: 'Graph Editor' },
      // Every other dock panel (2026-09-15). The rails now carry only the
      // everyday set, so this submenu is the complete list of what else can be
      // docked — alphabetical, because a user scanning it knows the name, not
      // the rail it lands on. One container, since this group sits at the
      // 14-entry cap (`menuSubmenus.test.ts`). Commands: Providers.tsx.
      {
        label: 'Panels',
        // A THUNK, not a list: the app's own panels are fixed, and a plugin's
        // are not — they appear and disappear with what the user has installed,
        // and the renderer re-evaluates this every time the menu is drawn.
        // `pluginPanelMenuItems` returns nothing when no plugin declares a
        // panel, which is the overwhelmingly common case.
        children: () => [
          { commandId: 'view.align', label: 'Align' },
          { commandId: 'view.effects', label: 'Effects' },
          { commandId: 'view.motion', label: 'Graph Panel' },
          { commandId: 'view.info', label: 'Info' },
          { commandId: 'view.scene', label: 'Layers' },
          { commandId: 'view.presets', label: 'Presets' },
          { commandId: 'view.preview', label: 'Preview' },
          { commandId: 'view.rig', label: 'Rigging' },
          { commandId: 'view.scopes', label: 'Scopes' },
          { commandId: 'view.sourceMonitor', label: 'Source Monitor' },
          { commandId: 'view.swatches', label: 'Swatches' },
          { commandId: 'view.character', label: 'Text' },
          { commandId: 'view.tracker', label: 'Tracker' },
          ...pluginPanelMenuItems(),
        ],
      },
      { separator: true },
      // Built per render from WorkspaceManager — half of it is user data. See
      // workspaceMenu.ts.
      { label: 'Workspace', children: buildWorkspaceMenuItems },
      { commandId: 'view.customize', label: 'Customize…' },
      // No Plugins entry here: the Plugins GROUP (built dynamically in
      // pluginMenu.ts) owns it, and a second door labelled the same thing is
      // how a user ends up thinking there are two features.
    ],
  },

  {
    id: 'help',
    label: 'Help',
    items: [
      { commandId: 'help.tour', label: 'Take a Tour' },
      { commandId: 'help.powerTour', label: 'Power-user Tour' },
      { separator: true },
      { commandId: 'help.docs', label: 'Documentation' },
      // The palette's `?` mode — a heading search over docs/*.md.
      { commandId: 'help.searchDocs', label: 'Search Documentation…' },
      { commandId: 'help.whatsNew', label: "What's New…" },
      { separator: true },
      { commandId: ProjectCommands.About, label: 'About Premation' },
    ],
  },
];
