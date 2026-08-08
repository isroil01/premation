/**
 * Parallax 3D — the shader half of the same idea.
 *
 * The effect itself is declared in plugin.json and lives entirely on the GPU;
 * this module never runs during a frame. That is structural, not a
 * micro-optimisation: plugin code runs in a Worker, so reaching it from the
 * render loop would mean a `postMessage` inside a synchronous draw. A plugin
 * registers an effect and drives its parameters; it is never in the loop —
 * which is also why the effect keeps working with this worker stopped.
 *
 * So there is nothing to do at activate() beyond saying hello. Find the effect
 * in the effects browser under this plugin's name and drop it on any layer.
 *
 * Where it differs from Depth Stack: this warps one image on the GPU and makes
 * no objects, so it is cheap, animatable and reversible, but it can never
 * occlude — there is nothing behind the surface to reveal. Depth Stack makes
 * real layers, which do occlude, and costs an allocation per card.
 *
 * WebGPU only. On the WebGL2 tier a plugin effect is the host-generated
 * passthrough and this will render its input unchanged.
 */

export function activate(motion) {
  motion.commands.register(
    { id: 'about', label: 'About Parallax 3D', icon: 'info' },
    async () => {
      await motion.ui.notify(
        'Add "Parallax 3D" from the effects browser to any image layer, then keyframe Shift X to move the camera.',
        'info',
      );
    },
  );
}
