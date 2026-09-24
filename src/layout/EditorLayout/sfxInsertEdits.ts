/**
 * The Library's Sound FX through the engine API (B3, docs/B3_PATTERNS.md).
 *
 * A sound-effect item is a synthesised WAV: the first insert adds it to the
 * project as an audio item, every insert places an audio layer. The layer goes
 * through the media insert router run off-document (`insertMediaEdit`: one
 * `pasteLayers`, one undo entry, the new layer selected) — the same path a
 * dropped audio file takes.
 *
 * The item is imported from its in-memory bytes (`importBytes`, its own undo
 * entry) the first time it is used.
 */

import { getSfxItem, renderSfxSamples, encodeWavPcm16 } from '@core/library/sfxLibrary';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';

/** The project's audio item for `sfxId`, importing it on first use. Null for an unknown id. */
async function sfxAsset(sfxId: string): Promise<ImportedAsset | null> {
  const item = getSfxItem(sfxId);
  if (!item) return null;
  const fileName = `${item.name}.wav`;
  // Re-use the item a previous insert imported — same bytes anyway.
  const existing = useAssetStore.getState().assets.find((a) => a.type === 'audio' && a.name === fileName);
  let asset = existing;
  if (!asset) {
    const samples = renderSfxSamples(sfxId);
    if (!samples) return null;
    const file = new File([encodeWavPcm16(samples)], fileName, { type: 'audio/wav' });
    // Synthesised in memory — no file on disk — so imported from its bytes.
    const { imported: [made] } = await importBrowserFilesEdit([{ file }], `Import ${fileName}`);
    if (!made) return null;
    asset = made;
  }
  // Some decode paths miss the duration of a blob WAV; the synth knows the
  // exact length, so the layer always gets a real out-point.
  if (!asset.metadata?.duration) {
    asset = { ...asset, metadata: { ...asset.metadata, duration: item.duration } };
  }
  return asset;
}

/**
 * Insert a Sound FX item as an audio layer of the active composition: ONE undo
 * entry ("Insert <name>"), the new layer selected. Resolves to its id, or null
 * when nothing was inserted (unknown item, a refusal — toasted).
 */
export async function insertSfxEdit(sfxId: string): Promise<string | null> {
  const asset = await sfxAsset(sfxId);
  if (!asset) return null;
  const item = getSfxItem(sfxId);
  const ids = await insertMediaEdit([asset], { label: `Insert ${item?.name ?? asset.name}` });
  return ids?.[0] ?? null;
}
