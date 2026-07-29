/**
 * SyncChannel — Cross-Window State Synchronization Engine.
 * Enables 60 FPS state synchronization between Main Window and Pop-Out Detached Windows
 * using BroadcastChannel (Web) and Electron IPC (Desktop).
 */

export interface SyncMessage<T = unknown> {
  type: string;
  senderId: string;
  timestamp: number;
  payload: T;
}

type SyncHandler<T = unknown> = (payload: T, message: SyncMessage<T>) => void;

class StateSyncChannel {
  private channel: BroadcastChannel | null = null;
  private windowId: string;
  private handlers: Map<string, Set<SyncHandler>> = new Map();

  constructor() {
    this.windowId = typeof window !== 'undefined' && window.name ? window.name : `win-${Math.random().toString(36).slice(2, 9)}`;
    this.initChannel();
  }

  private initChannel(): void {
    if (typeof window === 'undefined') return;

    // Web BroadcastChannel initialization
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel('motion-editor-sync');
      this.channel.onmessage = (e: MessageEvent<SyncMessage>) => {
        this.dispatchMessage(e.data);
      };
    }

    // Electron IPC listener if available
    if (window.motionEditor?.popout?.onStateSync) {
      window.motionEditor.popout.onStateSync((data: unknown) => {
        if (data && typeof data === 'object') {
          this.dispatchMessage(data as SyncMessage);
        }
      });
    }
  }

  private dispatchMessage(msg: SyncMessage): void {
    if (msg.senderId === this.windowId) return; // ignore self-messages
    const set = this.handlers.get(msg.type);
    if (set) {
      for (const handler of set) {
        handler(msg.payload, msg);
      }
    }
  }

  public publish<T>(type: string, payload: T): void {
    const msg: SyncMessage<T> = {
      type,
      senderId: this.windowId,
      timestamp: Date.now(),
      payload,
    };

    if (this.channel) {
      this.channel.postMessage(msg);
    }

    if (window.motionEditor?.popout?.sendStateUpdate) {
      window.motionEditor.popout.sendStateUpdate(msg);
    }
  }

  public subscribe<T>(type: string, handler: SyncHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const set = this.handlers.get(type)!;
    set.add(handler as SyncHandler);

    return () => {
      set.delete(handler as SyncHandler);
    };
  }

  public getWindowId(): string {
    return this.windowId;
  }
}

export const syncChannel = new StateSyncChannel();
