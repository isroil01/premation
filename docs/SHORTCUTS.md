# Keyboard Shortcuts & Mouse Gestures

Generated from the command registry and input handlers (Providers.tsx,
ShortcutManager, useTimelineKeys, useSpaceTransport, App.tsx reveal handler,
useWorkspace pointer/wheel handlers). Chords are remappable via
Window → Customize…

## Tools (After Effects keys)

| Key | Tool |
|---|---|
| V | Selection |
| A | Direct Selection (vertices/tangents) |
| W | Rotation |
| Y | Pan Behind (anchor point) |
| H | Hand |
| Z | Zoom |
| G | Pen |
| Q | Rectangle |
| Shift+Q | Ellipse |
| Ctrl+T | Text |
| — | Pencil / Brush / Curvature / Polygon / Star / Line (toolbar dropdowns) |

## Canvas gestures

| Gesture | Action |
|---|---|
| Space (hold) + drag | Temporary hand — pan the view |
| Space (tap) | Play / pause |
| Middle-mouse drag | Pan the view (any tool) |
| Ctrl + wheel | Zoom at cursor (shows zoom % readout) |
| Alt + wheel (camera selected) | Dolly the 3D camera along Z |
| Shift + corner drag | Scale constrained to aspect ratio |
| Alt + corner drag | Scale from center |
| Alt + tangent drag | Break the handle pair (motion path / pen) |
| Shift + click (Direct Select) | Append a point to the active outline |
| Alt + click point (Direct Select) | Delete the point |
| Right-click | Context menu (layer / canvas / keyframe / clip) |

## Animation & keyframes

| Chord | Action |
|---|---|
| P / S / R / T / A / M / L | Reveal Position / Scale / Rotation / Opacity / Anchor / Mask / Audio rows |
| U | Reveal animated properties (selection) |
| U U | Reveal animated properties (all layers) |
| Alt+Shift+P / S / R / T / A | Add a keyframe for that property at the playhead |
| F9 | Easy Ease |
| Shift+F9 | Easy Ease In |
| Ctrl+Shift+F9 | Easy Ease Out |
| J / K | Previous / next keyframe |
| Ctrl+C / Ctrl+V | Copy / paste selected keyframes (paste at playhead) |
| Ctrl+A | Select all keyframes (timeline focus) / all layers (canvas) |
| Delete / Backspace | Delete selected keyframes / layers |
| Ctrl+Alt+S | Smooth motion path (selected layers) |
| Ctrl+Alt+M | Toggle motion-path overlay |
| Shift+F3 | Toggle Graph Editor (AE-preset binding) |

## Transport & timeline

| Chord | Action |
|---|---|
| Home / End | Go to start / end |
| Page Up / Page Down | Previous / next frame |
| Shift+Page Up / Down | Previous / next marker |
| B / N | Set work-area in / out at playhead |
| [ / ] | Move layer in / out point |
| Alt+[ / Alt+] | Trim layer in / out to playhead |
| Ctrl+Shift+D | Split selected layers at playhead |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |

## Application

| Chord | Action |
|---|---|
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+K | Switch theme |
| F6 | Render Queue |
| ` (backtick) | Focus workspace |
| Escape | Deselect |

## Where settings live

- Tool options (brush size/taper/pressure, pencil stroke, polygon sides,
  star points/inner) — the strip under the toolbar when the tool is active.
- Motion-path dot size — View Options (top bar) → Motion Path Dots.
- Auto-Keyframe mode — View Options → Auto-Keyframe Mode (note: properties
  with a lit stopwatch always keyframe on canvas drags regardless).
