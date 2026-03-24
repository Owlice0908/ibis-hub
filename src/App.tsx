import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import Sidebar from "./components/Sidebar";
import TerminalGrid from "./components/TerminalGrid";
import type { Session, LayoutMode } from "./types";

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [layout, setLayout] = useState<LayoutMode>("single");

  const createSession = useCallback(async (name?: string) => {
    try {
      const sessionName = name || `Session ${sessions.length + 1}`;
      const info = await invoke<Session>("create_session", {
        name: sessionName,
        workingDir: null,
      });
      setSessions((prev) => [...prev, info]);
      setActiveSessionIds((prev) => {
        const maxPanels = layout === "single" ? 1 : 4;
        if (prev.length < maxPanels) {
          return [...prev, info.id];
        }
        return [...prev.slice(1), info.id];
      });
    } catch (e) {
      console.error("Failed to create session:", e);
    }
  }, [sessions.length, layout]);

  const closeSession = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
    } catch (e) {
      console.error("Failed to close session:", e);
    }
  }, []);

  const selectSession = useCallback((id: string) => {
    setActiveSessionIds((prev) => {
      if (prev.includes(id)) return prev;
      const maxPanels = layout === "single" ? 1 : 4;
      if (prev.length < maxPanels) {
        return [...prev, id];
      }
      return [...prev.slice(1), id];
    });
  }, [layout]);

  const removeFromGrid = useCallback((id: string) => {
    setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
  }, []);

  return (
    <div className="flex h-screen bg-bg">
      <Sidebar
        sessions={sessions}
        activeSessionIds={activeSessionIds}
        layout={layout}
        onLayoutChange={setLayout}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        onCloseSession={closeSession}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {activeSessionIds.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-text mb-2">Ibis Hub</h2>
              <p className="text-text-muted mb-6">
                Claude Code session manager
              </p>
              <button
                onClick={() => createSession()}
                className="px-6 py-3 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors font-medium"
              >
                New Session
              </button>
            </div>
          </div>
        ) : (
          <TerminalGrid
            sessionIds={activeSessionIds}
            layout={layout}
            onRemoveFromGrid={removeFromGrid}
            onCloseSession={closeSession}
          />
        )}
      </main>
    </div>
  );
}

export default App;
