import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import styles from './TransformSection.module.css';

export function MediaSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const tComp = useMemo(() => node.components.find((c) => c.type === 'Transform'), [node]);
  const isVideo = node.components.some((c) => c.type === 'video' || c.id.startsWith('video') || (tComp && tComp.props.__kind === 'video'));

  // Media Source and Fit Props on Transform component
  const [src, setSrc] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'src');
  const [fitMode, setFitMode] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fitMode');

  // Crop offsets
  const [cropTop, setCropTop] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropTop');
  const [cropRight, setCropRight] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropRight');
  const [cropBottom, setCropBottom] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropBottom');
  const [cropLeft, setCropLeft] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropLeft');

  // Video specific playback properties
  const [speed, setSpeed] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'speed');
  const [startOffset, setStartOffset] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'startOffset');
  const [loop, setLoop] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'loop');
  const [muted, setMuted] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'muted');

  if (!tComp) return null;

  const handleReplace = async () => {
    // Check if Electron is available, else request standard import/replace or mock
    if (window.electronAPI?.project?.open) {
      try {
        const file = await window.electronAPI.project.open();
        if (file) {
          setSrc(file.path);
        }
      } catch (err) {
        console.error('Failed to open Electron file dialog:', err);
      }
    } else {
      // Browser fallback: trigger a prompt/alert
      const path = prompt('Enter image/video URL or file path:', String(src ?? ''));
      if (path !== null) {
        setSrc(path);
      }
    }
  };

  const getFileName = (pathStr: string) => {
    if (!pathStr) return 'No file selected';
    return pathStr.split(/[\\/]/).pop() ?? pathStr;
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>{isVideo ? 'Video Source' : 'Image Source'}</h4>
      
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <span
          style={{
            flex: 1,
            fontSize: 10,
            color: '#aaa',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            background: '#151518',
            padding: '4px 6px',
            borderRadius: 2,
            border: '1px solid rgba(255,255,255,0.05)'
          }}
          title={String(src ?? '')}
        >
          {getFileName(String(src ?? ''))}
        </span>
        <button
          type="button"
          onClick={handleReplace}
          style={{
            background: '#28282c',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            fontSize: 10,
            padding: '4px 8px',
            borderRadius: 2,
            cursor: 'pointer'
          }}
        >
          Replace
        </button>
      </div>

      <InspectorRow label="Fit Mode" align="center">
        <select
          value={String(fitMode ?? 'fill')}
          onChange={(e) => setFitMode(e.target.value)}
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        >
          <option value="fill">Fill</option>
          <option value="fit">Fit</option>
          <option value="stretch">Stretch</option>
          <option value="none">None</option>
        </select>
      </InspectorRow>

      <h4 className={styles.title} style={{ marginTop: 12 }}>Crop</h4>
      <InspectorRow label="Crop Top" align="center">
        <ValueField value={Number(cropTop ?? 0)} unit="px" onChange={(v) => setCropTop(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Right" align="center">
        <ValueField value={Number(cropRight ?? 0)} unit="px" onChange={(v) => setCropRight(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Bottom" align="center">
        <ValueField value={Number(cropBottom ?? 0)} unit="px" onChange={(v) => setCropBottom(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Left" align="center">
        <ValueField value={Number(cropLeft ?? 0)} unit="px" onChange={(v) => setCropLeft(v)} />
      </InspectorRow>

      {isVideo && (
        <>
          <h4 className={styles.title} style={{ marginTop: 12 }}>Playback</h4>
          <InspectorRow label="Speed" align="center">
            <ValueField value={Number(speed ?? 1)} unit="x" onChange={(v) => setSpeed(v)} />
          </InspectorRow>
          <InspectorRow label="Start Offset" align="center">
            <ValueField value={Number(startOffset ?? 0)} unit="s" onChange={(v) => setStartOffset(v)} />
          </InspectorRow>
          <InspectorRow label="Loop" align="center">
            <input
              type="checkbox"
              checked={!!loop}
              onChange={(e) => setLoop(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
          </InspectorRow>
          <InspectorRow label="Muted" align="center">
            <input
              type="checkbox"
              checked={!!muted}
              onChange={(e) => setMuted(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
          </InspectorRow>
        </>
      )}
    </div>
  );
}

export default MediaSection;
