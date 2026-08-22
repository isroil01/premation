/**
 * Detect media sources on a document that will not load after a portable open.
 *
 * Local absolute paths (`C:\…`, `/Users/…`) are the failure mode this exists
 * for: they work on the author's machine and silently vanish everywhere else.
 * HTTP(S), `data:`, `/files/…` and in-package `assets/…` paths travel with the
 * file. `blob:` URLs die with the tab that created them.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';

export interface MissingAssetRef {
  nodeId: string;
  nodeName: string;
  src: string;
  reason: 'blob' | 'local-path' | 'empty';
}

function isHttp(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function isData(src: string): boolean {
  return src.startsWith('data:');
}

function isFiles(src: string): boolean {
  return src.startsWith('/files/');
}

function isPackaged(src: string): boolean {
  return src.startsWith('assets/') || src.startsWith('./assets/');
}

function isBlob(src: string): boolean {
  return src.startsWith('blob:');
}

/** Absolute filesystem path, including `file://` and Windows drive letters. */
export function isLocalFilesystemPath(src: string): boolean {
  if (src.startsWith('file:')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(src)) return true;
  if (src.startsWith('\\\\')) return true;
  // Unix absolute that is not an http path and not a packaged relative.
  if (src.startsWith('/') && !src.startsWith('/files/')) return true;
  return false;
}

function srcOf(node: SceneNode): string | null {
  for (const c of node.components) {
    const src = (c.props as Record<string, unknown>).src;
    if (typeof src === 'string') return src;
  }
  return null;
}

/** Every media source on `doc` that will not survive a reopen as-is. */
export function findMissingAssets(doc: EditorDocument): MissingAssetRef[] {
  const out: MissingAssetRef[] = [];
  const nodes = doc.scene?.nodes ?? [];
  for (const node of nodes) {
    const src = srcOf(node);
    if (src == null) continue;
    const trimmed = src.trim();
    if (!trimmed) {
      out.push({ nodeId: node.id, nodeName: node.name ?? node.id, src: trimmed, reason: 'empty' });
      continue;
    }
    if (isHttp(trimmed) || isData(trimmed) || isFiles(trimmed) || isPackaged(trimmed)) continue;
    if (isBlob(trimmed)) {
      out.push({ nodeId: node.id, nodeName: node.name ?? node.id, src: trimmed, reason: 'blob' });
      continue;
    }
    if (isLocalFilesystemPath(trimmed)) {
      out.push({ nodeId: node.id, nodeName: node.name ?? node.id, src: trimmed, reason: 'local-path' });
    }
  }
  return out;
}

/** Rewrite one node's `src` (every component that carries one). */
export function relinkNodeSrc(doc: EditorDocument, nodeId: string, src: string): boolean {
  const node = doc.scene?.nodes?.find((n) => n.id === nodeId);
  if (!node) return false;
  let wrote = false;
  for (const c of node.components) {
    if ('src' in (c.props as Record<string, unknown>)) {
      (c.props as Record<string, unknown>).src = src;
      wrote = true;
    }
  }
  return wrote;
}
