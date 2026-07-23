/**
 * UI Kit library — ready-made, high-end interface components (music players,
 * analytics cards, search bars, CTA banners, glass credit cards, device frames …)
 * for product-demo and app-promo motion design work.
 *
 * Each item is authored as an ultra-modern, self-contained vector SVG component.
 * On insert, `insertSvgShapeGroup` builds a unified master group node (`kind: 'group'`)
 * containing the vector shapes and text layers.
 *
 * Single-Body Integrity: Clicking and dragging the UI component on canvas moves the
 * ENTIRE UI COMPONENT AS ONE SOLID UNIFIED BODY. Designers can double-click or select
 * sub-layers in the Scene panel to customize colors or text labels.
 */

import { insertImageNode, insertSvgShapeGroup } from '@core/scene/sceneInsert';

export type UiCategory = 'buttons' | 'inputs' | 'toggles' | 'feedback' | 'containers' | 'devices';

export interface UiComponent {
  id: string;
  name: string;
  cat: UiCategory;
  width: number;
  height: number;
  /** Full, self-contained SVG markup. */
  svg: string;
}

// ── Shared modern design tokens ─────────────────────────────────────────────
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const C = {
  primary: '#6366f1',
  accent: '#a855f7',
  cyan: '#38bdf8',
  pink: '#ec4899',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  darkBg: '#090d16',
  darkSurface: '#0f172a',
  surfaceCard: '#1e293b',
  borderGlass: '#334155',
  textPrimary: '#f8fafc',
  textMuted: '#94a3b8',
  textDim: '#64748b',
};

/** Wrap inner markup in a sized root <svg> (viewBox + explicit width/height). */
function svg(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">${inner}</svg>`;
}

// ── Ultra-Modern Component Library ──────────────────────────────────────────
const ITEMS: UiComponent[] = [
  {
    id: 'btn-primary',
    name: 'Glowing Action Button',
    cat: 'buttons',
    width: 220,
    height: 52,
    svg: svg(220, 52, `
      <rect x="4" y="4" width="212" height="44" rx="14" fill="${C.primary}" stroke="${C.accent}" stroke-width="1.5"/>
      <text x="100" y="31" fill="#ffffff" font-size="15" font-weight="700" text-anchor="middle">Get Started</text>
      <path d="M152 26h14 M162 21l5 5-5 5" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    `),
  },
  {
    id: 'btn-secondary',
    name: 'Glass Cyber Button',
    cat: 'buttons',
    width: 200,
    height: 52,
    svg: svg(200, 52, `
      <rect x="4" y="4" width="192" height="44" rx="14" fill="${C.surfaceCard}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <text x="100" y="31" fill="${C.textPrimary}" font-size="15" font-weight="600" text-anchor="middle">Explore Features</text>
    `),
  },
  {
    id: 'btn-icon-pulse',
    name: 'Action Icon Pill',
    cat: 'buttons',
    width: 140,
    height: 48,
    svg: svg(140, 48, `
      <rect x="4" y="4" width="132" height="40" rx="20" fill="${C.darkSurface}" stroke="${C.primary}" stroke-width="1.5"/>
      <circle cx="28" cy="24" r="12" fill="${C.primary}"/>
      <path d="M25 19l8 5-8 5z" fill="#ffffff"/>
      <text x="82" y="29" fill="${C.textPrimary}" font-size="14" font-weight="600">Play Video</text>
    `),
  },
  {
    id: 'player-widget',
    name: 'Glass Music Player',
    cat: 'containers',
    width: 360,
    height: 140,
    svg: svg(360, 140, `
      <rect x="4" y="4" width="352" height="132" rx="20" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <rect x="20" y="20" width="76" height="76" rx="14" fill="${C.accent}"/>
      <circle cx="58" cy="58" r="18" fill="${C.primary}"/>
      <text x="112" y="44" fill="${C.textPrimary}" font-size="16" font-weight="700">Midnight City</text>
      <text x="112" y="66" fill="${C.textMuted}" font-size="13">M83 • Synthwave Edition</text>
      <rect x="112" y="86" width="220" height="6" rx="3" fill="${C.surfaceCard}"/>
      <rect x="112" y="86" width="130" height="6" rx="3" fill="${C.cyan}"/>
      <circle cx="242" cy="89" r="6" fill="#ffffff"/>
      <text x="112" y="112" fill="${C.textDim}" font-size="11" font-weight="600">02:14</text>
      <text x="332" y="112" fill="${C.textDim}" font-size="11" font-weight="600" text-anchor="end">04:05</text>
    `),
  },
  {
    id: 'stats-card',
    name: 'Glowing Analytics Card',
    cat: 'containers',
    width: 320,
    height: 180,
    svg: svg(320, 180, `
      <rect x="4" y="4" width="312" height="172" rx="20" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <text x="24" y="34" fill="${C.textMuted}" font-size="13" font-weight="600">Active Monthly Users</text>
      <text x="24" y="70" fill="${C.textPrimary}" font-size="28" font-weight="800">248,920</text>
      <rect x="216" y="46" width="80" height="26" rx="13" fill="#064e3b"/>
      <text x="256" y="63" fill="${C.emerald}" font-size="12" font-weight="700" text-anchor="middle">+18.4% ↑</text>
      <path d="M24 140 L70 120 L120 135 L170 100 L220 115 L296 85" stroke="${C.cyan}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle cx="296" cy="85" r="5" fill="${C.cyan}"/>
    `),
  },
  {
    id: 'search-bar',
    name: 'Glass Command Bar',
    cat: 'inputs',
    width: 320,
    height: 52,
    svg: svg(320, 52, `
      <rect x="4" y="4" width="312" height="44" rx="22" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <circle cx="28" cy="26" r="7" fill="none" stroke="${C.cyan}" stroke-width="2"/>
      <path d="M33 31l5 5" stroke="${C.cyan}" stroke-width="2" stroke-linecap="round"/>
      <text x="50" y="31" fill="${C.textMuted}" font-size="14">Search components or commands…</text>
      <rect x="274" y="14" width="34" height="24" rx="6" fill="${C.surfaceCard}"/>
      <text x="291" y="30" fill="${C.textMuted}" font-size="11" font-weight="700" text-anchor="middle">⌘K</text>
    `),
  },
  {
    id: 'input-text',
    name: 'Glass Input Field',
    cat: 'inputs',
    width: 280,
    height: 72,
    svg: svg(280, 72, `
      <text x="4" y="16" fill="${C.textMuted}" font-size="13" font-weight="600">Email Address</text>
      <rect x="4" y="24" width="272" height="44" rx="12" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <text x="20" y="51" fill="${C.textPrimary}" font-size="14">alex.rivera@design.co</text>
    `),
  },
  {
    id: 'toast-notification',
    name: 'Floating Glass Toast',
    cat: 'feedback',
    width: 340,
    height: 76,
    svg: svg(340, 76, `
      <rect x="4" y="4" width="332" height="68" rx="18" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <rect x="4" y="4" width="8" height="68" rx="4" fill="${C.emerald}"/>
      <circle cx="36" cy="38" r="14" fill="#064e3b"/>
      <path d="M30 38l4 4 8-8" stroke="${C.emerald}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="62" y="34" fill="${C.textPrimary}" font-size="15" font-weight="700">Export Complete</text>
      <text x="62" y="54" fill="${C.textMuted}" font-size="12">Rendered 4K MP4 composition in 1.2s</text>
    `),
  },
  {
    id: 'cta-card',
    name: 'Gradient Hero Banner',
    cat: 'containers',
    width: 360,
    height: 180,
    svg: svg(360, 180, `
      <rect x="4" y="4" width="352" height="172" rx="20" fill="${C.primary}" stroke="${C.accent}" stroke-width="1.5"/>
      <text x="24" y="44" fill="#ffffff" font-size="20" font-weight="800">Supercharge Motion Flow</text>
      <text x="24" y="70" fill="#c7d2fe" font-size="13">Build next-generation animation apps instantly.</text>
      <rect x="24" y="104" width="150" height="42" rx="12" fill="#ffffff"/>
      <text x="99" y="130" fill="${C.primary}" font-size="14" font-weight="700" text-anchor="middle">Start Free Trial →</text>
    `),
  },
  {
    id: 'profile-card',
    name: 'User Profile Card',
    cat: 'containers',
    width: 320,
    height: 150,
    svg: svg(320, 150, `
      <rect x="4" y="4" width="312" height="142" rx="20" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <circle cx="44" cy="48" r="24" fill="${C.pink}"/>
      <circle cx="58" cy="60" r="8" fill="${C.cyan}"/>
      <text x="80" y="42" fill="${C.textPrimary}" font-size="16" font-weight="700">Sarah Connor</text>
      <text x="80" y="62" fill="${C.textMuted}" font-size="13">@sarah_motion • Senior Designer</text>
      <rect x="24" y="90" width="128" height="36" rx="10" fill="${C.primary}"/>
      <text x="88" y="113" fill="#ffffff" font-size="13" font-weight="700" text-anchor="middle">Follow</text>
      <rect x="160" y="90" width="136" height="36" rx="10" fill="${C.surfaceCard}" stroke="${C.borderGlass}" stroke-width="1"/>
      <text x="228" y="113" fill="${C.textPrimary}" font-size="13" font-weight="600" text-anchor="middle">Message</text>
    `),
  },
  {
    id: 'audio-waveform',
    name: 'Audio Waveform Card',
    cat: 'feedback',
    width: 340,
    height: 100,
    svg: svg(340, 100, `
      <rect x="4" y="4" width="332" height="92" rx="18" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <circle cx="34" cy="50" r="16" fill="${C.primary}"/>
      <path d="M31 43l9 7-9 7z" fill="#ffffff"/>
      <rect x="64" y="30" width="4" height="40" rx="2" fill="${C.cyan}"/>
      <rect x="74" y="20" width="4" height="60" rx="2" fill="${C.primary}"/>
      <rect x="84" y="35" width="4" height="30" rx="2" fill="${C.accent}"/>
      <rect x="94" y="15" width="4" height="70" rx="2" fill="${C.cyan}"/>
      <rect x="104" y="25" width="4" height="50" rx="2" fill="${C.primary}"/>
      <rect x="114" y="40" width="4" height="20" rx="2" fill="${C.accent}"/>
      <rect x="124" y="22" width="4" height="56" rx="2" fill="${C.cyan}"/>
      <rect x="134" y="18" width="4" height="64" rx="2" fill="${C.primary}"/>
      <rect x="144" y="32" width="4" height="36" rx="2" fill="${C.accent}"/>
      <rect x="154" y="26" width="4" height="48" rx="2" fill="${C.cyan}"/>
      <rect x="164" y="42" width="4" height="16" rx="2" fill="${C.surfaceCard}"/>
      <rect x="174" y="38" width="4" height="24" rx="2" fill="${C.surfaceCard}"/>
      <rect x="184" y="45" width="4" height="10" rx="2" fill="${C.surfaceCard}"/>
      <text x="270" y="55" fill="${C.textMuted}" font-size="13" font-weight="600">01:42 / 03:30</text>
    `),
  },
  {
    id: 'glass-credit-card',
    name: 'Glass Credit Card',
    cat: 'containers',
    width: 340,
    height: 210,
    svg: svg(340, 210, `
      <rect x="4" y="4" width="332" height="202" rx="20" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <rect x="24" y="30" width="42" height="30" rx="6" fill="${C.amber}"/>
      <text x="24" y="104" fill="${C.textPrimary}" font-size="20" font-weight="700" letter-spacing="3">•••• •••• •••• 9842</text>
      <text x="24" y="148" fill="${C.textDim}" font-size="10" font-weight="600">CARDHOLDER</text>
      <text x="24" y="168" fill="${C.textPrimary}" font-size="14" font-weight="700">ALEXANDER RIVERA</text>
      <text x="220" y="148" fill="${C.textDim}" font-size="10" font-weight="600">EXPIRES</text>
      <text x="220" y="168" fill="${C.textPrimary}" font-size="14" font-weight="700">09/28</text>
      <circle cx="280" cy="45" r="16" fill="${C.rose}"/>
      <circle cx="298" cy="45" r="16" fill="${C.amber}"/>
    `),
  },
  {
    id: 'toggle-modern',
    name: 'Glowing Modern Toggle',
    cat: 'toggles',
    width: 72,
    height: 40,
    svg: svg(72, 40, `
      <rect x="4" y="4" width="64" height="32" rx="16" fill="${C.emerald}"/>
      <circle cx="48" cy="20" r="12" fill="#ffffff"/>
    `),
  },
  {
    id: 'phone-frame',
    name: 'Pro Phone Mockup',
    cat: 'devices',
    width: 220,
    height: 440,
    svg: svg(220, 440, `
      <rect x="4" y="4" width="212" height="432" rx="38" fill="${C.darkBg}" stroke="${C.borderGlass}" stroke-width="2"/>
      <rect x="14" y="14" width="192" height="412" rx="30" fill="${C.darkSurface}"/>
      <rect x="74" y="22" width="64" height="18" rx="9" fill="${C.darkBg}"/>
      <text x="32" y="35" fill="${C.textPrimary}" font-size="11" font-weight="700">9:41</text>
      <rect x="24" y="56" width="172" height="120" rx="16" fill="${C.primary}"/>
      <rect x="24" y="190" width="172" height="18" rx="9" fill="${C.surfaceCard}"/>
      <rect x="24" y="218" width="120" height="18" rx="9" fill="${C.surfaceCard}"/>
    `),
  },
  {
    id: 'browser-frame',
    name: 'Pro Browser Window',
    cat: 'devices',
    width: 380,
    height: 250,
    svg: svg(380, 250, `
      <rect x="4" y="4" width="372" height="242" rx="16" fill="${C.darkSurface}" stroke="${C.borderGlass}" stroke-width="1.5"/>
      <rect x="4" y="4" width="372" height="36" rx="16" fill="${C.darkBg}"/>
      <rect x="4" y="24" width="372" height="16" fill="${C.darkBg}"/>
      <circle cx="24" cy="22" r="5" fill="${C.rose}"/>
      <circle cx="40" cy="22" r="5" fill="${C.amber}"/>
      <circle cx="56" cy="22" r="5" fill="${C.emerald}"/>
      <rect x="76" y="12" width="280" height="20" rx="10" fill="${C.darkSurface}"/>
      <text x="88" y="26" fill="${C.textMuted}" font-size="11">https://motioneditor.app</text>
    `),
  },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export const UI_COMPONENTS: ReadonlyArray<UiComponent> = ITEMS;

export function getUiComponent(id: string): UiComponent | undefined {
  return BY_ID.get(id);
}

/** A self-contained `data:` URL for a component's SVG (persists in the doc). */
export function uiComponentDataUrl(id: string): string | null {
  const item = BY_ID.get(id);
  if (!item) return null;
  return `data:image/svg+xml,${encodeURIComponent(item.svg)}`;
}

/** Dynamically recolor / retext a UI component's SVG markup. */
export function updateUiComponentSvg(itemSvg: string, fill?: string, textContent?: string): string {
  let updated = itemSvg;
  if (fill && fill.startsWith('#')) {
    updated = updated.replace(/fill="#6366f1"/gi, `fill="${fill}"`)
                     .replace(/fill="#10b981"/gi, `fill="${fill}"`)
                     .replace(/stroke="#6366f1"/gi, `stroke="${fill}"`);
  }
  if (textContent) {
    updated = updated.replace(/(<text[^>]*>)([^<]*)(<\/text>)/gi, `$1${textContent}$3`);
  }
  return updated;
}

/**
 * Insert a UI component as an editable, grouped vector shape layer.
 * On insert, `insertSvgShapeGroup` creates a single master group node (`kind: 'group'`).
 * Moving or dragging the component on canvas selects and moves the
 * ENTIRE UI COMPONENT TOGETHER AS ONE SOLID UNIFIED BODY.
 * Double-clicking or selecting sub-layers in the Scene panel allows customization.
 */
export function insertUiComponent(id: string, x?: number, y?: number): string | null {
  const item = BY_ID.get(id);
  if (!item) return null;

  // Insert as an editable vector shape group assembly.
  // Every sub-layer (card background, text label, icon, button) becomes a separate
  // editable node under the Master Group body!
  const groupId = insertSvgShapeGroup(item.svg, item.name, {
    x,
    y,
    targetSize: Math.max(item.width, item.height, 320),
  });
  if (groupId) return groupId;

  // Fallback to high-fidelity vector SVG image node if SVG lacks parsed vector paths
  return insertImageNode({
    name: item.name,
    src: `data:image/svg+xml,${encodeURIComponent(item.svg)}`,
    width: item.width,
    height: item.height,
    x,
    y,
  });
}
