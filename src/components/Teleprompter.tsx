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
  const [speed, setSpeed] = useState(60); // pixels per second
  const [fontSize, setFontSize] = useState(28);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <div className="fixed left-1/2 top-14 z-50 flex max-h-[55vh] w-full max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950/95 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <span className="mr-auto text-xs font-semibold text-neutral-300">
          Script
          {fromShared && !editing && (
            <span className="ml-1.5 font-normal text-neutral-500">· provided by the host</span>
          )}
        </span>
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
              Speed
              <input
                type="range"
                min={15}
                max={200}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-20 accent-indigo-500"
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
