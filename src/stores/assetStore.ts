import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { shortId } from '@utils/lang';
import { api, isAuthenticated } from '@core/api/client';
import { AssetDatabase } from '@core/services/AssetDatabase';
import { isLocalFirst } from '@core/config/flags';
import { importLocalAsset } from '@core/assets/local/importLocalAsset';

export interface ImportedAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size: number;
  /** Folder this asset lives in (null = library root). Organisation only. */
  folderId?: string | null;
  /**
   * Small preview object URL for the Assets panel grid. Falls back to `src`
   * when absent (SVG, video, audio, or thumbnailing failed). Using this instead
   * of the full-res `src` is what keeps the panel fast with many images.
   */
  thumbSrc?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
  };
}

/** Longest edge (px) of a generated panel thumbnail — comfortably sharp for the
 *  32px slot on hi-dpi displays while staying a few KB. */
const THUMB_MAX = 96;

/**
 * Decode an image file and re-encode a small thumbnail. Uses createImageBitmap
 * (off-main-thread decode) + an OffscreenCanvas when available. Returns null for
 * vector/undecodable inputs so the caller keeps the original as its own preview.
 */
async function makeImageThumb(file: File): Promise<Blob | null> {
  // SVG is vector text — tiny already, and rasterizing loses crispness.
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return null;
  if (typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.82));
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
}

/**
 * Read an SVG's intrinsic pixel size from its `width`/`height` attributes, or
 * failing that from the `viewBox` aspect. Returns null if the text can't be
 * parsed, so the caller can fall back to the <img> probe.
 */
async function readSvgIntrinsicSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const text = await file.text();
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('svg');
    if (!svg) return null;
    const parseLen = (v: string | null): number | null => {
      if (!v) return null;
      const n = parseFloat(v); // ignores unit suffixes (px, pt) and %
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const w = parseLen(svg.getAttribute('width'));
    const h = parseLen(svg.getAttribute('height'));
    if (w && h) return { width: w, height: h };

    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
        // One known dimension pins the scale; otherwise use the viewBox px size.
        if (w) return { width: w, height: (w * parts[3]!) / parts[2]! };
        if (h) return { width: (h * parts[2]!) / parts[3]!, height: h };
        return { width: parts[2]!, height: parts[3]! };
      }
    }
    return null;
  } catch {
    return null;
  }
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
  /** High-performance batch import for multiple files/folders. */
  addAssetsBatch: (items: Array<{ file: File; folderId?: string | null }>) => Promise<ImportedAsset[]>;
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
      // Local-first (principles 2 & 3): content-address the bytes into the open
      // project bundle and render from disk — never upload. Falls through to the
      // in-memory object-URL path (still upload-free) if no bundle is open.
      if (isLocalFirst()) {
        const imported = await importLocalAsset(file);
        if (imported) {
          const type: 'image' | 'video' | 'audio' =
            imported.record.type === 'video' ? 'video' : imported.record.type === 'audio' ? 'audio' : 'image';
          const asset: ImportedAsset = {
            id: imported.record.id,
            name: file.name,
            type,
            src: imported.src,
            size: file.size,
            folderId,
            ...(imported.metadata ? { metadata: imported.metadata } : {}),
          };
          set((s) => {
            s.assets.push(asset);
          });
          saveAssignments(get().assets);
          return asset;
        }
      }

      // Signed in → upload to the backend and use the served URL (persists,
      // fetchable by the render service). Otherwise fall back to a local blob.
      // Skipped entirely under local-first, which never auto-uploads.
      if (isAuthenticated() && !isLocalFirst()) {
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
        // SVG: derive intrinsic size from width/height or viewBox. An <img>
        // reports a bogus 300×150 default for viewBox-only SVGs, which would
        // give the inserted layer the wrong aspect ratio.
        const svgSize = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
          ? await readSvgIntrinsicSize(file)
          : null;
        if (svgSize) {
          asset.metadata = svgSize;
        } else {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              asset.metadata = { width: img.width, height: img.height };
              resolve();
            };
            img.onerror = () => resolve();
            img.src = src;
          });
        }
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

      // Downscaled panel preview (images only) — keeps the grid fast.
      const thumb = type === 'image' ? await makeImageThumb(file) : null;
      if (thumb) asset.thumbSrc = URL.createObjectURL(thumb);

      // Save to IndexedDB for local persistence
      await AssetDatabase.saveAsset({
        id,
        name: file.name,
        type,
        size: file.size,
        metadata: asset.metadata,
        data: file,
        thumb: thumb ?? undefined,
      }).catch((err) => console.error('[AssetStore] failed to save to IndexedDB:', err));

      set((s) => {
        s.assets.push(asset);
      });
      saveAssignments(get().assets);

      return asset;
    },

    addAssetsBatch: async (items: Array<{ file: File; folderId?: string | null }>): Promise<ImportedAsset[]> => {
      if (items.length === 0) return [];
      const createdAssets: ImportedAsset[] = [];
      // Thumbnail blobs, index-aligned with createdAssets (null = keep original).
      const thumbs: Array<Blob | null> = [];

      // Process metadata + thumbnails in parallel chunks of 10 for max speed
      const CHUNK = 10;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const chunkResults = await Promise.all(
          chunk.map(async ({ file, folderId }) => {
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
              folderId: folderId ?? null,
            };

            let thumb: Blob | null = null;
            if (type === 'image') {
              const svgSize = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
                ? await readSvgIntrinsicSize(file)
                : null;
              if (svgSize) {
                asset.metadata = svgSize;
              }
              // Downscaled preview so the panel doesn't decode full-res originals.
              thumb = await makeImageThumb(file);
              if (thumb) asset.thumbSrc = URL.createObjectURL(thumb);
            }
            return { asset, thumb };
          })
        );
        for (const r of chunkResults) {
          createdAssets.push(r.asset);
          thumbs.push(r.thumb);
        }
      }

      // Save to IndexedDB in parallel
      await Promise.all(
        createdAssets.map((asset, index) => {
          const file = items[index]?.file;
          if (!file) return Promise.resolve();
          return AssetDatabase.saveAsset({
            id: asset.id,
            name: asset.name,
            type: asset.type,
            size: asset.size,
            metadata: asset.metadata,
            data: file,
            thumb: thumbs[index] ?? undefined,
          }).catch((err) => console.error('[AssetStore] failed to save to IndexedDB:', err));
        })
      );

      // Single Zustand state update + single localStorage assignment save
      set((s) => {
        s.assets.push(...createdAssets);
      });
      saveAssignments(get().assets);

      return createdAssets;
    },

    removeAsset: (id) => {
      const asset = get().assets.find((a) => a.id === id);
      if (asset) {
        if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
        if (asset.thumbSrc?.startsWith('blob:')) URL.revokeObjectURL(asset.thumbSrc);
        void AssetDatabase.deleteAsset(id).catch(() => undefined);
        if (isAuthenticated()) void api.deleteAsset(id).catch(() => undefined);
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
      const state = get();
      // Collect the folder and ALL nested descendant folders.
      const doomedFolders = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of state.folders) {
          if (f.parentId && doomedFolders.has(f.parentId) && !doomedFolders.has(f.id)) {
            doomedFolders.add(f.id);
            grew = true;
          }
        }
      }
      // Delete every asset inside any doomed folder (with the same cleanup as
      // removeAsset — revoke blob URLs and delete from the backend/local DB).
      const doomedAssets = state.assets.filter((a) => a.folderId != null && doomedFolders.has(a.folderId));
      for (const a of doomedAssets) {
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
        if (a.thumbSrc?.startsWith('blob:')) URL.revokeObjectURL(a.thumbSrc);
        void AssetDatabase.deleteAsset(a.id).catch(() => undefined);
        if (isAuthenticated()) void api.deleteAsset(a.id).catch(() => undefined);
      }
      set((s) => {
        s.folders = s.folders.filter((f) => !doomedFolders.has(f.id));
        s.assets = s.assets.filter((a) => !(a.folderId != null && doomedFolders.has(a.folderId)));
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
          // Reuse the persisted thumbnail so reload stays as fast as import.
          thumbSrc: dbAsset.thumb ? URL.createObjectURL(dbAsset.thumb) : undefined,
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
