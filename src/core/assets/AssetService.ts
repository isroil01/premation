import type { Asset, ID } from '../types';

export class AssetService {
  private assets = new Map<ID, Asset>();

  register(asset: Asset): void {
    this.assets.set(asset.id, asset);
  }

  get(id: ID): Asset | undefined {
    return this.assets.get(id);
  }

  list(): Asset[] {
    return Array.from(this.assets.values());
  }

  async load(id: ID): Promise<Asset | undefined> {
    const a = this.assets.get(id);
    if (!a) return undefined;
    try {
      const res = await fetch(a.src);
      const blob = await res.blob();
      a.metadata = { ...(a.metadata ?? {}), size: (blob as any).size, type: (blob as any).type };
      return a;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[AssetService] load error', e);
      return a;
    }
  }

  remove(id: ID): boolean {
    return this.assets.delete(id);
  }
}

export default AssetService;
