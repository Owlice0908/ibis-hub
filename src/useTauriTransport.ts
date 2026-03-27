import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type MessageHandler = (msg: any) => void;

/**
 * Tauri transport — same interface as useWS but backed by Tauri invoke/listen.
 * Translates Tauri commands and events to the same message protocol as server.mjs.
 */
export function useTauriTransport() {
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const listenersRef = useRef<Map<string, UnlistenFn>>(new Map());

  // emit always reads from ref — stable across re-renders, no stale closure
  const emitRef = useRef((msg: any) => {
    const handlers = [...handlersRef.current];
    handlers.forEach((h) => h(msg));
  });

  // Set up session event listeners for a given session ID
  async function attachSessionListeners(id: string) {
    // Avoid duplicate listeners
    if (listenersRef.current.has(`pty-${id}`)) return;

    const emit = emitRef.current;

    const unlistenOutput = await listen<string>(`pty-output-${id}`, (event) => {
      emit({ type: "pty_output", id, data: event.payload });
    });
    listenersRef.current.set(`pty-${id}`, unlistenOutput);

    const unlistenExited = await listen(`session-exited-${id}`, () => {
      emit({ type: "session_exited", id });
    });
    listenersRef.current.set(`exit-${id}`, unlistenExited);

    const unlistenQuestion = await listen(`session-question-${id}`, () => {
      emit({ type: "session_question", id });
    });
    listenersRef.current.set(`question-${id}`, unlistenQuestion);
  }

  function removeSessionListeners(id: string) {
    for (const prefix of ["pty-", "exit-", "question-"]) {
      const key = `${prefix}${id}`;
      const unlisten = listenersRef.current.get(key);
      if (unlisten) {
        unlisten();
        listenersRef.current.delete(key);
      }
    }
  }

  // Cleanup all listeners on unmount
  useEffect(() => {
    return () => {
      for (const unlisten of listenersRef.current.values()) {
        unlisten();
      }
      listenersRef.current.clear();
    };
  }, []);

  const send = useCallback(async (msg: any) => {
    const emit = emitRef.current;
    try {
      switch (msg.type) {
        case "create_session": {
          const session = await invoke<any>("create_session", {
            name: msg.name,
            workingDir: msg.working_dir || null,
            sessionType: msg.session_type || "claude",
          });
          await attachSessionListeners(session.id);
          emit({ type: "session_created", session });
          break;
        }

        case "attach_session": {
          await attachSessionListeners(msg.id);
          break;
        }

        case "write": {
          await invoke("write_to_session", { id: msg.id, data: msg.data });
          break;
        }

        case "resize": {
          await invoke("resize_session", {
            id: msg.id,
            cols: msg.cols,
            rows: msg.rows,
          });
          break;
        }

        case "close_session": {
          await invoke("close_session", { id: msg.id });
          removeSessionListeners(msg.id);
          emit({ type: "session_closed", id: msg.id });
          break;
        }

        case "rename_session": {
          await invoke("rename_session", { id: msg.id, name: msg.name });
          emit({ type: "session_renamed", id: msg.id, name: msg.name });
          break;
        }

        case "list_sessions": {
          const sessions = await invoke<any[]>("list_sessions");
          emit({ type: "session_list", sessions });
          break;
        }

        case "pick_files": {
          try {
            const platform = await invoke<string>("get_platform");
            let paths: string[] = [];
            if (platform === "wsl") {
              paths = await invoke<string[]>("pick_files_wsl");
            } else {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const result = await open({ multiple: true });
              if (result) {
                paths = Array.isArray(result)
                  ? result.map(f => typeof f === "string" ? f : (f as any).path)
                  : [typeof result === "string" ? result : (result as any).path];
              }
            }
            emit({ type: "files_picked", paths });
          } catch {
            emit({ type: "files_picked", paths: [] });
          }
          break;
        }

        case "upload_file": {
          emit({ type: "file_uploaded", path: msg.name, sessionId: msg.sessionId });
          break;
        }
      }
    } catch (e: any) {
      console.error(`Tauri command failed (${msg.type}):`, e);
      emit({ type: "session_error", error: e?.toString() || "Unknown error" });
    }
  }, []); // No dependencies — all state accessed via refs

  const onMessage = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  // connected is always true in Tauri (native, no network)
  return { send, onMessage, connected: true };
}
