"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Props = {
  sessionId: string;
  uid: string;
  // True while a take is actually rolling (countdown finished) — the script
  // starts scrolling by itself so the reader's hands stay free.
  recordingActive?: boolean;
  onClose: () => void;
  mode?: "floating" | "embedded";
};

// Per-participant script overlay: paste or load a .txt, then auto-scroll it
// while recording. The script persists on the session (scripts/{uid}) so a
// refresh — or prepping days before the call — doesn't lose it.
export default function Teleprompter({ sessionId, uid, recordingActive, onClose, mode = "floating" }: Props) {
  const [text, setText] = useState<string | null>(null); // null while loading
  const [fromShared, setFromShared] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [prevActive, setPrevActive] = useState(!!recordingActive);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4); // 1-10 scale; actual scroll speed is speed * 5 px/s
  const [fontSize, setFontSize] = useState(28);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null); // viewport — sized by flex, clips content
  const contentRef = useRef<HTMLDivElement>(null); // moved via transform, not scrollTop
  const offsetRef = useRef(0); // current scroll offset in px, mirrors the applied transform
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const scrollSpeed = speed * 5;

  // Max offset before the last line has reached the top of the viewport.
  const getMaxOffset = useCallback(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return 0;
    return Math.max(0, content.scrollHeight - viewport.clientHeight);
  }, []);

  // Writes the transform directly to the DOM instead of going through React
  // state — a `translateY` on its own layer is compositor-only (hardware
  // accelerated, no layout/paint), unlike `scrollTop` which forces a
  // synchronous layout every frame and was the source of the jank outside a
  // narrow speed band.
  const applyOffset = useCallback(
    (next: number) => {
      const max = getMaxOffset();
      const clamped = Math.min(Math.max(next, 0), max);
      offsetRef.current = clamped;
      if (contentRef.current) contentRef.current.style.transform = `translateY(-${clamped}px)`;
      return clamped;
    },
    [getMaxOffset],
  );

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
      const dt = now - last;
      last = now;
      const clamped = applyOffset(offsetRef.current + (dt / 1000) * scrollSpeed);
      if (clamped >= getMaxOffset() - 0.5) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, scrollSpeed, applyOffset, getMaxOffset]);

  // Arrow keys nudge the script up/down — works whether auto-scroll is
  // playing or paused, so an operator can correct position on the fly.
  useEffect(() => {
    if (editing || text === null) return;
    const NUDGE_PX = 60;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        applyOffset(offsetRef.current + NUDGE_PX);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        applyOffset(offsetRef.current - NUDGE_PX);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, text, applyOffset]);

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
    if (mode === "embedded") return;
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
      applyOffset(0);
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
    applyOffset(0);
  };

  return (
    <div
      ref={panelRef}
      className={
        mode === "embedded"
          ? "flex h-full min-h-[28rem] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950"
          : `fixed z-50 flex max-h-[55vh] w-[min(calc(100vw-2rem),42rem)] flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950/95 shadow-2xl backdrop-blur ${
              position ? "" : "left-1/2 top-14 -translate-x-1/2"
            }`
      }
      style={mode === "floating" && position ? { left: position.x, top: position.y } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <div
          onPointerDown={startDrag}
          className={`mr-auto min-w-32 touch-none select-none text-xs font-semibold text-neutral-300 ${
            mode === "floating" ? "cursor-move" : ""
          }`}
          title={mode === "floating" ? "Drag to move script" : undefined}
        >
          Teleprompter
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
            <span className="text-[11px] text-neutral-600" title="Nudge the script up or down, playing or paused">
              ↑↓ to nudge
            </span>
            <button
              onClick={restart}
              title="Back to the top"
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Restart
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <span className="w-24 text-neutral-400">Scroll speed</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-24 accent-indigo-500"
                aria-label="Scroll speed"
              />
              <span className="w-4 tabular-nums text-neutral-400">{speed}</span>
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
        <div
          ref={scrollRef}
          onWheel={(e) => {
            e.preventDefault();
            applyOffset(offsetRef.current + e.deltaY);
          }}
          className="min-h-0 flex-1 overflow-hidden px-8 py-4"
        >
          {/* Moved via transform (see applyOffset) rather than the viewport's
              scrollTop, so the animation runs on the compositor thread. */}
          <div ref={contentRef} style={{ willChange: "transform" }}>
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
        </div>
      )}
    </div>
  );
}
