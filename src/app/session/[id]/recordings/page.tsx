"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { ref as storageRef, listAll, getBlob, getDownloadURL, type StorageReference } from "firebase/storage";
import { auth, db, storage } from "@/lib/firebase";
import { deleteRecording } from "@/lib/deletion";

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
  completedAt: Timestamp | null;
  composedPath: string | null;
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
      const blob = await getBlob(storageRef(storage, episode.path!));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `episode-take${episode.take}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
    const url = URL.createObjectURL(new Blob([rec.transcript!], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rec.displayName || rec.role}-take${rec.take}-transcript.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDownloadURL(storageRef(storage, rec.composedPath!))
      .then((url) => {
        if (!cancelled) setStreamUrl(url);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rec.composedPath]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await getBlob(storageRef(storage, rec.composedPath!));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rec.displayName || rec.role}-take${rec.take}.${rec.extension}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Download failed — try again.");
    } finally {
      setDownloading(false);
    }
  };

  const downloadAudio = async () => {
    setDownloadingAudio(true);
    try {
      const blob = await getBlob(storageRef(storage, rec.audioPath!));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rec.displayName || rec.role}-take${rec.take}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
          <p className="text-sm font-semibold">
            {rec.displayName || "Unknown"}{" "}
            <span className="font-normal capitalize text-neutral-500">· {rec.role}</span>
            {rec.kind === "screen" && <span className="font-normal text-neutral-500"> · Screen</span>}
            {rec.audioOnly && <span className="font-normal text-neutral-500"> · Audio</span>}
            {rec.take > 1 && <span className="font-normal text-neutral-500"> · Take {rec.take}</span>}
          </p>
          <p className="text-xs text-neutral-500">
            {formatDate(rec.completedAt)} · {formatBytes(rec.totalBytes)} · .{rec.extension}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={download}
            disabled={downloading || deleting}
            className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
          >
            {downloading ? "Downloading…" : "Download"}
          </button>
          {rec.audioPath && (
            <button
              onClick={downloadAudio}
              disabled={downloadingAudio || deleting}
              className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
            >
              {downloadingAudio ? "Downloading…" : "Audio (WAV)"}
            </button>
          )}
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
        <video src={streamUrl} controls playsInline className="w-full rounded-xl bg-black" />
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
    const a = document.createElement("a");
    a.href = result.url;
    a.download = `${rec.displayName || rec.role}-take${rec.take}.${rec.extension}`;
    a.click();
  };

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
          <p className="text-sm font-semibold">
            {rec.displayName || "Unknown"}{" "}
            <span className="font-normal capitalize text-neutral-500">· {rec.role}</span>
            {rec.kind === "screen" && <span className="font-normal text-neutral-500"> · Screen</span>}
            {rec.audioOnly && <span className="font-normal text-neutral-500"> · Audio</span>}
            {rec.take > 1 && <span className="font-normal text-neutral-500"> · Take {rec.take}</span>}
          </p>
          <p className="text-xs text-neutral-500">
            {formatDate(rec.completedAt)} · {formatBytes(rec.totalBytes)} · .{rec.extension}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
    const q = query(collection(db, "sessions", id, "recordings"), orderBy("completedAt", "desc"));
    return onSnapshot(q, (snap) => {
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
            chunkCount: (data.chunkCount as number) ?? 0,
            totalBytes: (data.totalBytes as number) ?? 0,
            mimeType: (data.mimeType as string) ?? "video/webm",
            extension: (data.extension as string) ?? "webm",
            completedAt: (data.completedAt as Timestamp) ?? null,
            composedPath: (data.composedPath as string) ?? null,
            audioPath: (data.audioPath as string) ?? null,
            transcript: (data.transcript as string) ?? null,
            transcriptStatus: (data.transcriptStatus as RecordingDoc["transcriptStatus"]) ?? null,
          };
        }),
      );
    });
  }, [user, id]);

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
      .then((snap) => setIsHost(snap.data()?.hostUid === user.uid))
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
    <main className="min-h-screen bg-neutral-950 px-8 py-10 text-neutral-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
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
              rec.composedPath ? (
                <ComposedRecordingRow key={rec.id} sessionId={id} rec={rec} />
              ) : (
                <RecordingRow key={rec.id} sessionId={id} rec={rec} />
              ),
            )}
          </div>
        )}
      </div>
    </main>
  );
}
