"use client";

import { useEffect, useRef, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Props = {
  sessionId: string;
  uid: string;
  // True while a take is actually rolling (countdown finished) — the script
  // starts scrolling by itself so the reader's hands stay free.
  recordingActive?: boolean;
  onClose: () => void;
};

// Per-participant script overlay: paste or load a .txt, then auto-scroll it
// while recording. The script persists on the session (scripts/{uid}) so a
// refresh — or prepping days before the call — doesn't lose it.
export default function Teleprompter({ sessionId, uid, recordingActive, onClose }: Props) {
  const [text, setText] = useState<string | null>(null); // null while loading
  const [fromShared, setFromShared] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [prevActive, setPrevActive] = useState(!!recordingActive);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(18); // pixels per second
  const [fontSize, setFontSize] = useState(28);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let personal = "";
      let shared = "";
      try {
        const snap = await getDoc(doc(db, "sessions", sessionId, "scripts", uid));
        personal = (snap.data()?.text as string) ?? "";
        if (!personal) {
          // Fall back to the script the host prepared for the session.
          const sharedSnap = await getDoc(doc(db, "sessions", sessionId, "scripts", "shared"));
          shared = (sharedSnap.data()?.text as string) ?? "";
        }
      } catch {
        // Neither readable — start with an empty editor.
      }
      if (cancelled) return;
      const effective = personal || shared;
      setFromShared(!personal && !!shared);
      setText(effective);
      setDraft(effective);
      setEditing(!effective);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, uid]);

  // Recording started/stopped since last render — start or stop scrolling
  // (adjusting state during render per React's derived-state pattern).
  if (!!recordingActive !== prevActive) {
    setPrevActive(!!recordingActive);
    if (recordingActive && text && !editing) setPlaying(true);
    if (!recordingActive) setPlaying(false);
  }

  // Auto-scroll loop; pauses itself at the end of the script.
  useEffect(() => {
    if (!playing) return;
    let raf: number;
    let last = performance.now();
    const step = (now: number) => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop += ((now - last) / 1000) * speed;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          setPlaying(false);
          return;
        }
      }
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 640;
      const height = panel?.offsetHeight ?? 360;
      const margin = 12;
      setPosition({
        x: Math.min(
          Math.max(event.clientX - dragOffsetRef.current.x, margin),
          window.innerWidth - width - margin,
        ),
        y: Math.min(
          Math.max(event.clientY - dragOffsetRef.current.y, margin),
          window.innerHeight - height - margin,
        ),
      });
    };

    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffsetRef.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setPosition({ x: rect.left, y: rect.top });
    setDragging(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, "sessions", sessionId, "scripts", uid), {
        text: draft,
        updatedAt: serverTimestamp(),
      });
      setText(draft);
      setFromShared(false);
      setEditing(false);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    } catch {
      window.alert("Couldn't save the script — try again.");
    } finally {
      setSaving(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft(await file.text());
    } catch {
      window.alert("Couldn't read that file — paste the text instead.");
    }
  };

  const restart = () => {
    setPlaying(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return (
    <div
      ref={panelRef}
      className={`fixed z-50 flex max-h-[55vh] w-[min(calc(100vw-2rem),42rem)] flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950/95 shadow-2xl backdrop-blur ${
        position ? "" : "left-1/2 top-14 -translate-x-1/2"
      }`}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <div
          onPointerDown={startDrag}
          className="mr-auto min-w-32 cursor-move touch-none select-none text-xs font-semibold text-neutral-300"
          title="Drag to move script"
        >
          Script
          {fromShared && !editing && (
            <span className="ml-1.5 font-normal text-neutral-500">· provided by the host</span>
          )}
        </div>
        {!editing && text && (
          <>
            <button
              onClick={() => setPlaying((p) => !p)}
              className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              {playing ? "Pause" : "Scroll"}
            </button>
            <button
              onClick={restart}
              title="Back to the top"
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Restart
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <span className="w-16 tabular-nums text-neutral-400">{speed} px/s</span>
              <input
                type="range"
                min={4}
                max={40}
                step={1}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-24 accent-indigo-500"
                aria-label="Script scroll speed"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              Size
              <input
                type="range"
                min={18}
                max={48}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-16 accent-indigo-500"
              />
            </label>
            <button
              onClick={() => {
                setPlaying(false);
                setEditing(true);
              }}
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Edit
            </button>
          </>
        )}
        <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
          Close
        </button>
      </div>

      {text === null ? (
        <p className="px-4 py-6 text-center text-xs text-neutral-500">Loading your script…</p>
      ) : editing ? (
        <div className="flex flex-col gap-3 p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 50_000))}
            placeholder="Paste your script here, or load a .txt file below…"
            className="h-48 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-indigo-500"
          />
          <div className="flex items-center justify-between gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,text/plain"
              onChange={(e) => loadFile(e.target.files?.[0])}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Load .txt file
            </button>
            <div className="flex items-center gap-2">
              {text && (
                <button
                  onClick={() => {
                    setDraft(text);
                    setEditing(false);
                  }}
                  className="rounded-full border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:border-neutral-500"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={save}
                disabled={saving || !draft.trim()}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save script"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="overflow-y-auto px-8 py-4">
          {/* Lead-in / lead-out space so the first and last lines can reach
              the reading line mid-panel. */}
          <div className="h-[20vh]" />
          <p
            className="whitespace-pre-wrap font-medium leading-relaxed text-neutral-100"
            style={{ fontSize }}
          >
            {text}
          </p>
          <div className="h-[35vh]" />
        </div>
      )}
    </div>
  );
}
