"use client";

import { useEffect, useRef, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Props = {
  sessionId: string;
  title: string;
  onClose: () => void;
};

// Host-side script prep, done from the dashboard before the session. Saved
// as the session-level script (scripts/shared) — the teleprompter shows it
// to any participant who hasn't written a personal script.
export default function ScriptModal({ sessionId, title, onClose }: Props) {
  const [draft, setDraft] = useState<string | null>(null); // null while loading
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Session script</h2>
            <p className="text-xs text-neutral-500">
              {title} — shown in every participant&rsquo;s teleprompter unless they bring their own.
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
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
