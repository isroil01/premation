import { useRef, useState } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { Icon } from '@components/Icon';
import styles from './FloatingPanelHost.module.css';

interface FloatingPanelHostProps {
  renderPanel: (panelId: string) => React.ReactNode;
}

export function FloatingPanelHost({ renderPanel }: FloatingPanelHostProps): JSX.Element {
  const { floatingPanels, panels, setFloatingBounds, bringFloatingToFront, dockPanel, closePanel } = useLayoutStore();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const resizeStartRef = useRef<{ width: number; height: number; startX: number; startY: number }>({
    width: 0,
    height: 0,
    startX: 0,
    startY: 0,
  });

  const handlePointerDownHeader = (panelId: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    bringFloatingToFront(panelId);
    setDraggingId(panelId);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const bounds = panels[panelId]?.floatingBounds ?? { x: 80, y: 80 };
    dragOffsetRef.current = {
      x: e.clientX - bounds.x,
      y: e.clientY - bounds.y,
    };
  };

  const handlePointerMoveHeader = (e: React.PointerEvent) => {
    if (!draggingId) return;

    let newX = e.clientX - dragOffsetRef.current.x;
    let newY = e.clientY - dragOffsetRef.current.y;

    // Edge snapping (16px threshold)
    const SNAP = 16;
    if (Math.abs(newX) < SNAP) newX = 0;
    if (Math.abs(newY) < SNAP) newY = 0;
    if (Math.abs(window.innerWidth - (newX + (panels[draggingId]?.floatingBounds?.width ?? 360))) < SNAP) {
      newX = window.innerWidth - (panels[draggingId]?.floatingBounds?.width ?? 360);
    }

    setFloatingBounds(draggingId, { x: newX, y: newY });
  };

  const handlePointerUpHeader = (e: React.PointerEvent) => {
    if (draggingId) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setDraggingId(null);
    }
  };

  const handlePointerDownResize = (panelId: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    bringFloatingToFront(panelId);
    setResizingId(panelId);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const bounds = panels[panelId]?.floatingBounds ?? { width: 360, height: 480 };
    resizeStartRef.current = {
      width: bounds.width,
      height: bounds.height,
      startX: e.clientX,
      startY: e.clientY,
    };
  };

  const handlePointerMoveResize = (e: React.PointerEvent) => {
    if (!resizingId) return;

    const deltaX = e.clientX - resizeStartRef.current.startX;
    const deltaY = e.clientY - resizeStartRef.current.startY;

    const newWidth = Math.max(240, resizeStartRef.current.width + deltaX);
    const newHeight = Math.max(200, resizeStartRef.current.height + deltaY);

    setFloatingBounds(resizingId, { width: newWidth, height: newHeight });
  };

  const handlePointerUpResize = (e: React.PointerEvent) => {
    if (resizingId) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setResizingId(null);
    }
  };

  return (
    <>
      {floatingPanels.map((panelId) => {
        const panel = panels[panelId];
        if (!panel) return null;

        const bounds = panel.floatingBounds ?? { x: 100, y: 100, width: 360, height: 480, zIndex: 100 };

        return (
          <div
            key={panelId}
            className={styles.floatingWindow}
            style={{
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              zIndex: bounds.zIndex,
            }}
            onClick={() => bringFloatingToFront(panelId)}
          >
            {/* Header Drag Bar */}
            <div
              className={styles.windowHeader}
              onPointerDown={handlePointerDownHeader(panelId)}
              onPointerMove={handlePointerMoveHeader}
              onPointerUp={handlePointerUpHeader}
            >
              <div className={styles.windowTitle}>
                {panel.icon && <Icon name={panel.icon as any} size={12} />}
                <span>{panel.title}</span>
              </div>
              <div className={styles.controls}>
                <button
                  type="button"
                  className={styles.controlBtn}
                  onClick={() => dockPanel(panelId)}
                  title="Redock Panel"
                >
                  <Icon name="panel-left" size={12} />
                </button>
                <button
                  type="button"
                  className={styles.controlBtn}
                  onClick={() => closePanel(panelId)}
                  title="Close Floating Window"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </div>

            {/* Panel Content */}
            <div className={styles.windowContent}>
              {renderPanel(panelId)}
            </div>

            {/* Bottom Right Resize Handle */}
            <div
              className={styles.resizeHandle}
              onPointerDown={handlePointerDownResize(panelId)}
              onPointerMove={handlePointerMoveResize}
              onPointerUp={handlePointerUpResize}
            />
          </div>
        );
      })}
    </>
  );
}
