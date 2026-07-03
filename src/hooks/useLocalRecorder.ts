"use client";

import { useCallback, useRef, useState } from "react";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase";
import { saveChunk, getChunks, clearRecording } from "@/lib/recordingDb";

export type RecorderStatus =
  | "idle"
  | "recording"
  | "stopped"
  | "uploading"
  | "uploaded"
  | "error";

const MIME_TYPE = "video/webm;codecs=vp9,opus";
const CHUNK_INTERVAL_MS = 5000;

export function useLocalRecorder(sessionId: string, participantId: string) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  const recordingId = `${sessionId}_${participantId}`;

  const start = useCallback(
    (stream: MediaStream) => {
      try {
        const mimeType = MediaRecorder.isTypeSupported(MIME_TYPE)
          ? MIME_TYPE
          : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        chunkIndexRef.current = 0;

        recorder.ondataavailable = async (event) => {
          if (event.data && event.data.size > 0) {
            await saveChunk(recordingId, chunkIndexRef.current, event.data);
            chunkIndexRef.current += 1;
          }
        };

        recorder.onerror = (event) => {
          setStatus("error");
          setError((event as unknown as { error?: Error }).error?.message ?? "Recording error");
        };

        recorder.start(CHUNK_INTERVAL_MS);
        recorderRef.current = recorder;
        setStatus("recording");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to start recording");
      }
    },
    [recordingId],
  );

  const stopAndUpload = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    setStatus("stopped");

    try {
      setStatus("uploading");
      const chunks = await getChunks(recordingId);
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      const fileRef = storageRef(storage, `recordings/${sessionId}/${participantId}.webm`);
      await uploadBytes(fileRef, blob);
      await clearRecording(recordingId);
      setStatus("uploaded");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }, [recordingId, sessionId, participantId]);

  return { status, error, start, stopAndUpload };
}
