import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { SplitPane } from './SplitPane';

describe('SplitPane Component', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now());
      return 1;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('renders children with horizontal split layout', () => {
    render(
      <SplitPane direction="horizontal" defaultSize={250} minSize={100} maxSize={500}>
        <div data-testid="pane-1">Left Pane</div>
        <div data-testid="pane-2">Right Pane</div>
      </SplitPane>
    );

    expect(screen.getByTestId('pane-1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-2')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '250');
  });

  it('handles horizontal pointer drag to increase size', () => {
    const onResize = jest.fn();
    const onResizeEnd = jest.fn();

    render(
      <SplitPane
        direction="horizontal"
        defaultSize={250}
        minSize={100}
        maxSize={500}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      >
        <div>Left Pane</div>
        <div>Right Pane</div>
      </SplitPane>
    );

    const separator = screen.getByRole('separator');

    // Pointer down on splitter
    fireEvent.pointerDown(separator, {
      clientX: 250,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });

    expect(document.body.style.cursor).toBe('col-resize');

    // Drag pointer right by 50px
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 300,
        clientY: 100,
      })
    );

    expect(onResize).toHaveBeenCalledWith(300);

    // Pointer up
    fireEvent(
      window,
      new PointerEvent('pointerup', {
        clientX: 300,
        clientY: 100,
      })
    );

    expect(onResizeEnd).toHaveBeenCalledWith(300);
    expect(document.body.style.cursor).toBe('');
  });

  it('handles primary="last" with inverted delta for right/bottom docks', () => {
    const onResize = jest.fn();
    const onResizeEnd = jest.fn();

    render(
      <SplitPane
        direction="horizontal"
        primary="last"
        defaultSize={280}
        minSize={100}
        maxSize={500}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      >
        <div>Main Canvas</div>
        <div>Right Inspector</div>
      </SplitPane>
    );

    const separator = screen.getByRole('separator');

    // Pointer down on splitter
    fireEvent.pointerDown(separator, {
      clientX: 800,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });

    // Dragging left (decreasing clientX) should EXPAND the right inspector
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 750,
        clientY: 100,
      })
    );

    // delta = 750 - 800 = -50. With primary="last", sign = -1, so next = 280 + (-1 * -50) = 330
    expect(onResize).toHaveBeenCalledWith(330);

    fireEvent(
      window,
      new PointerEvent('pointerup', {
        clientX: 750,
        clientY: 100,
      })
    );

    expect(onResizeEnd).toHaveBeenCalledWith(330);
  });

  it('handles vertical pointer drag for timeline bottom pane', () => {
    const onResize = jest.fn();

    render(
      <SplitPane
        direction="vertical"
        primary="last"
        defaultSize={200}
        minSize={100}
        maxSize={600}
        onResize={onResize}
      >
        <div>Top Viewport</div>
        <div>Bottom Timeline</div>
      </SplitPane>
    );

    const separator = screen.getByRole('separator');

    fireEvent.pointerDown(separator, {
      clientX: 500,
      clientY: 600,
      button: 0,
      pointerId: 1,
    });

    expect(document.body.style.cursor).toBe('row-resize');

    // Drag up by 60px -> timeline grows
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 500,
        clientY: 540,
      })
    );

    // delta = 540 - 600 = -60. sign = -1. next = 200 + 60 = 260
    expect(onResize).toHaveBeenCalledWith(260);

    fireEvent(
      window,
      new PointerEvent('pointerup', {
        clientX: 500,
        clientY: 540,
      })
    );
  });

  it('supports continuous dragging across parent re-renders without aborting', () => {
    function ControlledParent() {
      const [size, setSize] = useState(250);
      return (
        <SplitPane
          direction="horizontal"
          size={size}
          defaultSize={250}
          minSize={100}
          maxSize={500}
          onResize={(s) => setSize(s)}
        >
          <div>Left</div>
          <div>Right</div>
        </SplitPane>
      );
    }

    render(<ControlledParent />);
    const separator = screen.getByRole('separator');

    fireEvent.pointerDown(separator, {
      clientX: 250,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });

    // Move 1
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 270,
        clientY: 100,
      })
    );
    expect(separator).toHaveAttribute('aria-valuenow', '270');

    // Move 2 (continuation of same drag)
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 320,
        clientY: 100,
      })
    );
    expect(separator).toHaveAttribute('aria-valuenow', '320');

    // Move 3 (continuation of same drag)
    fireEvent(
      window,
      new PointerEvent('pointermove', {
        clientX: 400,
        clientY: 100,
      })
    );
    expect(separator).toHaveAttribute('aria-valuenow', '400');

    fireEvent(
      window,
      new PointerEvent('pointerup', {
        clientX: 400,
        clientY: 100,
      })
    );

    expect(separator).toHaveAttribute('aria-valuenow', '400');
  });

  /**
   * The regression this file exists for.
   *
   * A pointer reports far faster than the screen refreshes, and `onResize` is
   * wired to the layout store — so an unthrottled handler re-rendered the whole
   * editor a dozen times to paint one frame. The rAF coalescer that was meant
   * to stop that never armed (it stored the handle behind a condition that is
   * false by construction), and dragging got slower the longer you dragged.
   */
  describe('drag coalescing', () => {
    let frames: FrameRequestCallback[];

    beforeEach(() => {
      // Override the suite-wide SYNCHRONOUS mock: a coalescer cannot be
      // observed at all if the callback runs before requestAnimationFrame
      // returns, which is the one thing a real browser never does.
      frames = [];
      jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
    });

    const flushFrame = (): void => {
      const due = frames;
      frames = [];
      for (const cb of due) cb(performance.now());
    };

    it('collapses many pointermoves in one frame into a single onResize', () => {
      const onResize = jest.fn();

      render(
        <SplitPane
          direction="horizontal"
          defaultSize={250}
          minSize={100}
          maxSize={500}
          onResize={onResize}
        >
          <div>Left</div>
          <div>Right</div>
        </SplitPane>
      );

      const separator = screen.getByRole('separator');
      fireEvent.pointerDown(separator, { clientX: 250, clientY: 0, button: 0, pointerId: 1 });

      // Twelve moves before the browser gets a chance to paint.
      for (let x = 251; x <= 262; x++) {
        fireEvent(window, new PointerEvent('pointermove', { clientX: x, clientY: 0 }));
      }

      expect(onResize).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);

      flushFrame();

      // One update, carrying the LATEST position — not twelve.
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith(262);

      // The latch reopens for the next frame.
      fireEvent(window, new PointerEvent('pointermove', { clientX: 270, clientY: 0 }));
      flushFrame();
      expect(onResize).toHaveBeenCalledTimes(2);
      expect(onResize).toHaveBeenLastCalledWith(270);
    });

    it('paints the pane live while the consumer commits only at drag end', () => {
      // The arrangement EditorLayout uses: the store hears about the size once,
      // on release. The pane still has to follow the pointer the whole way.
      const parentRenders = jest.fn();
      function Consumer(): JSX.Element {
        const [size, setSize] = useState(250);
        parentRenders();
        return (
          <SplitPane
            direction="horizontal"
            size={size}
            defaultSize={250}
            minSize={100}
            maxSize={500}
            onResizeEnd={(s) => setSize(s)}
          >
            <div>Left</div>
            <div>Right</div>
          </SplitPane>
        );
      }

      render(<Consumer />);
      const separator = screen.getByRole('separator');
      const pane = separator.previousElementSibling as HTMLElement;
      parentRenders.mockClear();

      fireEvent.pointerDown(separator, { clientX: 250, clientY: 0, button: 0, pointerId: 1 });
      for (const x of [300, 340, 380]) {
        fireEvent(window, new PointerEvent('pointermove', { clientX: x, clientY: 0 }));
        flushFrame();
      }

      // Three frames of drag, zero renders — and the user saw every one of them.
      expect(parentRenders).not.toHaveBeenCalled();
      expect(pane.style.width).toBe('380px');
      expect(separator).toHaveAttribute('aria-valuenow', '380');

      fireEvent(window, new PointerEvent('pointerup', { clientX: 380, clientY: 0 }));

      // One render commits the gesture, and it agrees with what was painted.
      expect(parentRenders).toHaveBeenCalledTimes(1);
      expect(pane.style.width).toBe('380px');
      expect(separator).toHaveAttribute('aria-valuenow', '380');
    });

    it('detaches its window listeners when unmounted mid-drag', () => {
      const onResize = jest.fn();
      const { unmount } = render(
        <SplitPane
          direction="horizontal"
          defaultSize={250}
          minSize={100}
          maxSize={500}
          onResize={onResize}
        >
          <div>Left</div>
          <div>Right</div>
        </SplitPane>
      );

      fireEvent.pointerDown(screen.getByRole('separator'), {
        clientX: 250, clientY: 0, button: 0, pointerId: 1,
      });

      const removed = jest.spyOn(window, 'removeEventListener');
      unmount();

      const kinds = removed.mock.calls.map((c) => c[0]);
      expect(kinds).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));

      // And the detached handler is inert: no frame is scheduled, no callback fires.
      fireEvent(window, new PointerEvent('pointermove', { clientX: 400, clientY: 0 }));
      expect(frames).toHaveLength(0);
      expect(onResize).not.toHaveBeenCalled();
    });
  });

  it('supports keyboard arrow keys for accessibility', () => {
    function ControlledParent() {
      const [size, setSize] = useState(250);
      return (
        <SplitPane
          direction="horizontal"
          size={size}
          defaultSize={250}
          minSize={100}
          maxSize={500}
          onResize={(s) => setSize(s)}
        >
          <div>Left</div>
          <div>Right</div>
        </SplitPane>
      );
    }

    render(<ControlledParent />);
    const separator = screen.getByRole('separator');
    separator.focus();

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '258');

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '250');

    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '100');

    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '500');
  });
});
