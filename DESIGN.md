---
name: Motion Editor
description: An AI-native, non-destructive motion design tool — a calm dark instrument for professionals.
colors:
  signal-blue: "#3170e6"
  signal-blue-hover: "#4d88f5"
  signal-blue-pressed: "#2660cc"
  temporal-ember: "#ff6b45"
  playhead-coral: "#ff6b45"
  ai-violet: "#8b5cf6"
  void: "#05060a"
  surface-0: "#0b0d12"
  surface-1: "#14171e"
  surface-2: "#1e222c"
  surface-3: "#292e3a"
  ink: "#f5f7fb"
  ink-secondary: "#c6cdd9"
  ink-tertiary: "#94a0b2"
  ink-muted: "#707b8d"
  success: "#10b981"
  warning: "#f5b84b"
  danger: "#f43f5e"
  modified-amber: "#f5b84b"
  layer-text: "#6aa9ff"
  layer-shape: "#3fbfae"
  layer-image: "#e8a33d"
  layer-video: "#e85d75"
  layer-audio: "#4bcb9e"
  layer-camera: "#e8935c"
  layer-light: "#e3c04c"
  layer-null: "#8e9aad"
  layer-3d: "#d47ae8"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.011em"
  body:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.011em"
  label:
    fontFamily: "IBM Plex Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "normal"
  mono:
    fontFamily: "IBM Plex Mono, SF Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "normal"
rounded:
  xs: "3px"
  sm: "4px"
  control: "5px"
  panel: "8px"
  surface: "12px"
  dialog: "16px"
  full: "9999px"
spacing:
  1: "2px"
  2: "4px"
  3: "6px"
  4: "8px"
  5: "12px"
  6: "16px"
  7: "20px"
  8: "24px"
  9: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  input-field:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    height: "28px"
    padding: "0 6px"
---

# Design System: Motion Editor

## 1. Overview

**Creative North Star: "The Control Surface"**

Motion Editor is a color-grading desk after dark: a dense, information-rich instrument built for a professional who will sit in front of it for hours. The surfaces are near-black and calm on purpose — the work being composited is the brightest thing on screen, and the chrome recedes so the eye stays on the canvas and the timeline. This is a *powerful, technical, serious* tool, and the seriousness is carried by precision and restraint, not by ornament. Nothing glows for effect; nothing is rounded to look friendly; every control earns its place in the grid.

Depth here is not drawn with shadows — it is stepped in value. A panel is lighter than the frame behind it; a raised control is lighter still; a recessed input field is darker than the panel it sits in. Region seams are marked with a single hairline, never a heavy divider. The result reads as machined hardware: exact heights (20–44px control sizes), tabular numerics that never jitter as they tick, and one deliberate blue for anything the user has selected or can act on.

The system explicitly rejects two things. It is **not a playful consumer creative app** — no bubbly shapes, sticker-bright multicolor, or template energy; that register reads as unserious to this audience. And it is **not a cluttered legacy pro tool** — no walls of tiny buttons or nested toolbars shouting at once. The answer to complexity is progressive disclosure: calm by default, detail on demand (the timeline shows one quiet summary row per layer until you reveal its per-property keyframes).

**Key Characteristics:**
- Near-black, value-stepped surfaces; depth without shadow.
- One azure accent for selection *and* primary action — nothing decorative.
- A warm/cool split: cool Signal Blue = selection/action; warm Ember = time/now. Violet reserved for AI.
- Machined, recessed controls on an exact spacing and size grid.
- Density that is earned and progressively revealed, never overwhelming.

## 2. Colors

A cool dark field with a deliberate warm/cool tension: a cool selection accent, a warm temporal accent, and one hue (violet) held in reserve for AI. The chrome is faintly cool but is decisively value-stepped, not monochrome-flat.

### Primary
- **Signal Blue** (#3170e6): The single cool accent. It marks selection, primary actions, focus rings, current state — and nothing else. Hover lifts to #4d88f5, pressed drops to #2660cc. Deep enough that white label text on it clears WCAG AA (4.57:1); its scarcity is what makes it legible.

### Secondary — Temporal / Now (warm)
- **Ember** (#ff6b45): The warm counterpoint to the cool selection, and the cool accent's only companion. It owns the **temporal / "now"** family: the timeline playhead and grabber, current-time readouts, in/out and timeline markers, record/live. The rule is a clean split — **cool = what you selected or can do; warm = time and now.** Warmth is a wayfinding signal, never decoration.

### Tertiary — Reserved Hue
- **AI Violet** (#8b5cf6): Reserved exclusively for AI presence and AI-authored suggestions. Never used for navigation, selection, or categories.

### Neutral
The dark ladder uses **decisive, perceptible value steps** — panels visibly lift off the frame — so hierarchy never reads as one flat gray sheet. Faintly cool, but truer black at the base.
- **Void** (#05060a): The canvas/workspace behind the document — the darkest ground.
- **Surface 0** (#0b0d12): The app frame, the timeline lane bed, and recessed input wells.
- **Surface 1** (#14171e): Panels and the panel header strip — a clear step up from the frame.
- **Surface 2** (#1e222c): Raised controls and buttons at rest.
- **Surface 3** (#292e3a): The hover step above a raised control.
- **Ink** (#f5f7fb): Primary text (~15:1 on panels).
- **Ink Secondary** (#c6cdd9, ~9:1) / **Ink Tertiary** (#94a0b2, ~5.2:1) / **Ink Muted** (#707b8d, ~3.3:1): Stepped-down text. Ink Tertiary is the AA floor for small labels; **Ink Muted is icons/decoration only — never body text.**

### Semantic (state only, never chrome)
- **Success** (#10b981), **Warning** (#f5b84b), **Danger** (#f43f5e): Status meaning only. **Modified Amber** (#f5b84b) is the sole chrome amber, marking unsaved/modified state.

### Layer Category Hues (signature)
Nine desaturated, colorblind-safe hues that tag layer types, each **always paired with an icon shape** so meaning never rests on color alone: Text #6aa9ff, Shape #3fbfae, Image #e8a33d, Video #e85d75, Audio #4bcb9e, Camera #e8935c, Light #e3c04c, Null #8e9aad, 3D #d47ae8. Video is shifted off pure red and Audio to mint specifically to avoid a red/green collision.

### Named Rules
**The One Voice Rule.** Signal Blue carries *both* selection and primary action. Never introduce a third blue to distinguish them; if two blue things are on screen, they mean the same family of thing.

**The Warm/Cool Rule.** Cool (Signal Blue) is what you selected or can act on. Warm (Ember) is time and now. Never cross them — a warm "selected" state or a cool playhead breaks the single clearest signal in the tool.

**The Reserved Hue Rule.** Ember belongs to the temporal family (playhead, current time, markers, record). Violet belongs to AI. These hues are forbidden anywhere else, no matter how convenient. Their meaning depends on their exclusivity.

**The Icon-Paired Rule.** A layer-category hue never appears without its icon shape. Color is the secondary signal; shape is primary.

## 3. Typography

**UI Font:** IBM Plex Sans (with Segoe UI, system-ui fallback) — headings, labels, and body.
**Numeric/Mono Font:** IBM Plex Mono (with SF Mono, Consolas fallback).

**Character:** One engineered family (IBM Plex Sans) does nearly all the UI work, chosen deliberately over the anonymous Inter/Roboto default — Plex has a slightly technical, drafted character that suits an instrument, while staying legible at 11–14px. Numerics break to IBM Plex Mono, reinforcing the tooling personality. Plex Sans runs a touch wider than Inter, so dense chrome (Inspector rows, timeline headers) uses ~-0.01em tracking and is tested for truncation. This is a product-UI type system, not an editorial one: a tight scale, negative tracking on display sizes, no flourish in the working chrome.

### Hierarchy
- **Display** (600, 36px, 1.2, −0.02em): Reserved for the largest moments — welcome/onboarding, not working chrome.
- **Headline** (600, 24px, 1.2, −0.02em): Section-level headings in dialogs and settings.
- **Title** (600, 20px, 1.2, −0.011em): Panel and group titles.
- **Body** (400, 14px, 1.45): Default reading size. Cap prose at 65–75ch; dense UI and data may run tighter.
- **Label** (500, 13px, 1.2): Buttons, control labels, list rows — the workhorse size of the app.
- **Caption/Tiny** (400, 12px/11px): Metadata, hints, and the smallest chrome. 11px is the absolute floor and mono-only.

### Named Rules
**The Tabular Rule.** Every number that changes — timecodes, coordinates, FPS, zoom %, frame counts — is set in IBM Plex Mono with `font-variant-numeric: tabular-nums`, so digits never shift width as they tick.

**The Uppercase-Label Rule.** Small field labels use uppercase with 0.06em tracking at 11–13px. This is the *only* sanctioned uppercase treatment; never uppercase body, buttons, or headings.

## 4. Elevation

This system is **flat by doctrine**. Every shadow token resolves to `none` — there are no drop shadows on panels, popovers, modals, or floating surfaces. Depth is communicated two ways only: by **surface value** (a nearer surface is a lighter step — Void → Surface 0 → 1 → 2 → 3) and by a **single hairline border** where two regions meet. Inside a panel, rows separate by hover and spacing, not by lines.

### Shadow Vocabulary
None. Intentionally. If you feel the urge to add a shadow to separate two things, step the surface value or add one hairline instead.

### Named Rules
**The Flat-By-Value Rule.** Elevation is a value step, never a shadow. A raised element is *lighter*, not *lifted*. A recessed element (an input well) is *darker*. Adding a `box-shadow` to convey depth is prohibited.

**The One-Hairline Rule.** Borders appear only where two regions meet, and never doubled. A row that already sits below a bordered row does not get its own top border.

## 5. Components

Controls read as **machined and recessed**: exact heights on a 4px grid, subtle top-down gradients on raised buttons, and input fields sunk into dark wells. They stay quiet at rest and respond precisely on interaction.

### Buttons
- **Shape:** Gently squared — 4px radius at default (md) size (`{rounded.sm}`); tighter (3px) at xs/sm, looser (5–6px) at lg/xl. Heights are exact: 20 / 24 / 30 / 36 / 44px.
- **Secondary (default):** A subtle top-down gradient from Surface 2 → Surface 1 with a 1px border; the resting look of most buttons. Hover lightens one value step and strengthens the border.
- **Primary:** A Signal Blue gradient (hover→base) with white text; hover brightens ~5% rather than changing hue.
- **Ghost:** Transparent with no border; hover fills with the 4%-white hover token. For toolbars and dense control clusters.
- **Danger / Success / Warning:** Semantic gradient fills, used only for genuinely destructive or state-affirming actions.
- **Focus:** Border shifts to Signal Blue. (Note: a global reset currently suppresses the soft focus *ring* on buttons — see Do's & Don'ts.)

### Inputs / Fields
- **Style:** Recessed well — Surface 0 (near-black) background, a 5%-white hairline, 3px radius, 28px default height. The field sits *below* the panel plane.
- **Focus:** Border shifts to Signal Blue on `:focus-within`; the well stays dark. No glow.
- **Error / Disabled:** Border shifts to Danger on invalid; disabled drops to 50% opacity with Ink Disabled text. Labels are uppercase, tracked, tertiary.

### Cards / Containers
- **Corner Style:** Panels 8px (`{rounded.panel}`), cards/small modals 12px, dialogs 16px.
- **Background:** Surface 1 for panels, on the Surface 0 frame.
- **Shadow Strategy:** None — separated by value and a single seam hairline (see Elevation).
- **Nesting:** Nested cards are prohibited. If content needs grouping inside a panel, use spacing and a hairline, not a second card.

### The Timeline (signature component)
The defining surface. Calm by default: one quiet summary row per layer showing a category-tinted animation bar, expanding on demand into per-property keyframe sub-rows. A near-black lane bed, one hairline per row, the coral playhead floating above with a diamond grabber, and colorblind-safe category hues on the track headers. Keyframes are small rotated diamonds; the ruler carries a mono, tabular timecode. It is the clearest expression of *earned, progressively-revealed density*.

## 6. Do's and Don'ts

### Do:
- **Do** carry depth with surface value and one hairline — a nearer thing is a lighter step, never a shadowed one.
- **Do** keep Signal Blue for selection, primary action, and focus only; if it's decorative, it's wrong.
- **Do** hold Ember to the temporal family (playhead, current time, markers, record) and violet to AI, always. Cool = action, warm = time.
- **Do** pair every layer-category hue with its icon shape; color is never the sole signal.
- **Do** set every ticking number in mono with tabular-nums so digits don't jitter.
- **Do** reveal complexity progressively — calm by default, detail on demand, like the timeline.
- **Do** use the exact size/spacing grid (control heights 20–44px, 4px spacing base); no off-grid 13px gaps.

### Don't:
- **Don't** drift toward a **playful consumer app (Canva-style)**: no bubbly shapes, sticker-bright multicolor, rounded-everything, or template energy.
- **Don't** become a **cluttered legacy pro tool**: no walls of tiny buttons, no nested toolbars, nothing that shows everything at once. Density must be earned and disclosed.
- **Don't** add a `box-shadow` to separate surfaces — step the value or add a hairline instead.
- **Don't** cross the warm/cool split (no warm selection, no cool playhead), or use Ember/violet for anything but their reserved jobs.
- **Don't** nest a card inside a card. Group with spacing and a hairline.
- **Don't** use `border-left`/`border-right` >1px as a colored accent stripe, gradient text (`background-clip: text`), or decorative glassmorphism — all prohibited.
- **Don't** ship the app-wide button focus-ring suppression as-is: `global.css` force-removes `button:focus-visible` rings with `!important`, so keyboard users get no visible focus on any button. Restore a soft Signal-Blue focus ring on interactive controls.
- **Don't** run body text on Ink Muted (#647285) or place gray text on a colored fill; keep body ≥ Ink Tertiary and use a shade of the fill's own hue.
