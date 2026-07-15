import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { shortId } from '@utils/lang';
import { api, isAuthenticated } from '@core/api/client';
import { AssetDatabase } from '@core/services/AssetDatabase';

export interface ImportedAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size: number;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
  };
}

interface AssetStoreState {
  assets: ImportedAsset[];
}

interface AssetStoreActions {
  addAsset: (file: File) => Promise<ImportedAsset>;
  removeAsset: (id: string) => void;
  /** Replace the local list with the signed-in user's cloud assets. */
  loadFromCloud: () => Promise<void>;
  /** Initialize local assets hydrated from IndexedDB. */
  initialize: () => Promise<void>;
}

export const useAssetStore = create<AssetStoreState & AssetStoreActions>()(
  immer((set, get) => ({
    assets: [],

    addAsset: async (file: File) => {
      // Signed in → upload to the backend and use the served URL (persists,
      // fetchable by the render service). Otherwise fall back to a local blob.
      if (isAuthenticated()) {
        try {
          const uploaded = await api.uploadAsset(file);
          set((s) => {
            s.assets.push(uploaded);
          });
          return uploaded;
        } catch {
          // fall through to local blob on failure
        }
      }

      const id = `asset_${shortId()}`;
      const src = URL.createObjectURL(file);
      let type: 'image' | 'video' | 'audio' = 'image';

      if (file.type.startsWith('video/')) type = 'video';
      else if (file.type.startsWith('audio/')) type = 'audio';

      const asset: ImportedAsset = {
        id,
        name: file.name,
        type,
        src,
        size: file.size,
      };

      // Read dimensions or duration if possible
      if (type === 'image') {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            asset.metadata = { width: img.width, height: img.height };
            resolve();
          };
          img.onerror = () => resolve();
          img.src = src;
        });
      } else if (type === 'audio') {
        await new Promise<void>((resolve) => {
          const audio = new Audio();
          audio.onloadedmetadata = () => {
            asset.metadata = { duration: audio.duration };
            resolve();
          };
          audio.onerror = () => resolve();
          audio.src = src;
        });
      } else if (type === 'video') {
        await new Promise<void>((resolve) => {
          const video = document.createElement('video');
          video.onloadedmetadata = () => {
            asset.metadata = {
              width: video.videoWidth,
              height: video.videoHeight,
              duration: video.duration,
            };
            resolve();
          };
          video.onerror = () => resolve();
          video.src = src;
        });
      }

      // Save to IndexedDB for local persistence
      await AssetDatabase.saveAsset({
        id,
        name: file.name,
        type,
        size: file.size,
        metadata: asset.metadata,
        data: file,
      }).catch((err) => console.error('[AssetStore] failed to save to IndexedDB:', err));

      set((s) => {
        s.assets.push(asset);
      });

      return asset;
    },

    removeAsset: (id) => {
      const asset = get().assets.find((a) => a.id === id);
      if (asset) {
        // Only blob URLs need revoking; served cloud URLs are plain http(s).
        if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
        if (isAuthenticated()) void api.deleteAsset(id).catch(() => undefined);
        else void AssetDatabase.deleteAsset(id).catch(() => undefined);
      }
      set((s) => {
        s.assets = s.assets.filter((a) => a.id !== id);
      });
    },

    loadFromCloud: async () => {
      if (!isAuthenticated()) return;
      try {
        const cloud = await api.listAssets();
        set((s) => {
          s.assets = cloud;
        });
      } catch {
        /* offline — keep local list */
      }
    },

    initialize: async () => {
      try {
        const dbAssets = await AssetDatabase.getAllAssets();
        const hydratedAssets: ImportedAsset[] = dbAssets.map((dbAsset) => ({
          id: dbAsset.id,
          name: dbAsset.name,
          type: dbAsset.type,
          src: URL.createObjectURL(dbAsset.data),
          size: dbAsset.size,
          metadata: dbAsset.metadata,
        }));
        set((s) => {
          const existingIds = new Set(s.assets.map((a) => a.id));
          for (const ha of hydratedAssets) {
            if (!existingIds.has(ha.id)) {
              s.assets.push(ha);
            }
          }
        });
      } catch (err) {
        console.error('[AssetStore] failed to initialize from IndexedDB:', err);
      }
    },
  })),
);
