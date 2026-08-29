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
