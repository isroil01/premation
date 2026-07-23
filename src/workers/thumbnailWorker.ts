import { renderThumbnailBlob } from '@core/export/exportManager';

self.addEventListener('message', async (event: MessageEvent) => {
  const { width, height, background, transparent } = event.data as {
    width: number;
    height: number;
    background: string;
    transparent: boolean;
  };
  try {
    const blob = await renderThumbnailBlob({ width, height, background, transparent });
    // Post back the blob (or null if rendering failed)
    (self as any).postMessage(blob ?? null);
  } catch (e) {
    // Swallow errors; send null to indicate failure
    (self as any).postMessage(null);
  }
});
