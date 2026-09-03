/**
 * Compatibility shim for the old `DemoPanels` module path.
 *
 * This file used to be 2,800 lines holding the Scene tree, the asset bin, the
 * whole inspector, the rigging panel and seven insertable libraries — five
 * unrelated jobs under a name ("demo") that stopped being true years ago. Each
 * now lives with the feature it belongs to:
 *
 *   ScenePanel        → layout/Scene/ScenePanel.tsx
 *   AssetsPanel       → layout/Assets/AssetsPanel.tsx
 *   PropertiesPanel   → layout/EditorLayout/PropertiesPanel.tsx
 *   InspectorContent  → layout/Inspector/InspectorContent.tsx
 *                       (+ the ordered registry, inspectorSections.ts)
 *   RigPanel          → layout/EditorLayout/RigPanel.tsx
 *   Library family    → layout/EditorLayout/LibraryPanel.tsx
 *   renderer map      → layout/EditorLayout/panelRenderers.ts
 *
 * The re-exports exist so nothing else had to move in the same change. Import
 * from the modules above in new code; this path is here to be deleted once the
 * last caller is updated.
 */

export { getAllPanelRenderers, PANEL_COMPONENTS } from './panelRenderers';
export { ScenePanel } from '@layout/Scene/ScenePanel';
export { AssetsPanel } from '@layout/Assets/AssetsPanel';
export { PropertiesPanel } from './PropertiesPanel';
export { RigPanel } from './RigPanel';
export { LibraryPanel, ComponentsPanel, ShapesPanel, TextPanel } from './LibraryPanel';
