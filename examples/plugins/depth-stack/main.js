/**
 * Depth Stack — turn one flat image into a stack of 3D cards.
 *
 * What it does: reads the selected image, splits it into N cards by
 * brightness, pushes each card to a different depth, and animates a sideways
 * sweep whose size is proportional to that depth. Near cards travel further
 * than far ones, which is what parallax IS.
 *
 * Two ways in, one implementation: the panel (right inspector, its own tab) and
 * a command in the Plugins menu. The command uses the defaults; the panel
 * passes whatever its sliders say.
 *
 * ── The honest part ─────────────────────────────────────────────────────────
 *
 * Brightness is NOT depth. A real 2.5D plugin displaces the image by a depth
 * MAP — a second image, usually from a depth model — and this API cannot do
 * that: an effect's generated bind group has exactly one texture, so a shader
 * cannot sample a second one (gap 1 in docs/PLUGINS.md §12). This plugin works
 * around it by not being a shader at all. It builds real layers, so the depth
 * lives in the scene graph where the renderer's existing 3D already handles it.
 *
 * The brightness proxy is good on images that are lit front-to-back — portraits
 * on dark backgrounds, anything with haze or a bright sky behind a dark
 * subject. It is wrong on a dark object in front of a bright wall, where it
 * will confidently put the wall in front. That is a property of the proxy, not
 * a bug to report.
 */

const DEFAULTS = {
  /** How many depth cards to cut. More cards = smoother, and linearly slower. */
  cards: 5,
  /** Depth spread in px, front card to back card. The renderer reads it as z. */
  spread: 900,
  /** How far the nearest card travels in the sweep, in px. */
  sweep: 90,
  /** Seconds for one there-and-back sweep. */
  duration: 3,
};

/**
 * Total pixels this is willing to allocate (across every card).
 *
 * Each card is a full-size RGBA copy, so the cost is width × height × cards × 4
 * bytes and it is paid all at once. A 12 MP photo at 5 cards is 240 MB, which
 * the asset limits would refuse one card at a time and with a worse message.
 */
const MAX_TOTAL_PIXELS = 24_000_000;

const LUMA = [0.299, 0.587, 0.114];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Options from an untrusted sender (the panel) folded onto the defaults. */
function readOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (k, lo, hi) =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? clamp(o[k], lo, hi) : DEFAULTS[k];
  return {
    cards: Math.round(num('cards', 2, 9)),
    spread: num('spread', 0, 4000),
    sweep: num('sweep', 0, 1000),
    duration: num('duration', 0.1, 30),
  };
}

export function activate(motion) {
  /**
   * Push a status line to the panel. Not awaited anywhere: `sendToPanel` posts
   * a message and returns void rather than a promise, so there is nothing to
   * wait for and pretending otherwise would suggest delivery was confirmed.
   */
  const report = (text, level, busy) => {
    motion.ui.sendToPanel({ type: 'status', text, level, busy: !!busy });
  };

  async function explode(options) {
    const opts = readOptions(options);

    for (const p of ['scene:write', 'assets:read', 'assets:write']) {
      if (!motion.has(p)) {
        const msg = `Depth Stack needs "${p}" to run.`;
        await motion.ui.notify(msg, 'error');
        report(msg, 'error', false);
        return;
      }
    }

    const selection = await motion.scene.getSelection();
    if (!selection.length) {
      report('Select an image layer first.', 'error', false);
      return;
    }

    const layerId = selection[0];
    const layer = await motion.scene.getLayer(layerId);

    // Read the picture first. This fails with a clear message on a layer that
    // is not showing a library image, which is the common mistake — a shape or
    // a text layer looks selectable and is not one of these.
    let img;
    try {
      img = await motion.assets.getImage({ layerId });
    } catch (err) {
      const msg = `Select an image layer — ${String(err && err.message ? err.message : err)}`;
      await motion.ui.notify(msg, 'error');
      report(msg, 'error', false);
      return;
    }

    const { width, height, bytes } = img;
    if (width * height * opts.cards > MAX_TOTAL_PIXELS) {
      const mp = (width * height / 1e6).toFixed(1);
      const msg = `${width}×${height} (${mp} MP) × ${opts.cards} cards is past what this can allocate. Use fewer cards, or scale the image down.`;
      await motion.ui.notify(msg, 'error');
      report(msg, 'error', false);
      return;
    }

    // Where the source sits, so the cards land exactly on top of it rather than
    // at the origin. Absent props mean a layer at the default position.
    const baseX = typeof layer.props.x === 'number' ? layer.props.x : 0;
    const baseY = typeof layer.props.y === 'number' ? layer.props.y : 0;

    // Consent is per permission and the user may untick any of it, so this
    // degrades rather than throwing: without `timeline` the sweep is written
    // from zero instead of from the playhead.
    const t0 = motion.has('timeline') ? await motion.timeline.getTime() : 0;
    const pixels = width * height;
    const created = [];

    for (let k = 0; k < opts.cards; k++) {
      report(`Cutting card ${k + 1} of ${opts.cards}…`, '', true);

      // Band centre in 0..1. Card 0 is the darkest band, which reads as
      // furthest away under the brightness proxy.
      const centre = (k + 0.5) / opts.cards;
      const card = new Uint8Array(pixels * 4);

      for (let p = 0; p < pixels; p++) {
        const o = p * 4;
        const r = bytes[o];
        const g = bytes[o + 1];
        const b = bytes[o + 2];
        const lum = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255;

        /*
          Soft membership, not a hard cut.

          `d` is 0 at the band centre and 1 at its edge. A hard `lum in band`
          test leaves every card with a jagged alpha edge, and several of those
          stacked read as banding rather than as depth. The linear falloff makes
          neighbouring cards overlap and cross-fade, which is also what keeps
          the stack from showing gaps when it moves.

          The two outer bands extend past their centres instead of falling off.
          Weights otherwise sum to 1 across the cards everywhere EXCEPT below
          the first centre and above the last, where they reach only 0.5 — so
          pure black and pure white came out half transparent, and the artefact
          landed precisely on deep shadows and blown highlights.
        */
        const outerDark = k === 0 && lum < centre;
        const outerLight = k === opts.cards - 1 && lum > centre;
        const d = Math.abs(lum - centre) * opts.cards;
        const a = outerDark || outerLight ? 1 : d >= 1 ? 0 : 1 - d;

        card[o] = r;
        card[o + 1] = g;
        card[o + 2] = b;
        card[o + 3] = Math.round(bytes[o + 3] * a);
      }

      const asset = await motion.assets.createImage({
        width,
        height,
        bytes: card,
        mime: 'image/rgba8',
        name: `${layer.name} · depth ${k + 1}`,
      });

      const id = await motion.scene.createLayer({
        kind: 'image',
        assetId: asset.assetId,
        name: `Depth card ${k + 1}`,
        x: baseX,
        y: baseY,
      });

      /*
        The 3D switch is these three props existing as numbers — there is no
        separate flag. Written before any keyframe: `setProperty` sets the BASE
        value, and the renderer reads animated values first, so a base write to
        a property that already carries a track is discarded in silence.
      */
      const depth = (0.5 - centre) * opts.spread * 2;
      await motion.scene.setProperty(id, 'rotationX', 0);
      await motion.scene.setProperty(id, 'rotationY', 0);
      await motion.scene.setProperty(id, 'z', depth);

      // Near cards swing further than far ones. Same phase, different
      // amplitude — that difference is the whole effect.
      const amp = opts.sweep * (1 - centre);
      if (motion.has('animation:write') && amp > 0) {
        await motion.animation.setKeyframes(id, 'x', [
          { t: t0, value: baseX - amp, easing: 'easeInOut' },
          { t: t0 + opts.duration / 2, value: baseX + amp, easing: 'easeInOut' },
          { t: t0 + opts.duration, value: baseX - amp, easing: 'easeInOut' },
        ]);
      }

      created.push(id);
    }

    await motion.scene.setSelection(created);
    const done = `${opts.cards} depth cards from "${layer.name}". The original is still underneath — hide it to see the stack alone.`;
    await motion.ui.notify(done, 'success');
    report(done, 'success', false);
  }

  motion.commands.register(
    {
      id: 'explode',
      label: 'Explode image into 3D depth cards',
      icon: 'layers',
      needsSelection: true,
    },
    () => explode(DEFAULTS),
  );

  motion.commands.register(
    { id: 'panel', label: 'Show Depth Stack panel', icon: 'layers' },
    () => motion.ui.openPanel(),
  );

  motion.ui.onPanelMessage(async (msg) => {
    if (!msg || msg.type !== 'explode') return;
    try {
      await explode(msg.options);
    } catch (err) {
      // The panel's button is disabled while work is in flight, so a throw that
      // never reported would leave it disabled forever.
      const text = String(err && err.message ? err.message : err);
      await motion.ui.notify(text, 'error');
      report(text, 'error', false);
    }
  });
}
