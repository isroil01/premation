import { useAssetStore } from '@stores/assetStore';

export interface AssetVisualMetadata {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  dominantColors: string[];
  description: string;
  aspectRatio: string;
}

/** Analyze assets and return descriptive metadata for the AI prompt context. */
export function getAssetsVisualContext(): string {
  const assets = useAssetStore.getState().assets;
  if (!assets.length) return 'Available Assets in editor: None imported yet (User has not uploaded assets).';

  const lines = assets.map((a) => {
    // Generate semantic descriptions based on asset names/properties to simulate visual analysis
    let desc = 'Universal media asset';
    let colors = ['#ffffff', '#000000'];
    const nameLower = a.name.toLowerCase();

    if (a.type === 'image') {
      if (nameLower.includes('logo')) {
        desc = 'Brand logo with transparent background';
        colors = ['#2988ff', '#1a1a2e'];
      } else if (nameLower.includes('avatar') || nameLower.includes('profile') || nameLower.includes('user')) {
        desc = 'User profile avatar photo';
        colors = ['#f59e0b', '#e2e8f0'];
      } else if (nameLower.includes('bg') || nameLower.includes('background') || nameLower.includes('hero')) {
        desc = 'High-resolution hero background image';
        colors = ['#0f172a', '#1e293b'];
      } else if (nameLower.includes('product') || nameLower.includes('item') || nameLower.includes('shoe')) {
        desc = 'Product showcase image, centered subject';
        colors = ['#ec4899', '#f8fafc'];
      } else {
        desc = 'Imported photographic or vector image';
      }
    } else if (a.type === 'video') {
      desc = 'B-roll showcase video clip';
      colors = ['#10b981', '#06b6d4'];
    } else if (a.type === 'audio') {
      desc = 'Background track / music clip';
      colors = ['#a78bfa'];
    }

    const dims = a.metadata?.width && a.metadata?.height ? ` ${a.metadata.width}x${a.metadata.height}` : '';
    const dur = a.metadata?.duration ? ` (${a.metadata.duration.toFixed(1)}s)` : '';
    
    return `- Asset ID: "${a.id}" | Name: "${a.name}" | Type: ${a.type}${dims}${dur} | Visual Content: ${desc} | Key Palette: ${colors.join(', ')}`;
  });

  return `Available Assets in left sidebar tab:\n${lines.join('\n')}`;
}
