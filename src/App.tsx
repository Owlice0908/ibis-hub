import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import Sidebar from "./components/Sidebar";
import TerminalGrid from "./components/TerminalGrid";
import type { Session, LayoutMode } from "./types";

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [layout, setLayout] = useState<LayoutMode>("single");
  const [questionSessions, setQuestionSessions] = useState<Set<string>>(
    new Set()
  );

  // Listen for question events from all sessions
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    for (const session of sessions) {
      const eventName = `session-question-${session.id}`;
      listen<string>(eventName, () => {
        setQuestionSessions((prev) => {
          const next = new Set(prev);
          next.add(session.id);
          return next;
        });
      }).then((unlisten) => {
        unlisteners.push(unlisten);
      });
    }

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [sessions]);

  const createSession = useCallback(
    async (name?: string) => {
      try {
        const sessionName = name || `Session ${sessions.length + 1}`;
        const info = await invoke<Session>("create_session", {
          name: sessionName,
          workingDir: null,
          sessionType: "shell",
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
    },
    [sessions.length, layout]
  );

  const closeSession = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
      setQuestionSessions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      console.error("Failed to close session:", e);
    }
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      // Clear question notification when user interacts with a session
      setQuestionSessions((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      setActiveSessionIds((prev) => {
        if (prev.includes(id)) return prev;
        const maxPanels = layout === "single" ? 1 : 4;
        if (prev.length < maxPanels) {
          return [...prev, id];
        }
        return [...prev.slice(1), id];
      });
    },
    [layout]
  );

  const removeFromGrid = useCallback((id: string) => {
    setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
  }, []);

  const renameSession = useCallback(async (id: string, name: string) => {
    try {
      await invoke("rename_session", { id, name });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, name } : s))
      );
    } catch (e) {
      console.error("Failed to rename session:", e);
    }
  }, []);

  return (
    <div className="flex h-screen bg-bg">
      <Sidebar
        sessions={sessions}
        activeSessionIds={activeSessionIds}
        layout={layout}
        questionSessionIds={Array.from(questionSessions)}
        onLayoutChange={setLayout}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        onCloseSession={closeSession}
        onRenameSession={renameSession}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {activeSessionIds.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-text mb-2">
                Ibis Hub
              </h2>
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
