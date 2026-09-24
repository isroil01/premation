/**
 * PrecompControl — the "Precompose" switch + Speed, shown for group layers.
 * Precompose: the group's subtree renders to a texture and composites as one
 * unit (group opacity / blend / effects apply to the nested animation). Speed:
 * retime the nested content — Speed % or Frame Number (`RetimeSection`) —
 * independently of the comp time.
 */

import { Switch } from '@components/Switch';

import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { fieldValue } from '@core/mirror/layerFields';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorSupportsContinuousRaster } from '@core/mirror/continuousRaster';
import { edit } from '@core/engine/uiEdits';
import { boolFieldCommands } from './layerFieldEdits';
import { setLayersSwitch } from './inspectorEdits';
import { CompOverridesSection } from './CompOverridesSection';
import { RetimeSection } from './RetimeSection';
import styles from './ParentControl.module.css';

export function PrecompControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  const layer = useMirrorLayer(nodeId);
  // The CR test and the Precompose switch read fields of the property tree:
  // keep it loaded and re-render when it changes.
  const tree = useMirrorTree(nodeId);
  if (!layer || nodeId === 'comp_root') return null;
  const kind = uiKindOf(layer);
  const m = documentMirror();

  // A placed COMPOSITION (kind 'comp') has no Precompose switch — it is already
  // a composition — but it owns the one switch that decides whether it is a flat
  // card or part of the host's 3D scene. It used to show neither, nor Time
  // Remap, because this component returned null for every kind but 'group'.
  if (kind === 'comp') {
    const collapsed = layer.switches.collapse;
    return (
      <>
        <div className={styles.row}>
          <span className={styles.label}>Collapse Transformations</span>
          <Switch
            checked={collapsed}
            onChange={(e) => { void setLayersSwitch([nodeId], { collapse: e.currentTarget.checked }, 'Collapse Transformations'); }}
            aria-label="Collapse Transformations (join the host composition's 3D space)"
          />
        </div>
        <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {collapsed
            ? 'This composition’s layers render in the host: they meet its camera, depth sort and lights, and are not cropped to their own frame.'
            : 'This composition renders to its own frame first, then composites as one flat layer — so its 3D layers cannot meet the host’s camera.'}
        </p>
        <RetimeSection nodeId={nodeId} />
        <CompOverridesSection nodeId={nodeId} />
      </>
    );
  }

  /*
    Continuous Rasterization shares AE's sunburst column with Collapse
    Transformations: on a placed composition that switch means Collapse (above),
    on a vector layer it means CR. Same control position, one meaning per layer
    type — so this sits in the same component rather than a separate panel, and
    the two cases cannot both appear for one layer.

    Offered only where it can do something: text, SVG and shapes with real
    geometry. A bitmap cannot be re-rasterized sharper than it was shot, and a
    flat solid has no edge to sharpen, so a switch there would cost memory and
    change nothing.
  */
  if (tree && mirrorSupportsContinuousRaster(m, nodeId)) {
    const cr = layer.switches.collapse;
    return (
      <>
        <div className={styles.row}>
          <span className={styles.label}>Continuous Rasterization</span>
          <Switch
            checked={cr}
            onChange={(e) => { void setLayersSwitch([nodeId], { collapse: e.currentTarget.checked }, 'Continuous Rasterization'); }}
            aria-label="Continuous Rasterization (re-render vector content at the scale it is drawn)"
          />
        </div>
        <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {cr
            ? 'Re-rendered at the size it is actually drawn, from the smallest scale up. Costs memory in proportion to scale²; very large layers are bounded by the VRAM budget.'
            : 'Vector layers already re-render automatically once they pass 400%, so a title or logo a camera pushes into stays sharp on its own. Turn this on only to force re-rendering below 400% as well.'}
        </p>
      </>
    );
  }

  if (kind !== 'group') return null;

  const on = fieldValue(m, nodeId, 'layer/precompose') === true;

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Precompose</span>
        <Switch
          checked={on}
          // `layer/precompose` (bool field, fx.precomp): composite the group as one unit — not the `precompose` command, which makes a new composition.
          onChange={(e) => { void edit('Precompose', boolFieldCommands(nodeId, 'layer/precompose', e.currentTarget.checked)); }}
          aria-label="Precompose (composite group as one unit)"
        />
      </div>
      {on && <RetimeSection nodeId={nodeId} />}
    </>
  );
}

export default PrecompControl;
