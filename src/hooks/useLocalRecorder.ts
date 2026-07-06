"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ref as storageRef, uploadBytes, uploadBytesResumable } from "firebase/storage";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { storage, db } from "@/lib/firebase";
import {
  saveChunk,
  deleteChunk,
  getPendingChunks,
  saveTakeMeta,
  deleteTakeMeta,
} from "@/lib/recordingDb";
import { pickAudioRecorderOptions, pickRecorderOptions } from "@/lib/media";

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
  // True when the recorded stream had no video track (audio-only session) —
  // the episode producer substitutes a placeholder tile.
  audioOnly: boolean;
};

const CHUNK_INTERVAL_MS = 5000;

async function captureThumbnail(stream: MediaStream): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  try {
    await video.play();
  } catch {
    // Some browsers refuse play() without a DOM attachment; loadedmetadata
    // still usually gives us enough to draw the current stream frame.
  }

  await new Promise<void>((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, 1200);
    video.onloadeddata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  video.srcObject = null;
  if (!sourceWidth || !sourceHeight) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 640;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = canvas.width / canvas.height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82);
  });
}

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
        // No video track means an audio-only session — different container
        // candidates, no video bitrate.
        const options = track
          ? pickRecorderOptions(width ?? 1280, height ?? 720)
          : pickAudioRecorderOptions();

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
          audioOnly: !track,
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

        // Provisional recording doc, written the moment the take starts —
        // if this tab dies mid-take the host still sees the track exists
        // and can finalize whatever chunks made it to Storage. The compose
        // function waits for uploadState "complete".
        void setDoc(
          doc(db, "sessions", sessionId, "recordings", docIdFor(take)),
          {
            uid,
            take,
            displayName: meta.displayName,
            role: meta.role,
            kind: variant,
            folder: folderFor(take),
            audioOnly: takeSession.audioOnly,
            mimeType: recorder.mimeType || options.mimeType || "video/webm",
            extension: takeSession.extension,
            startedAtMs,
            uploadState: "recording",
          },
          { merge: true },
        ).catch(() => {});

        if (!isScreen && !takeSession.audioOnly) {
          const thumbnailPath = `${folderFor(take)}/thumbnail.jpg`;
          void captureThumbnail(stream)
            .then(async (thumbnail) => {
              if (!thumbnail) return;
              await uploadBytes(storageRef(storage, thumbnailPath), thumbnail, {
                contentType: "image/jpeg",
              });
              await setDoc(
                doc(db, "sessions", sessionId, "recordings", docIdFor(take)),
                { thumbnailPath },
                { merge: true },
              );
            })
            .catch(() => {});
        }

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
          audioOnly: takeSession.audioOnly,
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
      void setDoc(
        doc(db, "sessions", sessionId, "recordings", docIdFor(takeSession.take)),
        { uploadState: "uploading" },
        { merge: true },
      ).catch(() => {});

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
          audioOnly: takeSession.audioOnly,
          chunkCount: takeSession.chunkCount,
          totalBytes: takeSession.totalBytes,
          mimeType: recorder.mimeType || "video/webm",
          extension: takeSession.extension,
          ...(!isScreen && !takeSession.audioOnly
            ? { thumbnailPath: `${folderFor(takeSession.take)}/thumbnail.jpg` }
            : {}),
          startedAtMs: takeSession.startedAtMs,
          uploadState: "complete",
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
  }, [sessionId, uid, isScreen, variant, uploadChunk, chunkPathFor, folderFor, docIdFor]);

  return { status, error, progress, start, stopAndUpload };
}
