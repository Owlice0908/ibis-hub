import { useEffect, useRef, useCallback, useState } from "react";

type MessageHandler = (msg: any) => void;

export function useWS(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      // Watchdog: if a sleeping laptop / dropped Wi-Fi leaves the socket
      // "half-open", no close event fires and the pane freezes. The server
      // pings every 25s, so going ~60s without ANY message means the
      // connection is dead — force-close it to trigger a reconnect.
      const WATCHDOG_MS = 60000;
      const kickWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
          try { ws.close(); } catch {}
        }, WATCHDOG_MS);
      };

      ws.onopen = () => {
        retryCount = 0;
        setConnected(true);
        kickWatchdog();
      };
      ws.onclose = (e) => {
        setConnected(false);
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
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
        kickWatchdog(); // any message (incl. server ping) proves we're alive
        try {
          const msg = JSON.parse(e.data);
          if (msg && msg.type === "ping") {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
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
      if (watchdogTimer) clearTimeout(watchdogTimer);
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
