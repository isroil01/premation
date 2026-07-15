/**
 * AiPromptBar — the assistant entry point, pinned to the bottom-center of the
 * viewport. A slim prompt that expands into a chat panel on focus.
 *
 * Wired to the motion-back AI endpoint: it sends the live document + selection,
 * receives validated keyframe ops, and replays them through `applyAiOps` as one
 * reversible command. Works offline too — without a backend key the server
 * returns a deterministic preset, and without a session it still animates using
 * the local scene sent in the request body.
 */

import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '@components/Icon';
import { api } from '@core/api/client';
import { API_URL } from '@core/api/env';
import { captureDocument } from '@core/api/cloudDocument';
import { applyAiOps } from '@core/ai/applyOps';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import styles from './AiPromptBar.module.css';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** localStorage key that maps a cloud project to its AI conversation thread. */
function convKey(projectId: string): string {
  return `motion_editor_ai_conv:${projectId}`;
}

function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

export function AiPromptBar(): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [position, setPosition] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem('motion_editor_ai_chat_pos');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [size, setSize] = useState<{ width: number; height: number }>(() => {
    try {
      const saved = localStorage.getItem('motion_editor_ai_chat_size');
      return saved ? JSON.parse(saved) : { width: 480, height: 320 };
    } catch {
      return { width: 480, height: 320 };
    }
  });

  const [minimized, setMinimized] = useState<boolean>(() => {
    try {
      return localStorage.getItem('motion_editor_ai_chat_minimized') === 'true';
    } catch {
      return false;
    }
  });

  const [isDragging, setIsDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  // The persisted AI thread for the current cloud project (rehydrated on load,
  // appended to on every edit). Null when editing without a cloud project.
  const conversationIdRef = useRef<string | null>(null);

  const toggleMinimized = useCallback((val: boolean) => {
    setMinimized(val);
    try {
      localStorage.setItem('motion_editor_ai_chat_minimized', String(val));
    } catch {}
  }, []);

  const prevStatesRef = useRef({ minimized, expanded, panelHeight: size.height });

  // Handle transition height shifts to keep bottom edge pinned
  useEffect(() => {
    const prev = prevStatesRef.current;
    if (prev.minimized !== minimized || prev.expanded !== expanded || prev.panelHeight !== size.height) {
      prevStatesRef.current = { minimized, expanded, panelHeight: size.height };

      if (!position) return;
      
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const getExpectedHeight = (isMin: boolean, isExp: boolean, panelH: number) => {
        if (isMin) return 44;
        if (!isExp) return 38;
        return panelH + 8 + 38;
      };

      const heightA = getExpectedHeight(prev.minimized, prev.expanded, prev.panelHeight);
      const heightB = getExpectedHeight(minimized, expanded, size.height);
      const diff = heightB - heightA;

      if (diff !== 0) {
        const newY = position.y - diff;
        const margin = 8;
        const minY = margin;
        const maxConstrainedY = Math.max(margin, parentOfParentRect.height - heightB - margin);
        const constrainedY = Math.max(minY, Math.min(maxConstrainedY, newY));

        const newPos = { x: position.x, y: constrainedY };
        setPosition(newPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(newPos));
      }
    }
  }, [minimized, expanded, size.height, position]);

  // Constrain coordinates on window resize
  useEffect(() => {
    const handleWindowResize = () => {
      if (!position || !wrapRef.current) return;
      const parentEl = wrapRef.current.parentElement;
      if (!parentEl) return;
      
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();
      const rect = parentEl.getBoundingClientRect();

      const margin = 8;
      const minX = margin;
      const maxX = Math.max(margin, parentOfParentRect.width - rect.width - margin);
      const minY = margin;
      const maxY = Math.max(margin, parentOfParentRect.height - rect.height - margin);

      const constrainedX = Math.max(minX, Math.min(maxX, position.x));
      const constrainedY = Math.max(minY, Math.min(maxY, position.y));

      if (constrainedX !== position.x || constrainedY !== position.y) {
        setPosition({ x: constrainedX, y: constrainedY });
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [position]);

  // Initial bounds check on mount
  useEffect(() => {
    if (!position) return;
    const timer = setTimeout(() => {
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();
      const rect = parentEl.getBoundingClientRect();

      const margin = 8;
      const minX = margin;
      const maxX = Math.max(margin, parentOfParentRect.width - rect.width - margin);
      const minY = margin;
      const maxY = Math.max(margin, parentOfParentRect.height - rect.height - margin);

      const constrainedX = Math.max(minX, Math.min(maxX, position.x));
      const constrainedY = Math.max(minY, Math.min(maxY, position.y));

      if (constrainedX !== position.x || constrainedY !== position.y) {
        const constrainedPos = { x: constrainedX, y: constrainedY };
        setPosition(constrainedPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(constrainedPos));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // Apply position to parent element directly (.overlayBC)
  useEffect(() => {
    const parentEl = wrapRef.current?.parentElement;
    if (!parentEl) return;
    if (position) {
      parentEl.style.position = 'absolute';
      parentEl.style.left = `${position.x}px`;
      parentEl.style.top = `${position.y}px`;
      parentEl.style.bottom = 'auto';
      parentEl.style.transform = 'none';
    } else {
      parentEl.style.position = '';
      parentEl.style.left = '';
      parentEl.style.top = '';
      parentEl.style.bottom = '';
      parentEl.style.transform = '';
    }
  }, [position]);

  useEffect(() => {
    let active = true;
    const checkStatus = async () => {
      try {
        const res = await fetch(`${API_URL}/auth/me`, { method: 'GET' });
        if (active) {
          setIsOnline(res.ok || res.status === 401 || res.status === 403 || res.status === 200);
        }
      } catch {
        if (active) {
          setIsOnline(false);
        }
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 8000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const projectId = useCloudProjectStore((s) => s.projectId);
  useEffect(() => {
    let active = true;
    if (!projectId) {
      conversationIdRef.current = null;
      setMessages([]);
      return;
    }
    const stored = (() => {
      try {
        return localStorage.getItem(convKey(projectId));
      } catch {
        return null;
      }
    })();
    conversationIdRef.current = stored;
    if (!stored) {
      setMessages([]);
      return;
    }
    (async () => {
      try {
        const conv = await api.getConversation(stored);
        if (!active) return;
        setMessages(conv.messages.map((m) => ({ role: m.role, text: m.content })));
      } catch {
        if (active) {
          conversationIdRef.current = null;
          try {
            localStorage.removeItem(convKey(projectId));
          } catch {
            /* ignore */
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const submit = useCallback(async () => {
    const prompt = value.trim();
    if (!prompt || busy) return;

    setBusy(true);
    setExpanded(true);
    setValue('');
    setMessages((m) => [...m, { role: 'user', text: prompt }]);

    if (isOnline === false) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: '⚠ NestJS backend is offline. Start the backend by running `npm run dev` in `motion-back` to use assistant features.',
        },
      ]);
      setBusy(false);
      return;
    }

    try {
      const selection = useSelectionStore.getState().ids as string[];
      const ws = useWorkspaceStore.getState();
      const atTime = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
      const document = captureDocument();

      const boundProject = useCloudProjectStore.getState().projectId;
      const conversationId = boundProject
        ? conversationIdRef.current ?? newConversationId()
        : undefined;

      const result = await api.aiEdit({
        prompt,
        document,
        selection,
        atTime,
        conversationId,
      });
      applyAiOps(result.label, result.ops);

      if (boundProject && result.conversationId) {
        conversationIdRef.current = result.conversationId;
        try {
          localStorage.setItem(convKey(boundProject), result.conversationId);
        } catch {
          /* ignore */
        }
      }

      const suffix =
        result.ops.length === 0
          ? ''
          : ` (${result.ops.length} keyframe${result.ops.length === 1 ? '' : 's'})`;
      setMessages((m) => [...m, { role: 'assistant', text: result.message + suffix }]);
    } catch (err) {
      const message = (err as Error).message || 'The assistant could not complete that.';
      setMessages((m) => [...m, { role: 'assistant', text: `⚠ ${message}` }]);
    } finally {
      setBusy(false);
    }
  }, [value, busy, isOnline]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const onResetPosition = useCallback(() => {
    setPosition(null);
    localStorage.removeItem('motion_editor_ai_chat_pos');
  }, []);

  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement | HTMLButtonElement>) => {
      if ((e.target as HTMLElement).closest('button:not(.' + styles.bubble + '), input, textarea')) return;

      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const initialX = rect.left - parentOfParentRect.left;
      const initialY = rect.top - parentOfParentRect.top;

      const startPointerX = e.clientX;
      const startPointerY = e.clientY;

      setIsDragging(true);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaX = moveEvent.clientX - startPointerX;
        const deltaY = moveEvent.clientY - startPointerY;

        let newX = initialX + deltaX;
        let newY = initialY + deltaY;

        const margin = 8;
        const minX = margin;
        const maxX = Math.max(margin, parentOfParentRect.width - rect.width - margin);
        const minY = margin;
        const maxY = Math.max(margin, parentOfParentRect.height - rect.height - margin);

        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(minY, Math.min(maxY, newY));

        setPosition({ x: newX, y: newY });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);
        setIsDragging(false);

        const deltaX = upEvent.clientX - startPointerX;
        const deltaY = upEvent.clientY - startPointerY;
        let finalX = initialX + deltaX;
        let finalY = initialY + deltaY;

        const margin = 8;
        const minX = margin;
        const maxX = Math.max(margin, parentOfParentRect.width - rect.width - margin);
        const minY = margin;
        const maxY = Math.max(margin, parentOfParentRect.height - rect.height - margin);

        finalX = Math.max(minX, Math.min(maxX, finalX));
        finalY = Math.max(minY, Math.min(maxY, finalY));

        const savedPos = { x: finalX, y: finalY };
        setPosition(savedPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(savedPos));

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [],
  );

  const onResizeRightStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const startPointerX = e.clientX;
      const startWidth = rect.width;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaX = moveEvent.clientX - startPointerX;
        const newWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth + deltaX));

        setSize((prev) => ({ ...prev, width: newWidth }));
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);

        const deltaX = upEvent.clientX - startPointerX;
        const finalWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth + deltaX));

        setSize((prev) => {
          const updated = { ...prev, width: finalWidth };
          localStorage.setItem('motion_editor_ai_chat_size', JSON.stringify(updated));
          return updated;
        });

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [],
  );

  const onResizeLeftStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const startPointerX = e.clientX;
      const startWidth = rect.width;
      const currentX = position ? position.x : (rect.left - parentOfParentRect.left);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaX = moveEvent.clientX - startPointerX;
        const newWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth - deltaX));
        const actualDiff = newWidth - startWidth;

        let newX = currentX - actualDiff;
        const margin = 8;
        const minX = margin;
        const maxX = Math.max(margin, parentOfParentRect.width - newWidth - margin);
        newX = Math.max(minX, Math.min(maxX, newX));

        setSize((prev) => ({ ...prev, width: newWidth }));
        setPosition({ x: newX, y: position ? position.y : (rect.top - parentOfParentRect.top) });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);

        const deltaX = upEvent.clientX - startPointerX;
        const finalWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth - deltaX));
        const actualDiff = finalWidth - startWidth;
        let finalX = currentX - actualDiff;

        const margin = 8;
        const minX = margin;
        const maxX = Math.max(margin, parentOfParentRect.width - finalWidth - margin);
        finalX = Math.max(minX, Math.min(maxX, finalX));

        setSize((prev) => {
          const updatedSize = { ...prev, width: finalWidth };
          localStorage.setItem('motion_editor_ai_chat_size', JSON.stringify(updatedSize));
          return updatedSize;
        });

        const finalY = position ? position.y : (rect.top - parentOfParentRect.top);
        const finalPos = { x: finalX, y: finalY };
        setPosition(finalPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(finalPos));

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [position],
  );

  const onResizeTopStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const startPointerY = e.clientY;
      const panelEl = wrapEl.querySelector(`.${styles.panel}`);
      const startHeight = panelEl ? panelEl.getBoundingClientRect().height : size.height;

      const currentX = position ? position.x : (rect.left - parentOfParentRect.left);
      const currentY = position ? position.y : (rect.top - parentOfParentRect.top);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaY = moveEvent.clientY - startPointerY;
        const newHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualDiff = newHeight - startHeight;

        let newY = currentY - actualDiff;
        const margin = 8;
        const minY = margin;

        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = newHeight + gap + barHeight;
        const maxConstrainedY = Math.max(margin, parentOfParentRect.height - newWrapHeight - margin);
        newY = Math.max(minY, Math.min(maxConstrainedY, newY));

        setSize((prev) => ({ ...prev, height: newHeight }));
        setPosition({ x: currentX, y: newY });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);

        const deltaY = upEvent.clientY - startPointerY;
        const finalHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualDiff = finalHeight - startHeight;
        let finalY = currentY - actualDiff;

        const margin = 8;
        const minY = margin;
        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = finalHeight + gap + barHeight;
        const maxConstrainedY = Math.max(margin, parentOfParentRect.height - newWrapHeight - margin);
        finalY = Math.max(minY, Math.min(maxConstrainedY, finalY));

        setSize((prev) => {
          const updatedSize = { ...prev, height: finalHeight };
          localStorage.setItem('motion_editor_ai_chat_size', JSON.stringify(updatedSize));
          return updatedSize;
        });

        const finalPos = { x: currentX, y: finalY };
        setPosition(finalPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(finalPos));

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [position, size.height],
  );

  const onResizeTopLeftStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const startPointerX = e.clientX;
      const startPointerY = e.clientY;
      const startWidth = rect.width;
      const panelEl = wrapEl.querySelector(`.${styles.panel}`);
      const startHeight = panelEl ? panelEl.getBoundingClientRect().height : size.height;

      const currentX = position ? position.x : (rect.left - parentOfParentRect.left);
      const currentY = position ? position.y : (rect.top - parentOfParentRect.top);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaX = moveEvent.clientX - startPointerX;
        const newWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth - deltaX));
        const actualWidthDiff = newWidth - startWidth;
        let newX = currentX - actualWidthDiff;

        const deltaY = moveEvent.clientY - startPointerY;
        const newHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualHeightDiff = newHeight - startHeight;
        let newY = currentY - actualHeightDiff;

        const margin = 8;
        newX = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.width - newWidth - margin), newX));

        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = newHeight + gap + barHeight;
        newY = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.height - newWrapHeight - margin), newY));

        setSize({ width: newWidth, height: newHeight });
        setPosition({ x: newX, y: newY });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);

        const deltaX = upEvent.clientX - startPointerX;
        const finalWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth - deltaX));
        const actualWidthDiff = finalWidth - startWidth;
        let finalX = currentX - actualWidthDiff;

        const deltaY = upEvent.clientY - startPointerY;
        const finalHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualHeightDiff = finalHeight - startHeight;
        let finalY = currentY - actualHeightDiff;

        const margin = 8;
        finalX = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.width - finalWidth - margin), finalX));

        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = finalHeight + gap + barHeight;
        finalY = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.height - newWrapHeight - margin), finalY));

        const updatedSize = { width: finalWidth, height: finalHeight };
        setSize(updatedSize);
        localStorage.setItem('motion_editor_ai_chat_size', JSON.stringify(updatedSize));

        const finalPos = { x: finalX, y: finalY };
        setPosition(finalPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(finalPos));

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [position, size.height],
  );

  const onResizeTopRightStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const wrapEl = wrapRef.current;
      if (!wrapEl) return;
      const parentEl = wrapEl.parentElement;
      if (!parentEl) return;

      const pointerId = e.pointerId;
      wrapEl.setPointerCapture(pointerId);

      const rect = parentEl.getBoundingClientRect();
      const parentOfParent = parentEl.offsetParent || document.body;
      const parentOfParentRect = parentOfParent.getBoundingClientRect();

      const startPointerX = e.clientX;
      const startPointerY = e.clientY;
      const startWidth = rect.width;
      const panelEl = wrapEl.querySelector(`.${styles.panel}`);
      const startHeight = panelEl ? panelEl.getBoundingClientRect().height : size.height;

      const currentX = position ? position.x : (rect.left - parentOfParentRect.left);
      const currentY = position ? position.y : (rect.top - parentOfParentRect.top);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;

        const deltaX = moveEvent.clientX - startPointerX;
        const newWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth + deltaX));

        const deltaY = moveEvent.clientY - startPointerY;
        const newHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualHeightDiff = newHeight - startHeight;
        let newY = currentY - actualHeightDiff;

        const margin = 8;
        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = newHeight + gap + barHeight;
        newY = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.height - newWrapHeight - margin), newY));

        setSize({ width: newWidth, height: newHeight });
        setPosition({ x: currentX, y: newY });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;

        wrapEl.releasePointerCapture(pointerId);

        const deltaX = upEvent.clientX - startPointerX;
        const finalWidth = Math.max(320, Math.min(parentOfParentRect.width - 16, startWidth + deltaX));

        const deltaY = upEvent.clientY - startPointerY;
        const finalHeight = Math.max(200, Math.min(parentOfParentRect.height - 48, startHeight - deltaY));
        const actualHeightDiff = finalHeight - startHeight;
        let finalY = currentY - actualHeightDiff;

        const margin = 8;
        const barEl = wrapEl.querySelector(`.${styles.bar}`);
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 38;
        const gap = 8;
        const newWrapHeight = finalHeight + gap + barHeight;
        finalY = Math.max(margin, Math.min(Math.max(margin, parentOfParentRect.height - newWrapHeight - margin), finalY));

        const updatedSize = { width: finalWidth, height: finalHeight };
        setSize(updatedSize);
        localStorage.setItem('motion_editor_ai_chat_size', JSON.stringify(updatedSize));

        const finalPos = { x: currentX, y: finalY };
        setPosition(finalPos);
        localStorage.setItem('motion_editor_ai_chat_pos', JSON.stringify(finalPos));


        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [position, size.height],
  );

  const wrapStyle: React.CSSProperties = {
    width: minimized ? 'auto' : size.width,
  };

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${isDragging ? styles.dragging : ''} ${minimized ? styles.isBubble : ''}`}
      style={wrapStyle}
    >
      {minimized ? (
        <button
          type="button"
          className={styles.bubble}
          onPointerDown={onDragStart}
          onDoubleClick={onResetPosition}
          onClick={() => toggleMinimized(false)}
          title="Double-click to reset position, Click to open Assistant"
          aria-label="Open assistant"
        >
          <Icon name="sparkles" size={18} />
        </button>
      ) : (
        <>
          {/* Invisible resize handle overlays */}
          <div className={styles.resizeL} onPointerDown={onResizeLeftStart} />
          <div className={styles.resizeR} onPointerDown={onResizeRightStart} />
          {expanded && (
            <>
              <div className={styles.resizeT} onPointerDown={onResizeTopStart} />
              <div className={styles.resizeTL} onPointerDown={onResizeTopLeftStart} />
              <div className={styles.resizeTR} onPointerDown={onResizeTopRightStart} />
            </>
          )}

          {expanded ? (
            <div className={styles.panel} style={{ height: size.height }}>
              <div
                className={styles.panelHeader}
                onPointerDown={onDragStart}
                onDoubleClick={onResetPosition}
                title="Double-click to reset position"
              >
                <div className={styles.dragIndicator} />
                <span className={styles.spark} aria-hidden>✦</span>
                <span className={styles.title}>Assistant</span>
                <button
                  type="button"
                  className={styles.collapse}
                  aria-label="Collapse assistant"
                  onClick={() => setExpanded(false)}
                >
                  <Icon name="chevron-down" size={14} />
                </button>
              </div>
              <div className={styles.messages}>
                {isOnline === false && (
                  <div style={{ margin: '8px 12px', padding: 8, fontSize: 11, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 4, color: '#f87171' }}>
                    ⚠ NestJS backend (localhost:4000) is offline. Start the backend by running <code>npm run dev</code> in <code>motion-back</code> to use assistant features.
                  </div>
                )}
                {messages.length === 0 ? (
                  <p className={styles.empty}>
                    Ask the assistant to animate, arrange, or generate. Your conversation appears here.
                  </p>
                ) : (
                  <div className={styles.messageWrapper}>
                    {messages.map((m, i) => (
                      <div
                        key={i}
                        className={m.role === 'user' ? styles.userMessage : styles.assistantMessage}
                      >
                        {m.text}
                      </div>
                    ))}
                  </div>
                )}
                {busy ? <div className={styles.thinkingMessage}>Thinking…</div> : null}
              </div>
            </div>
          ) : null}

          <div
            className={styles.bar}
            onPointerDown={onDragStart}
            onDoubleClick={onResetPosition}
            title="Double-click to reset position"
            style={{ cursor: 'grab' }}
          >
            <div className={styles.barDragHandle}>
              <Icon name="grip-vertical" size={12} />
            </div>
            <span className={styles.spark} aria-hidden>✦</span>
            <input
              className={styles.input}
              style={{ cursor: 'text' }}
              placeholder={isOnline === false ? 'Assistant offline (localhost:4000)…' : 'Ask anything…'}
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.currentTarget.value)}
              onFocus={() => setExpanded(true)}
              onKeyDown={onKeyDown}
            />
            
            <button
              type="button"
              className={styles.minimize}
              style={{ cursor: 'pointer' }}
              aria-label="Minimize assistant to bubble"
              title="Minimize to bubble"
              onClick={(e) => {
                e.stopPropagation();
                toggleMinimized(true);
              }}
            >
              <Icon name="minus" size={12} />
            </button>
            
            <button
              type="button"
              className={styles.send}
              style={{ cursor: 'pointer' }}
              aria-label="Send"
              disabled={!value.trim() || busy}
              onClick={() => void submit()}
            >
              <Icon name="arrow-up" size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

