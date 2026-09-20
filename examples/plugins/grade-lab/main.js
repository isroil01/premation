/**
 * Grade Lab — a film grade with presets, and the air EQ to go under it.
 *
 * The plugin is small on purpose. What it demonstrates is the three host
 * surfaces that let an effect be more than a row of sliders:
 *
 *   • PARAM SUPERVISION — picking a preset moves the sliders under it, and
 *     moving a slider sets the preset back to Custom. Neither is possible
 *     without the host telling the plugin its own control moved.
 *   • SEQUENCE DATA     — declared in the manifest (`invalidateOn`) and used
 *     by the CPU kernel, which builds its lookup table once per quality
 *     setting instead of once per frame.
 *   • AUDIO EFFECTS     — a declared node chain, so it works in preview and
 *     in export with no code at all. There is nothing about it in this file.
 */

/**
 * The presets, and the ONLY place their values live.
 *
 * Index 0 is Custom and deliberately has no values: it is what the preset
 * becomes when the user moves a slider by hand, and writing values for it
 * would undo the edit that selected it.
 */
const PRESETS = [
  null,                          // 0 — Custom
  { lift: 0.04, gain: 1.10 },    // 1 — Filmic
  { lift: 0.00, gain: 1.35 },    // 2 — Punch
  { lift: 0.10, gain: 0.92 },    // 3 — Faded
];

/** Which params a preset owns. Moving one of these by hand means Custom. */
const OWNED = ['lift', 'gain'];

export function activate(motion) {
  /*
    The user moved one of this effect's own controls.

    Called only for params named in `supervises`, and only once a drag has
    settled — so this runs on a dropdown pick, not thirty times during a
    slider sweep.

    Return the params to write, or null to change nothing. The host keeps only
    keys this effect declares, ignores values that did not move, and will NOT
    call back for the params written here — so setting `preset` from inside a
    supervision is safe rather than a loop.
  */
  motion.effects.onParamChanged('filmic', ({ changed, params }) => {
    if (changed === 'preset') {
      const preset = PRESETS[Math.round(params.preset)];
      // Custom carries no values: selecting it must not overwrite the sliders
      // the user just hand-tuned to get there.
      return preset ? { ...preset } : null;
    }

    /*
      A slider the preset owns moved by hand, so the preset no longer
      describes what is on screen. Say Custom rather than leaving a label
      that lies about the picture.

      Only reachable if `supervises` is widened to include these; with the
      manifest as shipped, `preset` is the only param that arrives here. Kept
      because it is the half of the pattern people come looking for.
    */
    if (OWNED.includes(changed) && Math.round(params.preset) !== 0) {
      return { preset: 0 };
    }
    return null;
  });

  motion.log('Grade Lab ready');
}
