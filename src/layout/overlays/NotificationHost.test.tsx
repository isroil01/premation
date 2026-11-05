/**
 * Which notices are cards over the work: warnings and errors. A routine notice is
 * said by the status bar and a job's progress by its tray, unless nothing shows them.
 */
import { act, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip';
import { NotificationHost } from './NotificationHost';
import { latestQuietNotification, useUIStore } from '@stores/uiStore';
import { useModalStore } from '@stores/modalStore';

const notify = (level: 'info' | 'success' | 'warning' | 'error', message: string, progress?: number): void => {
  useUIStore.getState().notify({ level, message, durationMs: 0, ...(progress !== undefined ? { progress } : {}) });
};

describe('NotificationHost', () => {
  beforeEach(() => {
    useUIStore.setState({ notifications: [], noticeLineMounted: true });
    useModalStore.setState({ stack: [] });
  });
  afterAll(() => {
    useUIStore.setState({ notifications: [], noticeLineMounted: false });
  });

  it('draws warnings and errors, not routine notices or job progress, in the editor', () => {
    render(<TooltipProvider><NotificationHost /></TooltipProvider>);
    act(() => {
      notify('success', 'Deleted selected layers');
      notify('info', 'Rendering', 0.4);
      notify('warning', 'Careful');
      notify('error', 'It failed');
    });
    expect(screen.queryByText('Deleted selected layers')).toBeNull();
    expect(screen.queryByText('Rendering')).toBeNull();
    expect(screen.getByText('Careful')).toBeTruthy();
    expect(screen.getByText('It failed')).toBeTruthy();
  });

  it('gives the status bar the newest routine notice, never a job or a warning', () => {
    act(() => {
      notify('success', 'Older');
      notify('info', 'Newer');
      notify('info', 'Rendering', 0.4);
      notify('warning', 'Careful');
    });
    expect(latestQuietNotification(useUIStore.getState())?.message).toBe('Newer');
  });

  it('keeps routine notices as cards where no status bar can say them', () => {
    useUIStore.setState({ noticeLineMounted: false });
    render(<TooltipProvider><NotificationHost /></TooltipProvider>);
    act(() => notify('success', 'Saved'));
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});
