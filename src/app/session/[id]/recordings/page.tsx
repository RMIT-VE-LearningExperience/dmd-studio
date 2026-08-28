"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import {
  ref as storageRef,
  listAll,
  getBlob,
  getDownloadURL,
  updateMetadata,
  type StorageReference,
} from "firebase/storage";
import { auth, db, storage } from "@/lib/firebase";
import { deleteRecording } from "@/lib/deletion";
import AppNav from "@/components/AppNav";

type RecordingDoc = {
  id: string;
  uid: string;
  take: number;
  displayName: string;
  role: string;
  kind: string;
  folder: string | null;
  audioOnly: boolean;
  chunkCount: number;
  totalBytes: number;
  mimeType: string;
  extension: string;
  startedAtMs: number | null;
  durationMs: number | null;
  label: string | null;
  uploadState: "recording" | "uploading" | "complete";
  completedAt: Timestamp | null;
  composedPath: string | null;
  previewPath: string | null;
  audioPath: string | null;
  transcript: string | null;
  transcriptStatus: "pending" | "done" | "error" | null;
};

type FullFetchState =
  | { phase: "idle" }
  | { phase: "fetching"; loadedBytes: number; totalBytes: number; doneChunks: number; totalChunks: number }
  | { phase: "ready"; url: string; blob: Blob }
  | { phase: "error"; message: string };

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ts: Timestamp | null) {
  if (!ts) return "";
  return ts.toDate().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Hands the file to the browser's own downloader rather than pulling it
// into memory through the SDK — that path hit the SDK's 2-minute operation
// ceiling ("storage/retry-limit-exceeded") on any take bigger than a few
// hundred MB. The content-disposition metadata is what makes the download
// URL save-as instead of play-inline; setting it is best-effort (guests
// lack write access to the host's files and still get the URL).
async function downloadStoragePath(path: string, filename: string) {
  const ref = storageRef(storage, path);
  const safeName = filename.replace(/["\\]/g, "");
  await updateMetadata(ref, { contentDisposition: `attachment; filename="${safeName}"` }).catch(
    () => {},
  );
  const url = await getDownloadURL(ref);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  a.target = "_blank";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Exact duration when the recorder captured one; chunk-count approximation
// (5s slices) for takes recorded before durations existed.
function takeDuration(rec: RecordingDoc) {
  if (rec.durationMs) return ` · ${formatDuration(Math.round(rec.durationMs / 1000))}`;
  if (rec.chunkCount > 0) return ` · ~${formatDuration(rec.chunkCount * 5)}`;
  return "";
}

function TakeTitle({ rec }: { rec: RecordingDoc }) {
  return (
    <p className="text-sm font-semibold">
      {rec.label ? (
        <>
          {rec.label} <span className="font-normal text-neutral-500">· {rec.displayName || "Unknown"}</span>
        </>
      ) : (
        rec.displayName || "Unknown"
      )}{" "}
      <span className="font-normal capitalize text-neutral-500">· {rec.role}</span>
      {rec.kind === "screen" && <span className="font-normal text-neutral-500"> · Screen</span>}
      {rec.audioOnly && <span className="font-normal text-neutral-500"> · Audio</span>}
      {rec.take > 1 && <span className="font-normal text-neutral-500"> · Take {rec.take}</span>}
    </p>
  );
}

// Rules allow the host (or the track's owner) to write; anyone else gets a
// clear error instead of a silent failure.
async function renameTake(sessionId: string, rec: RecordingDoc) {
  const next = window.prompt('Name this take (e.g. "Intro", "Q&A")', rec.label ?? "");
  if (next === null) return;
  try {
    await updateDoc(doc(db, "sessions", sessionId, "recordings", rec.id), {
      label: next.trim() || null,
    });
  } catch {
    window.alert("Couldn't rename this take — only the host or the person who recorded it can.");
  }
}

async function listSortedParts(sessionId: string, rec: RecordingDoc): Promise<StorageReference[]> {
  const folder = storageRef(
    storage,
    rec.folder ?? `recordings/${sessionId}/${rec.uid}/take-${rec.take}`,
  );
  const listing = await listAll(folder);
  // The folder may also hold the composed full file — only part-* chunks
  // belong in a stitch.
  const parts = listing.items
    .filter((item) => item.name.startsWith("part-"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (parts.length === 0) throw new Error("No recording files found in storage.");
  return parts;
}

// Downloads with a bounded number of chunks in flight at once — sequential
// one-at-a-time fetching was the main reason "Load & play" looked frozen on
// longer, high-bitrate takes.
async function downloadWithConcurrency(
  parts: StorageReference[],
  concurrency: number,
  onBytes: (bytes: number) => void,
): Promise<Blob[]> {
  const results: Blob[] = new Array(parts.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < parts.length) {
      const i = nextIndex++;
      const blob = await getBlob(parts[i]);
      results[i] = blob;
      onBytes(blob.size);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, worker));
  return results;
}

// MediaRecorder chunks are sequential slices of one continuous stream, so
// concatenating them in order reproduces the original file byte-for-byte.
async function stitchRecording(
  sessionId: string,
  rec: RecordingDoc,
  onBytes: (bytes: number) => void,
): Promise<Blob> {
  const parts = await listSortedParts(sessionId, rec);
  const blobs = await downloadWithConcurrency(parts, 6, onBytes);
  return new Blob(blobs, { type: rec.mimeType });
}

// The first chunk of a WebM recording contains the container header and is
// independently playable, so it makes an instant preview. MP4 recordings
// store their index (moov) at the END of the file, so their first chunk is
// NOT playable alone — the <video> onError fallback catches that case and
// points the user at "Load full recording" instead of sitting on a black box.
function QuickPreview({ sessionId, rec }: { sessionId: string; rec: RecordingDoc }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Streaming from the download URL lets the <video> start rendering
        // after a few hundred KB (range requests) instead of waiting for the
        // whole multi-MB chunk to download into a blob first.
        const parts = await listSortedParts(sessionId, rec);
        const streamUrl = await getDownloadURL(parts[0]);
        if (!cancelled) setUrl(streamUrl);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, rec.id]);

  if (error) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-black px-6 text-center text-xs text-neutral-500">
        Quick preview isn&rsquo;t available for this recording format — click &ldquo;Load full recording&rdquo; to watch it.
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-black text-xs text-neutral-600">
        Loading preview…
      </div>
    );
  }
  return (
    <video
      src={url}
      muted
      controls
      playsInline
      onError={() => setError(true)}
      className="w-full rounded-xl bg-black"
    />
  );
}

type EpisodeDoc = {
  id: string;
  take: number;
  status: "pending" | "processing" | "done" | "error";
  path: string | null;
  error: string | null;
  durationSec: number | null;
};

function formatDuration(sec: number | null) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function EpisodeRow({ sessionId, episode }: { sessionId: string; episode: EpisodeDoc }) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (episode.status !== "done" || !episode.path) return;
    let cancelled = false;
    getDownloadURL(storageRef(storage, episode.path))
      .then((url) => {
        if (!cancelled) setStreamUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [episode.status, episode.path]);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadStoragePath(episode.path!, `episode-take${episode.take}.mp4`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Download failed — try again.");
    } finally {
      setDownloading(false);
    }
  };

  const retry = async () => {
    const ref = doc(db, "sessions", sessionId, "episodes", episode.id);
    await deleteDoc(ref);
    await setDoc(ref, { take: episode.take, status: "pending", requestedAt: serverTimestamp() });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-indigo-900/60 bg-neutral-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            Episode{episode.take > 1 ? ` · Take ${episode.take}` : ""}
          </p>
          <p className="text-xs text-neutral-500">
            All tracks combined{episode.durationSec ? ` · ${formatDuration(episode.durationSec)}` : ""}
          </p>
        </div>
        {episode.status === "done" && (
          <button
            onClick={download}
            disabled={downloading}
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
          >
            {downloading ? "Downloading…" : "Download"}
          </button>
        )}
      </div>

      {(episode.status === "pending" || episode.status === "processing") && (
        <p className="text-xs text-neutral-500">
          Producing the episode… this takes a few minutes for longer recordings. It&rsquo;ll appear
          here automatically.
        </p>
      )}

      {episode.status === "error" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-red-400">Episode production failed: {episode.error}</p>
          <button onClick={retry} className="shrink-0 text-xs text-indigo-400 hover:underline">
            Retry
          </button>
        </div>
      )}

      {episode.status === "done" &&
        (streamUrl ? (
          <video src={streamUrl} controls playsInline className="w-full rounded-xl bg-black" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-black text-xs text-neutral-600">
            Loading player…
          </div>
        ))}
    </div>
  );
}

// A take that's still recording or whose upload hasn't confirmed complete.
// If the participant's tab died mid-upload, the host can finalize the track:
// flipping uploadState to "complete" lets the compose function assemble
// whatever chunks made it to Storage.
function InProgressRow({
  sessionId,
  rec,
  isHost,
}: {
  sessionId: string;
  rec: RecordingDoc;
  isHost: boolean;
}) {
  const [finalizing, setFinalizing] = useState(false);

  const finalize = async () => {
    const sure = window.confirm(
      `Finalize ${rec.displayName || rec.role}'s track now? Do this only if they're gone and the upload looks stuck — the recording will contain everything uploaded so far.`,
    );
    if (!sure) return;
    setFinalizing(true);
    try {
      await updateDoc(doc(db, "sessions", sessionId, "recordings", rec.id), {
        uploadState: "complete",
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to finalize.");
      setFinalizing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-900/50 bg-neutral-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {rec.displayName || "Unknown"}{" "}
            <span className="font-normal capitalize text-neutral-500">· {rec.role}</span>
            {rec.kind === "screen" && <span className="font-normal text-neutral-500"> · Screen</span>}
            {rec.take > 1 && <span className="font-normal text-neutral-500"> · Take {rec.take}</span>}
          </p>
          <p className="text-xs text-amber-400/90">
            {rec.uploadState === "recording"
              ? "Recording in progress — the track appears here as it uploads."
              : "Upload in progress on their device — waiting for it to finish."}
          </p>
        </div>
        {isHost && (
          <button
            onClick={finalize}
            disabled={finalizing}
            title="Assemble the track from the chunks uploaded so far"
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-amber-500 hover:text-amber-300 disabled:opacity-50"
          >
            {finalizing ? "Finalizing…" : "Finalize now"}
          </button>
        )}
      </div>
    </div>
  );
}

function TranscriptPanel({ rec }: { rec: RecordingDoc }) {
  const [copied, setCopied] = useState(false);

  if (!rec.transcriptStatus) return null;

  if (rec.transcriptStatus === "pending") {
    return (
      <p className="text-xs text-neutral-500">
        Transcribing… this usually takes a few minutes. It&rsquo;ll appear here automatically.
      </p>
    );
  }

  if (rec.transcriptStatus === "error") {
    return <p className="text-xs text-red-400">Transcription failed for this track.</p>;
  }

  if (!rec.transcript) {
    return <p className="text-xs text-neutral-500">No speech detected in this track.</p>;
  }

  const copy = async () => {
    await navigator.clipboard.writeText(rec.transcript!);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadTxt = () => {
    triggerDownload(
      new Blob([rec.transcript!], { type: "text/plain" }),
      `${rec.displayName || rec.role}-take${rec.take}-transcript.txt`,
    );
  };

  return (
    <details className="rounded-xl border border-neutral-800 bg-neutral-950/60">
      <summary className="cursor-pointer select-none px-4 py-3 text-xs font-medium text-neutral-300">
        Transcript
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={copy}
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            onClick={downloadTxt}
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
          >
            Download .txt
          </button>
        </div>
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">
          {rec.transcript}
        </p>
      </div>
    </details>
  );
}

// Once the Cloud Function has composed the take into a single file, playback
// is just streaming that file — no client-side stitching or full download.
function ComposedRecordingRow({ sessionId, rec }: { sessionId: string; rec: RecordingDoc }) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDownloadURL(storageRef(storage, rec.previewPath ?? rec.composedPath!))
      .then((url) => {
        if (!cancelled) setStreamUrl(url);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rec.previewPath, rec.composedPath]);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadStoragePath(
        rec.composedPath!,
        `${rec.displayName || rec.role}-take${rec.take}-original.${rec.extension}`,
      );
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Download failed — try again.");
    } finally {
      setDownloading(false);
    }
  };

  const downloadAudio = async () => {
    setDownloadingAudio(true);
    try {
      await downloadStoragePath(rec.audioPath!, `${rec.displayName || rec.role}-take${rec.take}-audio.wav`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Audio download failed — try again.");
    } finally {
      setDownloadingAudio(false);
    }
  };

  const remove = async () => {
    const who = rec.displayName || rec.role;
    const sure = window.confirm(`Delete ${who}'s recording (take ${rec.take})? This can't be undone.`);
    if (!sure) return;
    setDeleting(true);
    try {
      await deleteRecording(sessionId, rec.uid, rec.take, rec.folder, rec.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete recording.");
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <TakeTitle rec={rec} />
          <p className="text-xs text-neutral-500">
            {formatDate(rec.completedAt)} · {formatBytes(rec.totalBytes)}
            {takeDuration(rec)} · .{rec.extension}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => renameTake(sessionId, rec)}
            disabled={deleting}
            title="Name this take"
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
          >
            Rename
          </button>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              disabled={deleting}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Download options"
              className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
            >
              {downloading || downloadingAudio ? "Preparing…" : "Download ⋯"}
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 z-50 mt-1 flex w-60 flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void download();
                    }}
                    className="px-4 py-2 text-left text-xs text-neutral-200 transition hover:bg-neutral-800"
                  >
                    Original (full quality)
                    <span className="block text-[11px] text-neutral-500">
                      .{rec.extension} · {formatBytes(rec.totalBytes)}
                    </span>
                  </button>
                  {rec.previewPath && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void downloadStoragePath(
                          rec.previewPath!,
                          `${rec.displayName || rec.role}-take${rec.take}-720p.mp4`,
                        );
                      }}
                      className="px-4 py-2 text-left text-xs text-neutral-200 transition hover:bg-neutral-800"
                    >
                      Optimised (720p)
                      <span className="block text-[11px] text-neutral-500">MP4 · smaller, quick to share</span>
                    </button>
                  )}
                  {rec.audioPath && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void downloadAudio();
                      }}
                      className="px-4 py-2 text-left text-xs text-neutral-200 transition hover:bg-neutral-800"
                    >
                      Audio only
                      <span className="block text-[11px] text-neutral-500">WAV · 48 kHz stereo</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button
            onClick={remove}
            disabled={deleting || downloading}
            title="Delete recording"
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-400 transition hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {loadError ? (
        <p className="text-xs text-red-400">Couldn&rsquo;t load this recording — refresh to try again.</p>
      ) : streamUrl ? (
        <>
          <video src={streamUrl} controls playsInline className="w-full rounded-xl bg-black" />
          {!rec.previewPath && (
            <p className="text-xs text-neutral-500">
              Preparing an optimised preview — playing the full-quality original meanwhile, which may
              buffer.
            </p>
          )}
        </>
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-black text-xs text-neutral-600">
          Loading player…
        </div>
      )}

      <TranscriptPanel rec={rec} />
    </div>
  );
}

function RecordingRow({ sessionId, rec }: { sessionId: string; rec: RecordingDoc }) {
  const [full, setFull] = useState<FullFetchState>({ phase: "idle" });
  const [deleting, setDeleting] = useState(false);
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (full.phase === "ready") URL.revokeObjectURL(full.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFull = async (): Promise<{ url: string; blob: Blob } | null> => {
    if (full.phase === "ready") return { url: full.url, blob: full.blob };
    setFull({
      phase: "fetching",
      loadedBytes: 0,
      totalBytes: rec.totalBytes,
      doneChunks: 0,
      totalChunks: rec.chunkCount || 0,
    });
    try {
      const blob = await stitchRecording(sessionId, rec, (bytes) =>
        setFull((prev) =>
          prev.phase === "fetching"
            ? { ...prev, loadedBytes: prev.loadedBytes + bytes, doneChunks: prev.doneChunks + 1 }
            : prev,
        ),
      );
      const url = URL.createObjectURL(blob);
      setFull({ phase: "ready", url, blob });
      return { url, blob };
    } catch (err) {
      setFull({ phase: "error", message: err instanceof Error ? err.message : "Failed to load recording" });
      return null;
    }
  };

  const download = async () => {
    const result = await loadFull();
    if (!result) return;
    triggerDownload(result.blob, `${rec.displayName || rec.role}-take${rec.take}-raw.${rec.extension}`);
  };

  useEffect(() => {
    if (autoLoadedRef.current || full.phase !== "idle") return;
    autoLoadedRef.current = true;
    // Load the stitched take automatically so the inline player represents
    // the whole recording, not just the first MediaRecorder chunk.
    void loadFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

  const remove = async () => {
    const who = rec.displayName || rec.role;
    const sure = window.confirm(`Delete ${who}'s recording (take ${rec.take})? This can't be undone.`);
    if (!sure) return;
    setDeleting(true);
    try {
      // The row disappears via the recordings onSnapshot once the doc is gone.
      await deleteRecording(sessionId, rec.uid, rec.take, rec.folder, rec.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete recording.");
      setDeleting(false);
    }
  };

  // Older recording docs predate byte tracking (totalBytes 0) — fall back to
  // chunk-count progress so the bar always moves.
  const loadPercent =
    full.phase !== "fetching"
      ? 0
      : full.totalBytes > 0
        ? Math.min(100, Math.round((full.loadedBytes / full.totalBytes) * 100))
        : full.totalChunks > 0
          ? Math.min(100, Math.round((full.doneChunks / full.totalChunks) * 100))
          : 0;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <TakeTitle rec={rec} />
          <p className="text-xs text-neutral-500">
            {formatDate(rec.completedAt)} · {formatBytes(rec.totalBytes)}
            {takeDuration(rec)} · .{rec.extension}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {full.phase !== "ready" && (
            <button
              onClick={loadFull}
              disabled={full.phase === "fetching"}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {full.phase === "fetching" ? `Loading… ${loadPercent}%` : "Load full recording"}
            </button>
          )}
          <button
            onClick={() => renameTake(sessionId, rec)}
            disabled={deleting}
            title="Name this take"
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
          >
            Rename
          </button>
          <button
            onClick={download}
            disabled={full.phase === "fetching" || deleting}
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
          >
            Download
          </button>
          <button
            onClick={remove}
            disabled={deleting || full.phase === "fetching"}
            title="Delete recording"
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-400 transition hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {full.phase === "fetching" && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${loadPercent}%` }}
          />
        </div>
      )}

      {full.phase === "error" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-red-400">{full.message}</p>
          <button onClick={loadFull} className="shrink-0 text-xs text-indigo-400 hover:underline">
            Retry
          </button>
        </div>
      )}

      {full.phase === "ready" ? (
        <video src={full.url} controls playsInline className="w-full rounded-xl bg-black" />
      ) : (
        <QuickPreview sessionId={sessionId} rec={rec} />
      )}
      {full.phase !== "ready" && (
        <p className="text-xs text-neutral-600">
          Showing a quick preview of the first few seconds — click &ldquo;Load full recording&rdquo; to play the whole take.
        </p>
      )}
    </div>
  );
}

export default function RecordingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recordings, setRecordings] = useState<RecordingDoc[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeDoc[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [isTutorial, setIsTutorial] = useState(false);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthLoading(false);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    // No orderBy: in-progress docs have no completedAt yet and a server-side
    // order would silently drop them. Sorted client-side below.
    return onSnapshot(collection(db, "sessions", id, "recordings"), (snap) => {
      setRecordings(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            uid: (data.uid as string) ?? d.id.split("_take")[0],
            take: (data.take as number) ?? 1,
            displayName: (data.displayName as string) ?? "",
            role: (data.role as string) ?? "guest",
            kind: (data.kind as string) ?? "camera",
            folder: (data.folder as string) ?? null,
            audioOnly: (data.audioOnly as boolean) ?? false,
            startedAtMs: (data.startedAtMs as number) ?? null,
            durationMs: (data.durationMs as number) ?? null,
            label: (data.label as string) ?? null,
            uploadState: (data.uploadState as RecordingDoc["uploadState"]) ?? "complete",
            chunkCount: (data.chunkCount as number) ?? 0,
            totalBytes: (data.totalBytes as number) ?? 0,
            mimeType: (data.mimeType as string) ?? "video/webm",
            extension: (data.extension as string) ?? "webm",
            completedAt: (data.completedAt as Timestamp) ?? null,
            composedPath: (data.composedPath as string) ?? null,
            previewPath: (data.previewPath as string) ?? null,
            audioPath: (data.audioPath as string) ?? null,
            transcript: (data.transcript as string) ?? null,
            transcriptStatus: (data.transcriptStatus as RecordingDoc["transcriptStatus"]) ?? null,
          };
        })
          .sort((a, b) => {
            if (isTutorial) {
              if (a.take !== b.take) return b.take - a.take;
              if (a.kind !== b.kind) return a.kind === "screen" ? -1 : 1;
            }
            return (
              (b.completedAt?.toMillis() ?? b.startedAtMs ?? 0) -
              (a.completedAt?.toMillis() ?? a.startedAtMs ?? 0)
            );
          }),
      );
    });
  }, [user, id, isTutorial]);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(collection(db, "sessions", id, "episodes"), (snap) => {
      setEpisodes(
        snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              take: (data.take as number) ?? 1,
              status: (data.status as EpisodeDoc["status"]) ?? "pending",
              path: (data.path as string) ?? null,
              error: (data.error as string) ?? null,
              durationSec: (data.durationSec as number) ?? null,
            };
          })
          .sort((a, b) => a.take - b.take),
      );
    });
  }, [user, id]);

  // Only the host can request episodes (enforced by rules too) — hide the
  // button from guests viewing the page.
  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, "sessions", id))
      .then((snap) => {
        setIsHost(snap.data()?.hostUid === user.uid);
        setIsTutorial(snap.data()?.kind === "tutorial");
      })
      .catch(() => setIsHost(false));
  }, [user, id]);

  const produceEpisode = async (take: number) => {
    await setDoc(doc(db, "sessions", id, "episodes", `take-${take}`), {
      take,
      status: "pending",
      requestedAt: serverTimestamp(),
    });
  };

  // Takes with at least one composed track and no episode yet.
  const producibleTakes = [...new Set(
    recordings.filter((r) => r.composedPath).map((r) => r.take),
  )].filter((take) => !episodes.some((e) => e.take === take)).sort((a, b) => a - b);

  if (authLoading) {
    return <p className="p-6 text-neutral-500">Loading…</p>;
  }

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-neutral-100">
        <p className="text-sm text-neutral-400">Sign in to view recordings.</p>
        <Link href="/" className="text-sm text-indigo-400 hover:underline">
          Go to dashboard
        </Link>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <AppNav user={user} />
      <main className="px-8 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/projects" className="text-sm text-neutral-500 hover:text-neutral-300">
              ← Projects
            </Link>
            <h1 className="text-xl font-semibold">Recordings</h1>
          </div>
          <Link
            href={`/session/${id}`}
            className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Enter studio
          </Link>
        </header>

        {(episodes.length > 0 || (isHost && producibleTakes.length > 0)) && (
          <section className="flex flex-col gap-4">
            {episodes.map((ep) => (
              <EpisodeRow key={ep.id} sessionId={id} episode={ep} />
            ))}
            {isHost &&
              producibleTakes.map((take) => (
                <div
                  key={take}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/50 p-5"
                >
                  <div>
                    <p className="text-sm font-semibold">
                      Produce episode{producibleTakes.length > 1 || take > 1 ? ` · Take ${take}` : ""}
                    </p>
                    <p className="text-xs text-neutral-500">
                      Combines every uploaded track into one side-by-side video with mixed audio.
                    </p>
                  </div>
                  <button
                    onClick={() => produceEpisode(take)}
                    className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
                  >
                    Produce episode
                  </button>
                </div>
              ))}
          </section>
        )}

        {recordings.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No recordings yet. They appear here after a participant finishes uploading.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {recordings.map((rec) =>
              rec.uploadState !== "complete" && !rec.composedPath ? (
                <InProgressRow key={rec.id} sessionId={id} rec={rec} isHost={isHost} />
              ) : rec.composedPath ? (
                <ComposedRecordingRow key={rec.id} sessionId={id} rec={rec} />
              ) : (
                <RecordingRow key={rec.id} sessionId={id} rec={rec} />
              ),
            )}
          </div>
        )}
      </div>
      </main>
    </div>
  );
}
