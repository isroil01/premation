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
  /** Folder this asset lives in (null = library root). Organisation only. */
  folderId?: string | null;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
  };
}

/** A user-created folder for organising assets (After Effects "Project" folders). */
export interface AssetFolder {
  id: string;
  name: string;
  /** Parent folder id, or null for a top-level folder. */
  parentId: string | null;
}

interface AssetStoreState {
  assets: ImportedAsset[];
  folders: AssetFolder[];
}

interface AssetStoreActions {
  /** Import a file, optionally into a folder, and add it to the library. */
  addAsset: (file: File, folderId?: string | null) => Promise<ImportedAsset>;
  removeAsset: (id: string) => void;
  /** Create a folder and return it. */
  createFolder: (name: string, parentId?: string | null) => AssetFolder;
  renameFolder: (id: string, name: string) => void;
  /** Delete a folder; its assets and subfolders move up to its parent. */
  removeFolder: (id: string) => void;
  /** Move an asset into a folder (null = root). */
  moveAssetToFolder: (assetId: string, folderId: string | null) => void;
  /** Replace the local list with the signed-in user's cloud assets. */
  loadFromCloud: () => Promise<void>;
  /** Initialize local assets hydrated from IndexedDB. */
  initialize: () => Promise<void>;
}

// ── Client-side organisation persistence ───────────────────────────
// Folders and asset→folder assignments are a pure organisation layer, kept in
// localStorage so they work identically for cloud and local (IndexedDB) assets
// without any backend schema change. Cloud/IndexedDB round-trips don't carry
// folderId, so we re-apply the saved assignment map after every load.
const FOLDERS_KEY = 'motion-editor.assetFolders.v1';
const ASSIGN_KEY = 'motion-editor.assetFolderAssignments.v1';

function loadFolders(): AssetFolder[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as AssetFolder[]) : [];
  } catch {
    return [];
  }
}

function saveFolders(folders: AssetFolder[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* quota / private mode — ignore */
  }
}

function loadAssignments(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ASSIGN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveAssignments(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, string> = {};
    for (const a of assets) if (a.folderId) map[a.id] = a.folderId;
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Overlay the saved folder assignments onto a freshly loaded asset list. */
function applyAssignments(assets: ImportedAsset[], folders: AssetFolder[]): ImportedAsset[] {
  const map = loadAssignments();
  const validFolder = new Set(folders.map((f) => f.id));
  return assets.map((a) => {
    const fid = map[a.id];
    return { ...a, folderId: fid && validFolder.has(fid) ? fid : a.folderId ?? null };
  });
}

export const useAssetStore = create<AssetStoreState & AssetStoreActions>()(
  immer((set, get) => ({
    assets: [],
    folders: loadFolders(),

    addAsset: async (file: File, folderId: string | null = null) => {
      // Signed in → upload to the backend and use the served URL (persists,
      // fetchable by the render service). Otherwise fall back to a local blob.
      if (isAuthenticated()) {
        try {
          const uploaded = await api.uploadAsset(file);
          const withFolder = { ...uploaded, folderId };
          set((s) => {
            s.assets.push(withFolder);
          });
          saveAssignments(get().assets);
          return withFolder;
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
        folderId,
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
      saveAssignments(get().assets);

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
      saveAssignments(get().assets);
    },

    createFolder: (name, parentId = null) => {
      const folder: AssetFolder = { id: `folder_${shortId()}`, name: name.trim() || 'Untitled Folder', parentId };
      set((s) => {
        s.folders.push(folder);
      });
      saveFolders(get().folders);
      return folder;
    },

    renameFolder: (id, name) => {
      set((s) => {
        const f = s.folders.find((x) => x.id === id);
        if (f) f.name = name.trim() || f.name;
      });
      saveFolders(get().folders);
    },

    removeFolder: (id) => {
      set((s) => {
        const target = s.folders.find((f) => f.id === id);
        const parent = target?.parentId ?? null;
        // Reparent direct child folders and lift assets to the deleted folder's parent.
        for (const f of s.folders) if (f.parentId === id) f.parentId = parent;
        for (const a of s.assets) if (a.folderId === id) a.folderId = parent;
        s.folders = s.folders.filter((f) => f.id !== id);
      });
      saveFolders(get().folders);
      saveAssignments(get().assets);
    },

    moveAssetToFolder: (assetId, folderId) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (a) a.folderId = folderId;
      });
      saveAssignments(get().assets);
    },

    loadFromCloud: async () => {
      if (!isAuthenticated()) return;
      try {
        const cloud = (await api.listAssets(undefined, { limit: 100 })).items;
        set((s) => {
          s.assets = applyAssignments(cloud, s.folders);
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
          const fresh = applyAssignments(
            hydratedAssets.filter((ha) => !existingIds.has(ha.id)),
            s.folders,
          );
          for (const ha of fresh) s.assets.push(ha);
        });
      } catch (err) {
        console.error('[AssetStore] failed to initialize from IndexedDB:', err);
      }
    },
  })),
);
