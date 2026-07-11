/**
 * DOM-event normalization helpers. Optional convenience for browser/Electron
 * hosts: translate the platform's `PointerEvent`/`WheelEvent`/`KeyboardEvent`
 * into the workspace's plain input value objects. These touch DOM *types* only
 * (never the DOM tree or rendering), so the core stays framework-independent and
 * a non-browser host can skip this file entirely.
 */

import type { Modifiers, PointerInput, WheelInput, KeyInput, PointerButton, PointerType } from './events';

/** True on macOS, where ⌘ is the primary modifier instead of Ctrl. */
function isApplePlatform(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const s = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/.test(s);
}

interface ModifierBearing {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function modifiersFrom(e: ModifierBearing, apple = isApplePlatform()): Modifiers {
  return {
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
    mod: apple ? e.metaKey : e.ctrlKey,
  };
}

function buttonFrom(button: number): PointerButton {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

/** Minimal structural type for a DOM PointerEvent (avoids a DOM lib dependency). */
export interface DomPointerEventLike extends ModifierBearing {
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  pointerType: string;
  pressure: number;
  pointerId: number;
}

export function pointerFrom(e: DomPointerEventLike, time: number, apple = isApplePlatform()): PointerInput {
  const pointerType: PointerType =
    e.pointerType === 'pen' || e.pointerType === 'touch' ? (e.pointerType as PointerType) : 'mouse';
  return {
    position: { x: e.clientX, y: e.clientY },
    pointerType,
    button: buttonFrom(e.button),
    buttons: {
      left: (e.buttons & 1) !== 0,
      right: (e.buttons & 2) !== 0,
      middle: (e.buttons & 4) !== 0,
    },
    modifiers: modifiersFrom(e, apple),
    pressure: e.pressure || (pointerType === 'mouse' ? 0.5 : 0),
    time,
    pointerId: e.pointerId,
  };
}

export interface DomWheelEventLike extends ModifierBearing {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
}

export function wheelFrom(e: DomWheelEventLike, time: number, apple = isApplePlatform()): WheelInput {
  return {
    position: { x: e.clientX, y: e.clientY },
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    // ctrl+wheel is how browsers report trackpad pinch-zoom.
    isZoom: e.ctrlKey,
    modifiers: modifiersFrom(e, apple),
    time,
  };
}

export interface DomKeyEventLike extends ModifierBearing {
  key: string;
  code: string;
  repeat: boolean;
}

export function keyFrom(e: DomKeyEventLike, time: number, apple = isApplePlatform()): KeyInput {
  return {
    key: e.key,
    code: e.code,
    modifiers: modifiersFrom(e, apple),
    repeat: e.repeat,
    time,
  };
}
