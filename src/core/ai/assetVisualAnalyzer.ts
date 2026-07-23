import { useAssetStore } from '@stores/assetStore';

/**
 * A neutral, factual listing of the media the user has imported — nothing more.
 *
 * This block used to fabricate a "Visual Content" description and a "Key Palette"
 * for every asset by guessing from the filename (logo→blue, product→pink, …).
 * That was a lie the model could not tell from truth: it read as real visual
 * analysis, made every asset look like the obvious centrepiece of the scene, and
 * pushed the model to drop the user's files into videos that never asked for
 * them. We do not analyse pixels here, so we no longer pretend to.
 *
 * Assets are OPT-IN. When the user's prompt says nothing about their media, the
 * best result is almost always a scene composed from shapes and text — not a
 * random photo pasted onto the canvas. The guard line below states that plainly,
 * and when nothing is imported we emit nothing at all (no wasted tokens, no
 * standing invitation to go looking for files).
 */
export function getAssetsVisualContext(): string {
  const assets = useAssetStore.getState().assets;
  if (!assets.length) return '';

  const lines = assets.map((a) => {
    const dims = a.metadata?.width && a.metadata?.height ? ` ${a.metadata.width}x${a.metadata.height}` : '';
    const dur = a.metadata?.duration ? ` (${a.metadata.duration.toFixed(1)}s)` : '';
    return `- id "${a.id}" · "${a.name}" · ${a.type}${dims}${dur}`;
  });

  return (
    `Media the user has imported (available via create_media, but OPT-IN):\n${lines.join('\n')}\n` +
    `Use these ONLY when the request explicitly asks for the user's own media (their logo, ` +
    `photo, video, "my image", a named file, etc.). If the prompt does not mention media, IGNORE ` +
    `this list entirely and design the scene from shapes and text — do not paste an imported file ` +
    `into a video that did not ask for one.`
  );
}
