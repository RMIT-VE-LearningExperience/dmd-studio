"use client";

import { useEffect, useRef, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Props = {
  sessionId: string;
  title: string;
  onClose: () => void;
};

type Point = { x: number; y: number };

// Host-side script prep, done from the dashboard before the session. Saved
// as the session-level script (scripts/shared) — the teleprompter shows it
// to any participant who hasn't written a personal script.
export default function ScriptModal({ sessionId, title, onClose }: Props) {
  const [draft, setDraft] = useState<string | null>(null); // null while loading
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const dragOriginRef = useRef<{ pointer: Point; modal: Point } | null>(null);
  const [pos, setPos] = useState<Point | null>(null); // null = default centered
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "sessions", sessionId, "scripts", "shared"))
      .then((snap) => {
        if (!cancelled) setDraft((snap.data()?.text as string) ?? "");
      })
      .catch(() => {
        if (!cancelled) setDraft("");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Dragging is driven from window-level listeners (not the header element)
  // so the modal keeps following the pointer even when it moves faster than
  // the cursor can stay over the small header bar.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const origin = dragOriginRef.current;
      const rect = modalRef.current?.getBoundingClientRect();
      if (!origin || !rect) return;

      const margin = 32; // keep at least this much of the modal on-screen
      const nextX = origin.modal.x + (e.clientX - origin.pointer.x);
      const nextY = origin.modal.y + (e.clientY - origin.pointer.y);
      setPos({
        x: Math.min(Math.max(nextX, margin - rect.width), window.innerWidth - margin),
        y: Math.min(Math.max(nextY, 0), window.innerHeight - margin),
      });
    };
    const onUp = () => setDragging(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // primary button/touch only
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOriginRef.current = { pointer: { x: e.clientX, y: e.clientY }, modal: { x: rect.left, y: rect.top } };
    setDragging(true);
  };

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await setDoc(doc(db, "sessions", sessionId, "scripts", "shared"), {
        text: draft,
        updatedAt: serverTimestamp(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      window.alert("Couldn't save the script — try again.");
    } finally {
      setSaving(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft((await file.text()).slice(0, 50_000));
    } catch {
      window.alert("Couldn't read that file — paste the text instead.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={pos ? { position: "fixed", left: pos.x, top: pos.y, margin: 0 } : undefined}
        className={`flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl ${
          dragging ? "select-none" : ""
        }`}
      >
        <div
          onPointerDown={startDrag}
          className={`-mx-5 -mt-5 flex items-center justify-between rounded-t-2xl px-5 pb-3 pt-4 ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <span aria-hidden className="text-neutral-600">
                ⠿
              </span>
              Session script
            </h2>
            <p className="text-xs text-neutral-500">
              {title} — shown in every participant&rsquo;s teleprompter unless they bring their own.
            </p>
          </div>
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            Close
          </button>
        </div>

        {draft === null ? (
          <p className="py-8 text-center text-xs text-neutral-500">Loading…</p>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 50_000))}
              placeholder="Paste the script here, or load a .txt file below…"
              className="h-64 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-indigo-500"
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
              <button
                onClick={save}
                disabled={saving}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {saved ? "Saved ✓" : saving ? "Saving…" : "Save script"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
