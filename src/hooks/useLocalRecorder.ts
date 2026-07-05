"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { storage, db } from "@/lib/firebase";
import {
  saveChunk,
  deleteChunk,
  getPendingChunks,
  saveTakeMeta,
  deleteTakeMeta,
} from "@/lib/recordingDb";
import { pickRecorderOptions } from "@/lib/media";

export type RecorderStatus =
  | "idle"
  | "recording"
  | "finishing"
  | "uploaded"
  | "error";

export type UploadProgress = {
  uploadedChunks: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
};

export type RecordingMeta = {
  displayName: string;
  role: string;
};

// All state for one take lives in one closure object. Chunk uploads capture
// their take's paths at enqueue time, so a new take starting while the
// previous take's uploads are still draining can never cross-contaminate
// folders, counters, or IndexedDB namespaces.
type ActiveTake = {
  take: number;
  recId: string;
  extension: string;
  meta: RecordingMeta;
  recorder: MediaRecorder;
  chunkCount: number;
  totalBytes: number;
  // Wall-clock start, published with the completion doc — the episode
  // producer aligns everyone's tracks by these.
  startedAtMs: number;
};

const CHUNK_INTERVAL_MS = 5000;

export type RecorderVariant = "camera" | "screen";

export function useLocalRecorder(
  sessionId: string,
  uid: string,
  variant: RecorderVariant = "camera",
) {
  const isScreen = variant === "screen";
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress>({
    uploadedChunks: 0,
    totalChunks: 0,
    uploadedBytes: 0,
    totalBytes: 0,
  });

  const activeTakeRef = useRef<ActiveTake | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Mirror upload state onto this participant's presence doc so the host can
  // see everyone's upload health live (and after a guest leaves the call).
  // Progress state only changes about once per chunk (~5s), so this stays
  // one small write per participant per chunk.
  useEffect(() => {
    if (status === "idle") return;
    setDoc(
      doc(db, "sessions", sessionId, "participants", uid),
      {
        [isScreen ? "screenUpload" : "upload"]: {
          state: status,
          take: activeTakeRef.current?.take ?? 0,
          uploadedBytes: progress.uploadedBytes,
          totalBytes: progress.totalBytes,
          updatedAt: serverTimestamp(),
        },
      },
      { merge: true },
    ).catch(() => {});
  }, [sessionId, uid, isScreen, status, progress]);

  // Chunks upload one at a time, in order, as they're recorded — each is
  // its own Storage object so a crash mid-call only loses the last few
  // seconds still sitting in IndexedDB, not the whole take.
  const uploadChunk = useCallback(
    (recId: string, path: string, index: number, blob: Blob) => {
      const fileRef = storageRef(storage, path);
      return new Promise<void>((resolve) => {
        const task = uploadBytesResumable(fileRef, blob);
        task.on(
          "state_changed",
          undefined,
          () => resolve(), // leave chunk in IndexedDB; retried during the finishing sweep
          async () => {
            await deleteChunk(recId, index);
            setProgress((p) => ({
              ...p,
              uploadedChunks: p.uploadedChunks + 1,
              uploadedBytes: p.uploadedBytes + blob.size,
            }));
            resolve();
          },
        );
      });
    },
    [],
  );

  // Screen recordings live beside the camera take in their own folder and
  // doc, so the whole pipeline (compose → episode) treats them as one more
  // track of the same take.
  const folderFor = useCallback(
    (take: number) =>
      `recordings/${sessionId}/${uid}/${isScreen ? "screen-take" : "take"}-${take}`,
    [sessionId, uid, isScreen],
  );

  const docIdFor = useCallback(
    (take: number) => `${uid}${isScreen ? "_screen" : ""}_take${take}`,
    [uid, isScreen],
  );

  const chunkPathFor = useCallback(
    (take: number, extension: string, index: number) =>
      `${folderFor(take)}/part-${String(index).padStart(5, "0")}.${extension}`,
    [folderFor],
  );

  const start = useCallback(
    (stream: MediaStream, take: number, meta: RecordingMeta) => {
      if (activeTakeRef.current && activeTakeRef.current.recorder.state !== "inactive") {
        return; // already recording — ignore double-starts
      }
      try {
        const track = stream.getVideoTracks()[0];
        const { width, height } = track?.getSettings() ?? {};
        const options = pickRecorderOptions(width ?? 1280, height ?? 720);

        const recorder = new MediaRecorder(stream, options);
        const startedAtMs = Date.now();
        const takeSession: ActiveTake = {
          take,
          recId: `${sessionId}_${uid}${isScreen ? "_screen" : ""}_t${take}`,
          extension: options.extension,
          meta,
          recorder,
          chunkCount: 0,
          totalBytes: 0,
          startedAtMs,
        };

        setProgress({ uploadedChunks: 0, totalChunks: 0, uploadedBytes: 0, totalBytes: 0 });

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) return;
          // Everything this chunk needs is captured from takeSession now —
          // by the time the queued upload runs, a newer take may already own
          // the shared refs.
          const index = takeSession.chunkCount;
          takeSession.chunkCount += 1;
          takeSession.totalBytes += event.data.size;
          const path = chunkPathFor(takeSession.take, takeSession.extension, index);

          setProgress((p) => ({
            ...p,
            totalChunks: p.totalChunks + 1,
            totalBytes: p.totalBytes + event.data.size,
          }));

          uploadQueueRef.current = uploadQueueRef.current
            .then(() => saveChunk(takeSession.recId, index, event.data))
            .then(() => uploadChunk(takeSession.recId, path, index, event.data));
        };

        recorder.onerror = (event) => {
          setStatus("error");
          setError((event as unknown as { error?: Error }).error?.message ?? "Recording error");
        };

        recorder.start(CHUNK_INTERVAL_MS);
        activeTakeRef.current = takeSession;
        stopPromiseRef.current = null;
        setError(null);
        setStatus("recording");

        // Persisted until the completion doc is written — if the tab dies
        // mid-take, this record is what lets the next visit resume the upload.
        void saveTakeMeta({
          recId: takeSession.recId,
          sessionId,
          uid,
          take,
          extension: takeSession.extension,
          mimeType: recorder.mimeType || options.mimeType || "video/webm",
          displayName: meta.displayName,
          role: meta.role,
          startedAtMs,
          kind: variant,
          folder: folderFor(take),
          docId: docIdFor(take),
        }).catch(() => {});
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to start recording");
      }
    },
    [sessionId, uid, isScreen, variant, uploadChunk, chunkPathFor, folderFor, docIdFor],
  );

  const stopAndUpload = useCallback((): Promise<void> => {
    const takeSession = activeTakeRef.current;
    if (!takeSession || takeSession.recorder.state === "inactive") {
      return stopPromiseRef.current ?? Promise.resolve();
    }
    // Idempotent: Leave and the recording-flag listener can both call this;
    // the second caller must share the first's promise, not re-arm onstop
    // (which would leave the first caller waiting forever).
    if (stopPromiseRef.current) return stopPromiseRef.current;

    const promise = (async () => {
      const { recorder } = takeSession;
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
      setStatus("finishing");

      try {
        await uploadQueueRef.current;

        // Sweep for any chunks that failed mid-call and retry them serially.
        let pending = await getPendingChunks(takeSession.recId);
        let attempts = 0;
        while (pending.length > 0 && attempts < 3) {
          for (const { index, blob } of pending) {
            await uploadChunk(
              takeSession.recId,
              chunkPathFor(takeSession.take, takeSession.extension, index),
              index,
              blob,
            );
          }
          pending = await getPendingChunks(takeSession.recId);
          attempts += 1;
        }

        if (pending.length > 0) {
          throw new Error(`${pending.length} chunk(s) failed to upload after retries`);
        }

        await setDoc(doc(db, "sessions", sessionId, "recordings", docIdFor(takeSession.take)), {
          uid,
          take: takeSession.take,
          displayName: takeSession.meta.displayName,
          role: takeSession.meta.role,
          kind: variant,
          folder: folderFor(takeSession.take),
          chunkCount: takeSession.chunkCount,
          totalBytes: takeSession.totalBytes,
          mimeType: recorder.mimeType || "video/webm",
          extension: takeSession.extension,
          startedAtMs: takeSession.startedAtMs,
          completedAt: serverTimestamp(),
        });
        await deleteTakeMeta(takeSession.recId);

        setStatus("uploaded");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    })();

    stopPromiseRef.current = promise;
    return promise;
  }, [sessionId, uid, variant, uploadChunk, chunkPathFor, folderFor, docIdFor]);

  return { status, error, progress, start, stopAndUpload };
}
