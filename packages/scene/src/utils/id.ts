/**
 * Identifier generation. Prefers the platform's crypto UUID; falls back to a
 * RFC-4122-shaped v4 generator so the engine stays dependency-free and works
 * in any JS runtime.
 */

import type { NodeId } from '../types';

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
}

function platformCrypto(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

/** Generate a v4-style UUID. */
export function uuid(): string {
  const c = platformCrypto();
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Per RFC 4122 §4.4: set version (4) and variant (10xx).
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  const b = bytes;
  return (
    hex[b[0]!]! + hex[b[1]!]! + hex[b[2]!]! + hex[b[3]!]! + '-' +
    hex[b[4]!]! + hex[b[5]!]! + '-' +
    hex[b[6]!]! + hex[b[7]!]! + '-' +
    hex[b[8]!]! + hex[b[9]!]! + '-' +
    hex[b[10]!]! + hex[b[11]!]! + hex[b[12]!]! + hex[b[13]!]! + hex[b[14]!]! + hex[b[15]!]!
  );
}

/** Generate a branded node id. */
export function newNodeId(): NodeId {
  return uuid() as NodeId;
}
