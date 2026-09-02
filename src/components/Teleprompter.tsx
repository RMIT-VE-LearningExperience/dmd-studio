"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";

type PrompterRole = "host" | "guest" | "producer";

type TextAlign = "left" | "center" | "right";

type SharedControl = {
  playing?: boolean;
  speed?: number;
  nonce?: number;
  align?: TextAlign;
};

const ALIGN_KEY = "dmd-prompter-align";
function readSavedAlign(): TextAlign {
  if (typeof window === "undefined") return "center";
  const v = window.localStorage.getItem(ALIGN_KEY);
  return v === "left" || v === "right" ? v : "center";
}

type Props = {
  sessionId: string;
  uid: string;
  // True while a take is actually rolling (countdown finished) — the script
  // starts scrolling by itself so the reader's hands stay free.
  recordingActive?: boolean;
  onClose: () => void;
  mode?: "floating" | "embedded";
  role?: PrompterRole;
};

// Per-participant script overlay: paste or load a .txt, then auto-scroll it
// while recording. Personal scripts persist at scripts/{uid}; the shared
// script (scripts/shared) is followed LIVE by everyone without a personal
// one, and its `control` field lets the producer/host run the prompter
// remotely — play, pause, speed, restart — for the whole room. Producers
// always work on the shared script (they aren't in the recording).
export default function Teleprompter({
  sessionId,
  uid,
  recordingActive,
  onClose,
  mode = "floating",
  role = "guest",
}: Props) {
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

  // Mirrors for values snapshot callbacks need without re-subscribing.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  const initializedRef = useRef(false);
  const [align, setAlign] = useState<TextAlign>(() => readSavedAlign());
  // Host-only: "Share with guests" pushes the host's script to the shared
  // doc and flips the host into the producer-style directing mode.
  const [hostShares, setHostShares] = useState(false);
  const hostSharesRef = useRef(false);
  const personalTextRef = useRef("");
  const lastNonceRef = useRef<number | null>(null);
  // Ref, not closure state: the shared-doc snapshot below must see a personal
  // script saved AFTER subscribing, or a later shared edit would clobber it.
  const hasPersonalRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unsubShared: (() => void) | undefined;
    (async () => {
      let personal = "";
      if (role !== "producer") {
        try {
          const snap = await getDoc(doc(db, "sessions", sessionId, "scripts", uid));
          personal = (snap.data()?.text as string) ?? "";
        } catch {
          // Not readable — treat as absent.
        }
      }
      if (cancelled) return;
      hasPersonalRef.current = !!personal;
      personalTextRef.current = personal;
      if (personal) {
        initializedRef.current = true;
        setFromShared(false);
        setText(personal);
        setDraft(personal);
        setEditing(false);
      }

      // Follow the shared script live: it's the fallback text for anyone
      // without a personal script, the producer's working copy, and the
      // channel the producer/host drives everyone's prompter through.
      unsubShared = onSnapshot(doc(db, "sessions", sessionId, "scripts", "shared"), (snap) => {
        const data = snap.data();
        const sharedText = (data?.text as string) ?? "";
        const usesShared = role === "producer" || hostSharesRef.current || !hasPersonalRef.current;

        if (usesShared) {
          setFromShared(role !== "producer" && !!sharedText);
          setText(sharedText);
          if (!initializedRef.current) {
            initializedRef.current = true;
            setDraft(sharedText);
            setEditing(!sharedText);
          } else if (!editingRef.current) {
            setDraft(sharedText);
          }
        } else if (!initializedRef.current) {
          initializedRef.current = true;
        }

        // Remote control: guests reading the shared script follow the
        // producer/host's play state. Directors drive; they don't follow.
        const control = data?.control as SharedControl | undefined;
        if (usesShared && role === "guest" && control) {
          if (control.align === "left" || control.align === "center" || control.align === "right") {
            setAlign(control.align);
          }
          if (typeof control.speed === "number") {
            setSpeed(Math.min(10, Math.max(1, Math.round(control.speed))));
          }
          const nonce = control.nonce ?? 0;
          if (lastNonceRef.current === null) {
            lastNonceRef.current = nonce;
          } else if (nonce !== lastNonceRef.current) {
            lastNonceRef.current = nonce;
            applyOffset(0);
          }
          if (typeof control.playing === "boolean" && !editingRef.current) {
            setPlaying(control.playing && !!sharedText);
          }
        }
      });
    })();
    return () => {
      cancelled = true;
      unsubShared?.();
    };
  }, [sessionId, uid, role, applyOffset]);

  // Producers always direct; the host directs when reading the shared
  // script. Their play/pause/speed/restart also drive everyone following it.
  const directsShared = role === "producer" || (role === "host" && (fromShared || hostShares));
  const publishControl = useCallback(
    (patch: SharedControl) => {
      if (!directsShared) return;
      void setDoc(
        doc(db, "sessions", sessionId, "scripts", "shared"),
        { control: patch },
        { merge: true },
      ).catch(() => {});
    },
    [directsShared, sessionId],
  );

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
      // Producers edit the shared script itself — everyone following it sees
      // the change live. Everyone else saves a personal copy.
      const target = role === "producer" || hostSharesRef.current ? "shared" : uid;
      await setDoc(
        doc(db, "sessions", sessionId, "scripts", target),
        {
          text: draft,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      const cleared = !draft.trim();
      setText(draft);
      setFromShared(false);
      // Clearing a personal script drops back to following the shared one;
      // clearing the shared script also stops any run in progress.
      if (role !== "producer" && !hostSharesRef.current) {
        hasPersonalRef.current = !cleared;
        personalTextRef.current = draft;
      }
      setEditing(cleared);
      applyOffset(0);
      if (cleared) publishControl({ playing: false });
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

  const shareWithGuests = async () => {
    const body = (editing ? draft : text) ?? "";
    try {
      await setDoc(
        doc(db, "sessions", sessionId, "scripts", "shared"),
        { text: body, updatedAt: serverTimestamp(), control: { align } },
        { merge: true },
      );
      hostSharesRef.current = true;
      setHostShares(true);
      setEditing(false);
    } catch {
      window.alert("Couldn't share the script — try again.");
    }
  };

  const stopSharing = () => {
    publishControl({ playing: false });
    hostSharesRef.current = false;
    setHostShares(false);
    setPlaying(false);
    const personal = personalTextRef.current;
    if (personal) {
      setText(personal);
      setDraft(personal);
      setFromShared(false);
    }
  };

  const chooseAlign = (next: TextAlign) => {
    setAlign(next);
    try {
      window.localStorage.setItem(ALIGN_KEY, next);
    } catch {
      // Private mode etc. — alignment just won't persist.
    }
    publishControl({ align: next });
  };

  const restart = () => {
    setPlaying(false);
    applyOffset(0);
    publishControl({ playing: false, nonce: Date.now() });
  };

  return (
    <div
      ref={panelRef}
      className={
        mode === "embedded"
          ? // Height must be bounded by the viewport, not the parent (which
            // grows with content) — an unbounded panel fits the whole script,
            // leaving nothing to clip and therefore nothing to scroll.
            "flex h-[calc(100vh-23rem)] min-h-[16rem] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950"
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
          {(role === "producer" || hostShares) && (
            <span className="ml-1.5 font-normal text-indigo-400">· shared — edits go live to everyone</span>
          )}
          {fromShared && !editing && role !== "producer" && (
            <span className="ml-1.5 font-normal text-neutral-500">· shared script (live)</span>
          )}
        </div>
        {!editing && text && (
          <>
            <button
              onClick={() => {
                const next = !playing;
                setPlaying(next);
                publishControl({ playing: next });
              }}
              className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              {playing ? "Pause" : directsShared ? "Scroll for everyone" : "Scroll"}
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
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setSpeed(next);
                  publishControl({ speed: next });
                }}
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
            <div className="flex items-center gap-0.5 rounded-full border border-neutral-700 p-0.5" role="group" aria-label="Text alignment">
              {(
                [
                  ["left", AlignLeft, "Align left"],
                  ["center", AlignCenter, "Align centre"],
                  ["right", AlignRight, "Align right"],
                ] as const
              ).map(([value, Icon, title]) => (
                <button
                  key={value}
                  onClick={() => chooseAlign(value)}
                  title={title}
                  aria-pressed={align === value}
                  className={`rounded-full p-1 transition ${
                    align === value ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              ))}
            </div>
            {role === "host" && !hostShares && (
              <button
                onClick={() => void shareWithGuests()}
                title="Push this script to every guest's prompter and drive it for them"
                className="rounded-full border border-indigo-500/70 px-3 py-1 text-xs font-medium text-indigo-300 transition hover:bg-indigo-500/15"
              >
                Share with guests
              </button>
            )}
            {role === "host" && hostShares && (
              <button
                onClick={stopSharing}
                title="Back to your own script; guests keep the shared one"
                className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
              >
                Stop sharing
              </button>
            )}
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
                disabled={saving}
                title={draft.trim() ? "Save the script" : "Save with no text — clears the script"}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? "Saving…" : draft.trim() ? "Save script" : "Clear script"}
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
              className={`whitespace-pre-wrap font-medium leading-relaxed text-neutral-100 ${
                align === "left" ? "text-left" : align === "right" ? "text-right" : "text-center"
              }`}
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
