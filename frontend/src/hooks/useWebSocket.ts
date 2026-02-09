'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { WSEvent, WSEventType } from '@/types';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001';

type EventHandler = (event: WSEvent) => void;

interface UseWebSocketOptions {
  bettor?: boolean;
  path?: string;
  autoConnect?: boolean;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  lastEvent: WSEvent | null;
  subscribe: (type: WSEventType | '*', handler: EventHandler) => () => void;
  send: (type: string, payload?: Record<string, unknown>) => void;
  connect: () => void;
  disconnect: () => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { bettor = false, path, autoConnect = true } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  const getWsUrl = useCallback(() => {
    if (path) return `${WS_BASE}${path}`;
    return `${WS_BASE}/ws/${bettor ? 'bettor' : 'spectator'}`;
  }, [bettor, path]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    intentionalCloseRef.current = false;

    try {
      const url = getWsUrl();
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent;
          setLastEvent(data);

          const handlers = handlersRef.current.get(data.type);
          if (handlers) {
            handlers.forEach(handler => handler(data));
          }

          const wildcardHandlers = handlersRef.current.get('*');
          if (wildcardHandlers) {
            wildcardHandlers.forEach(handler => handler(data));
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        if (!intentionalCloseRef.current) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
          reconnectAttemptRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(() => connect(), delay);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };

      wsRef.current = ws;
    } catch {
      // connection failed
    }
  }, [getWsUrl]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect, autoConnect]);

  const subscribe = useCallback(
    (type: WSEventType | '*', handler: EventHandler): (() => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);
      return () => {
        handlersRef.current.get(type)?.delete(handler);
      };
    },
    []
  );

  const send = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
      }
    },
    []
  );

  return { isConnected, lastEvent, subscribe, send, connect, disconnect };
}
