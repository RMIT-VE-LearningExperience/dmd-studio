"use client";

import { useEffect, useRef, useState } from "react";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useWebRTCSession, type Role } from "@/hooks/useWebRTCSession";
import { useLocalRecorder } from "@/hooks/useLocalRecorder";

type Props = {
  sessionId: string;
  role: Role;
};

export default function RecordingRoom({ sessionId, role }: Props) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [joined, setJoined] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const participantId = role === "host" ? "host" : "guest";
  const { connect, remoteStream, connectionState } = useWebRTCSession(sessionId, role);
  const { status: recordingStatus, error: recordingError, start, stopAndUpload } =
    useLocalRecorder(sessionId, participantId);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const join = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      await setDoc(
        doc(db, "sessions", sessionId),
        { [`participants.${participantId}`]: { joinedAt: serverTimestamp() } },
        { merge: true },
      );

      await connect(stream);
      start(stream);
      setJoined(true);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : "Could not access camera/microphone");
    }
  };

  const leave = async () => {
    await stopAndUpload();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    setJoined(false);
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-500">You ({role})</span>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="aspect-video w-full rounded-lg bg-black"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-500">
            {role === "host" ? "Guest" : "Host"}
          </span>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="aspect-video w-full rounded-lg bg-black"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {!joined ? (
          <button
            onClick={join}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Join & start recording
          </button>
        ) : (
          <button
            onClick={leave}
            className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700"
          >
            End & upload recording
          </button>
        )}

        <span className="text-sm text-gray-500">
          Call: {connectionState} · Recording: {recordingStatus}
        </span>
      </div>

      {mediaError && <p className="text-sm text-red-600">{mediaError}</p>}
      {recordingError && <p className="text-sm text-red-600">{recordingError}</p>}
    </div>
  );
}
