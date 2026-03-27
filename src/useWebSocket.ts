import { useEffect, useRef, useCallback, useState } from "react";

type MessageHandler = (msg: any) => void;

export function useWS(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryCount = 0;
        setConnected(true);
      };
      ws.onclose = (e) => {
        setConnected(false);
        // Don't reconnect on intentional close or permanent errors
        if (disposed || e.code === 1008 || e.code === 1011) return;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        retryCount++;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        ws.close();
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          // Snapshot handlers to avoid issues if Set is mutated during iteration
          const handlers = [...handlersRef.current];
          handlers.forEach((h) => h(msg));
        } catch (err) {
          console.warn("WebSocket message parse error:", err);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [url]);

  const send = useCallback((msg: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const onMessage = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  return { send, onMessage, connected };
}
