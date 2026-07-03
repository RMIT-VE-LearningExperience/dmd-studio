"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { doc, onSnapshot, setDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useWebRTCMesh, type ParticipantRole } from "@/hooks/useWebRTCMesh";
import { useLocalRecorder } from "@/hooks/useLocalRecorder";
import { getVideoResolutionLabel } from "@/lib/media";
import { resumePendingUploads, hasPendingUploads } from "@/lib/resumeUploads";
import Lobby from "@/components/Lobby";

// How long the on-screen countdown runs between the host pressing Record
// and recorders actually starting, shared by all participants.
const COUNTDOWN_MS = 5000;

type Props = {
  sessionId: string;
  role: ParticipantRole;
  uid: string;
  displayName: string;
};

type RecordingFlag = {
  active: boolean;
  take: number;
  startedAt: Timestamp | null;
};

const CONNECTION_LABEL: Record<string, string> = {
  new: "Connecting…",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Connection failed",
  closed: "Closed",
};

const ROLE_LABEL: Record<ParticipantRole, string> = {
  host: "Host",
  guest: "Guest",
  producer: "Producer",
};

function InvitePanel({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const links = [
    { label: "Guest", url: `${origin}/session/${sessionId}?role=guest` },
    { label: "Producer", url: `${origin}/session/${sessionId}?role=producer` },
  ];

  const copy = async (label: string, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex items-center gap-2">
      {links.map((link) => (
        <button
          key={link.label}
          onClick={() => copy(link.label, link.url)}
          className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
        >
          {copied === link.label ? "Copied!" : `Copy ${link.label} link`}
        </button>
      ))}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function VideoTile({
  stream,
  muted,
  mirrored,
  label,
  badge,
}: {
  stream: MediaStream | null;
  muted: boolean;
  mirrored?: boolean;
  label: string;
  badge?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-2xl border border-neutral-800 bg-black">
      <video
        ref={videoRef}
        autoPlay
        muted={muted}
        playsInline
        className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""}`}
      />
      <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium backdrop-blur">
        {label}
      </span>
      {badge && (
        <span className="absolute right-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium backdrop-blur">
          {badge}
        </span>
      )}
      {!stream && (
        <span className="absolute inset-0 flex items-center justify-center text-sm text-neutral-600">
          Waiting…
        </span>
      )}
    </div>
  );
}

function ControlButton({
  onClick,
  active,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-11 w-11 items-center justify-center rounded-full border text-lg transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active === false
          ? "border-red-500/60 bg-red-500/20 text-red-400"
          : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500"
      }`}
    >
      {children}
    </button>
  );
}

// Detects uploads a previous visit left unfinished (tab closed mid-take or
// mid-upload) and completes them automatically.
function ResumeUploadsBanner({ sessionId, uid }: { sessionId: string; uid: string }) {
  const [state, setState] = useState<"checking" | "none" | "resuming" | "done" | "error">("checking");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const ranRef = useRef(false);

  const run = async () => {
    setState("resuming");
    try {
      const resumed = await resumePendingUploads(sessionId, uid, (done, total) =>
        setProgress({ done, total }),
      );
      setState(resumed > 0 ? "done" : "none");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      if (await hasPendingUploads(sessionId, uid)) {
        await run();
      } else {
        setState("none");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, uid]);

  // Leaving the site mid-resume would strand the chunks again.
  useEffect(() => {
    if (state !== "resuming") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  if (state === "checking" || state === "none") return null;

  return (
    <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-900/95 px-4 py-2 text-xs font-medium text-neutral-200 shadow-lg backdrop-blur">
      {state === "resuming" && (
        <span>
          Finishing an earlier upload…{" "}
          {progress.total > 0 ? `${progress.done}/${progress.total} chunks` : ""} — keep this tab open
        </span>
      )}
      {state === "done" && <span className="text-emerald-400">Earlier recording upload completed ✓</span>}
      {state === "error" && (
        <span className="text-red-400">
          Couldn&rsquo;t finish an earlier upload.{" "}
          <button onClick={run} className="underline">
            Retry
          </button>
        </span>
      )}
    </div>
  );
}

export default function RecordingRoom({ sessionId, role, uid, displayName }: Props) {
  const localStreamRef = useRef<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [resolutionLabel, setResolutionLabel] = useState<string | null>(null);
  const [name, setName] = useState(displayName);
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [recordingFlag, setRecordingFlag] = useState<RecordingFlag | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const startedTakeRef = useRef(0);

  const isRecordingParticipant = role !== "producer";
  const { peers, join, leave } = useWebRTCMesh(sessionId, uid, role);
  const {
    status: recordingStatus,
    error: recordingError,
    progress,
    start,
    stopAndUpload,
  } = useLocalRecorder(sessionId, uid);

  // The session doc's `recording` field is the single source of truth for
  // whether a take is running — the host flips it and every recording
  // participant's local recorder follows.
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "sessions", sessionId), (snap) => {
      // "estimate" fills in pending serverTimestamps locally so the host's
      // own countdown starts ticking immediately, before the server ack.
      const data = snap.data({ serverTimestamps: "estimate" });
      setRecordingFlag((data?.recording as RecordingFlag) ?? null);
    });
    return unsub;
  }, [sessionId]);

  useEffect(() => {
    if (!joined || !isRecordingParticipant) return;
    const stream = localStreamRef.current;
    // Recorders only start once the shared countdown (startedAt + COUNTDOWN_MS)
    // has elapsed, and never while the previous take is still "finishing" —
    // the effect re-runs on ticker and status changes, so a queued take
    // starts as soon as both conditions clear.
    const target = recordingFlag?.startedAt ? recordingFlag.startedAt.toMillis() + COUNTDOWN_MS : null;
    if (
      recordingFlag?.active &&
      recordingFlag.take > startedTakeRef.current &&
      stream &&
      target !== null &&
      now >= target &&
      recordingStatus !== "finishing"
    ) {
      startedTakeRef.current = recordingFlag.take;
      start(stream, recordingFlag.take, { displayName: name, role });
    } else if (recordingFlag && !recordingFlag.active && recordingStatus === "recording") {
      stopAndUpload();
    }
  }, [recordingFlag, joined, isRecordingParticipant, recordingStatus, start, stopAndUpload, name, role, now]);

  // Ticker driving both the countdown overlay and the REC timer — everything
  // is derived at render from the shared startedAt timestamp, so every
  // participant's clock reads the same.
  useEffect(() => {
    if (!recordingFlag?.active) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [recordingFlag?.active]);

  const recordStartMs =
    recordingFlag?.active && recordingFlag.startedAt
      ? recordingFlag.startedAt.toMillis() + COUNTDOWN_MS
      : null;
  const countdownSeconds = recordStartMs !== null ? Math.ceil((recordStartMs - now) / 1000) : 0;
  const inCountdown = recordStartMs !== null && countdownSeconds > 0;
  const elapsed = recordStartMs !== null ? Math.max(0, now - recordStartMs) : 0;

  // A closed tab mid-recording OR mid-upload means silently lost footage —
  // make the browser ask first in both phases.
  useEffect(() => {
    if (recordingStatus !== "recording" && recordingStatus !== "finishing") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recordingStatus]);

  const handleJoin = async (stream: MediaStream, chosenName: string) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
    setResolutionLabel(getVideoResolutionLabel(stream));
    setName(chosenName);
    await join(stream, chosenName);
    setJoined(true);
  };

  const toggleRecording = async () => {
    const sessionRef = doc(db, "sessions", sessionId);
    if (recordingFlag?.active) {
      await setDoc(sessionRef, { recording: { ...recordingFlag, active: false } }, { merge: true });
    } else {
      await setDoc(
        sessionRef,
        {
          recording: {
            active: true,
            take: (recordingFlag?.take ?? 0) + 1,
            startedAt: serverTimestamp(),
          },
        },
        { merge: true },
      );
    }
  };

  const toggleMic = () => {
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !micOn;
    });
    setMicOn(!micOn);
  };

  const toggleCam = () => {
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !camOn;
    });
    setCamOn(!camOn);
  };

  const leaveSession = async () => {
    if (recordingStatus === "recording") {
      const sure = window.confirm(
        "Recording is in progress. Your recording will stop and keep uploading in the background — keep this tab open until it finishes. Leave the studio?",
      );
      if (!sure) return;
      // Host leaving ends the take for everyone; a guest leaving only ends theirs.
      if (role === "host" && recordingFlag?.active) {
        await setDoc(
          doc(db, "sessions", sessionId),
          { recording: { ...recordingFlag, active: false } },
          { merge: true },
        );
      }
      // Deliberately not awaited: the recorder stops immediately (inside the
      // synchronous part of stopAndUpload), but the upload drains in the
      // background while the user returns to the lobby.
      void stopAndUpload();
    }
    await leave();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    setJoined(false);
  };

  const uploadPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100))
      : 0;

  if (!joined) {
    return (
      <>
        <ResumeUploadsBanner sessionId={sessionId} uid={uid} />
        {recordingStatus === "finishing" && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-900/95 px-4 py-2 text-xs font-medium text-neutral-200 shadow-lg backdrop-blur">
            Uploading your recording… {uploadPercent}% — keep this tab open
          </div>
        )}
        {recordingStatus === "uploaded" && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-900/95 px-4 py-2 text-xs font-medium text-emerald-400 shadow-lg backdrop-blur">
            Recording uploaded ✓
          </div>
        )}
        <Lobby role={role} initialName={displayName} onJoin={handleJoin} />
      </>
    );
  }

  const gridColsClass = peers.length + 1 > 2 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2";
  const isRecordingActive = recordingFlag?.active ?? false;

  return (
    <div className="flex min-h-screen flex-col gap-6 bg-neutral-950 p-6 text-neutral-100">
      <ResumeUploadsBanner sessionId={sessionId} uid={uid} />
      {inCountdown && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <span className="text-8xl font-bold tabular-nums text-white">{countdownSeconds}</span>
          <span className="text-sm text-neutral-300">Recording is about to start</span>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Projects
          </Link>
          <span className="text-sm font-medium text-neutral-400">
            DMD Studio · <span className="text-neutral-200">{ROLE_LABEL[role]}</span>
          </span>
          {isRecordingActive && (
            <span className="flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-xs font-semibold">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              {inCountdown ? `Starting in ${countdownSeconds}` : `REC ${formatElapsed(elapsed)}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {role === "host" && <InvitePanel sessionId={sessionId} />}
          {role === "host" && (
            <Link
              href={`/session/${sessionId}/recordings`}
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Recordings
            </Link>
          )}
          <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-400">
            {peers.length + 1} in the studio
          </span>
        </div>
      </header>

      <div className={`grid flex-1 grid-cols-1 gap-4 ${gridColsClass}`}>
        <VideoTile
          stream={localStream}
          muted
          mirrored
          label={`${name} (You) · ${ROLE_LABEL[role]}`}
          badge={[resolutionLabel, !micOn ? "Muted" : null].filter(Boolean).join(" · ") || undefined}
        />

        {peers.map((peer) => (
          <VideoTile
            key={peer.uid}
            stream={peer.stream}
            muted={false}
            label={`${peer.displayName} · ${ROLE_LABEL[peer.role]}`}
            badge={CONNECTION_LABEL[peer.connectionState] ?? peer.connectionState}
          />
        ))}

        {peers.length === 0 && <VideoTile stream={null} muted label="Waiting for others to join…" />}
      </div>

      <footer className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <ControlButton onClick={toggleMic} active={micOn} title={micOn ? "Mute microphone" : "Unmute microphone"}>
            {micOn ? "🎙" : "🔇"}
          </ControlButton>
          <ControlButton onClick={toggleCam} active={camOn} title={camOn ? "Turn camera off" : "Turn camera on"}>
            {camOn ? "📷" : "🚫"}
          </ControlButton>

          {role === "host" && (
            <button
              onClick={toggleRecording}
              disabled={recordingStatus === "finishing"}
              className={`flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
                isRecordingActive ? "bg-neutral-700 hover:bg-neutral-600" : "bg-red-600 hover:bg-red-500"
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${isRecordingActive ? "bg-red-500" : "bg-white"}`} />
              {isRecordingActive ? (inCountdown ? "Cancel" : "Stop recording") : "Record"}
            </button>
          )}

          <button
            onClick={leaveSession}
            disabled={recordingStatus === "finishing"}
            className="flex h-11 items-center rounded-full border border-neutral-700 px-5 text-sm font-semibold text-neutral-200 transition hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {recordingStatus === "finishing" ? "Finishing upload…" : "Leave"}
          </button>
        </div>

        {isRecordingParticipant && recordingStatus === "recording" && progress.totalBytes > 0 && (
          <p className="text-xs text-neutral-500">
            Uploaded {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)} recorded
          </p>
        )}

        {recordingStatus === "finishing" && (
          <div className="w-full max-w-xs">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
            <p className="mt-1.5 text-center text-xs text-neutral-500">Uploading… {uploadPercent}%</p>
          </div>
        )}

        {recordingStatus === "uploaded" && (
          <p className="text-xs font-medium text-emerald-400">Recording uploaded ✓</p>
        )}

        {isRecordingParticipant && recordingError && <p className="text-xs text-red-400">{recordingError}</p>}
      </footer>
    </div>
  );
}
