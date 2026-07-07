"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { Mic, MicOff } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  getBestUserMedia,
  getVideoResolutionLabel,
  listMediaDevices,
  friendlyMediaError,
  type CaptureSettings,
  type MediaDeviceChoice,
} from "@/lib/media";
import { warmIceServers } from "@/lib/rtcConfig";
import type { ParticipantRole } from "@/hooks/useWebRTCMesh";

const ROLE_LABEL: Record<ParticipantRole, string> = {
  host: "Host",
  guest: "Guest",
  producer: "Producer",
};

// Live input-level bar driven by an AnalyserNode, so people can see their
// mic is actually picking them up before they join.
function MicMeter({ stream }: { stream: MediaStream | null }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let frame: number;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      setLevel(Math.min(1, avg / 128));
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      ctx.close();
    };
  }, [stream]);

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
        style={{ width: `${Math.round(level * 100)}%` }}
      />
    </div>
  );
}

type Props = {
  sessionId: string;
  role: ParticipantRole;
  initialName: string;
  onJoin: (stream: MediaStream, displayName: string, startMuted: boolean) => void;
};

export default function Lobby({ sessionId, role, initialName, onJoin }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const settingsRef = useRef<CaptureSettings>({});
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [settings, setSettings] = useState<CaptureSettings | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  // Captured once per mount — "you're early" doesn't need a live clock.
  const [now] = useState(() => Date.now());
  const [name, setName] = useState(initialName);
  const [cameras, setCameras] = useState<MediaDeviceChoice[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceChoice[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const micMutedRef = useRef(false);

  const acquire = useCallback(async (videoDeviceId?: string, audioDeviceId?: string) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const next = await getBestUserMedia(videoDeviceId, audioDeviceId, settingsRef.current);
      setError(null);
      // A fresh getUserMedia stream always starts enabled — reapply any mute
      // the guest already chose (e.g. after switching microphones).
      next.getAudioTracks().forEach((t) => {
        t.enabled = !micMutedRef.current;
      });
      streamRef.current = next;
      setStream(next);
      setResolution(
        settingsRef.current.audioOnly ? "Audio only" : getVideoResolutionLabel(next),
      );

      const devices = await listMediaDevices();
      setCameras(devices.cameras);
      setMicrophones(devices.microphones);
      setCameraId(next.getVideoTracks()[0]?.getSettings().deviceId ?? "");
      setMicId(next.getAudioTracks()[0]?.getSettings().deviceId ?? "");
    } catch (err) {
      setStream(null);
      setError(friendlyMediaError(err));
    }
  }, []);

  const toggleMic = () => {
    const next = !micMuted;
    setMicMuted(next);
    micMutedRef.current = next;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  };

  const joinedRef = useRef(false);

  useEffect(() => {
    // Fetch TURN credentials while the user is still checking devices, so
    // they're cached before the mesh creates its first peer connection.
    void warmIceServers();
    // The host's session-level capture settings (resolution cap, audio-only)
    // must be known before the first getUserMedia call.
    let cancelled = false;
    (async () => {
      let loaded: CaptureSettings = {};
      try {
        const snap = await getDoc(doc(db, "sessions", sessionId));
        const data = snap.data();
        loaded = (data?.settings as CaptureSettings) ?? {};
        if (cancelled) return;
        // Give the guest some context: which session this is, and whether
        // they're early.
        setSessionTitle((data?.title as string) ?? "");
        if (data?.scheduledAt?.toDate) setScheduledAt(data.scheduledAt.toDate());
        setDurationMinutes((data?.durationMinutes as number) ?? null);
      } catch {
        // No settings readable — fall back to defaults.
      }
      if (cancelled) return;
      settingsRef.current = loaded;
      setSettings(loaded);
      acquire();
    })();
    return () => {
      cancelled = true;
      // On join, ownership of the stream transfers to the room — only stop
      // the camera if the user left the lobby without joining.
      if (!joinedRef.current) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
      }
    };
  }, [sessionId, acquire]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const handleJoin = () => {
    if (!stream || !name.trim()) return;
    setJoining(true);
    joinedRef.current = true;
    onJoin(stream, name.trim(), micMuted);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
      <div className="grid w-full max-w-4xl grid-cols-1 items-center gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-neutral-800 bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-contain" />
          {settings?.audioOnly && stream && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Mic aria-hidden="true" className="h-10 w-10 text-white" strokeWidth={1.8} />
              <span className="text-sm text-neutral-400">Audio-only session — no camera will be used</span>
            </div>
          )}
          {resolution && (
            <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium backdrop-blur">
              {resolution}
              <span className="block text-neutral-400">This is how you&rsquo;ll be recorded</span>
            </span>
          )}
          {stream && (
            <button
              onClick={toggleMic}
              title={micMuted ? "Unmute microphone" : "Mute microphone before joining"}
              className={`absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition ${
                micMuted
                  ? "border-red-500/60 bg-red-500/20 text-red-400"
                  : "border-white/20 bg-black/60 text-white hover:border-white/40"
              }`}
            >
              {micMuted ? (
                <MicOff aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
              ) : (
                <Mic aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
              )}
            </button>
          )}
          {micMuted && (
            <span className="absolute bottom-3 left-3 rounded-md bg-red-600/90 px-2 py-1 text-xs font-semibold text-white">
              Joining muted
            </span>
          )}
          {!stream && !error && (
            <span className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
              {settings === null
                ? "Loading session settings…"
                : settings.audioOnly
                  ? "Requesting microphone…"
                  : "Requesting camera…"}
            </span>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-neutral-300">{error}</p>
              <button
                onClick={() => acquire()}
                className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium hover:border-neutral-500"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            {sessionTitle && (
              <p className="text-xs font-medium text-indigo-300">{sessionTitle}</p>
            )}
            <h1 className="text-xl font-semibold">Let&rsquo;s check your devices</h1>
            {scheduledAt && (
              <p className="text-xs text-neutral-500">
                Scheduled for{" "}
                {scheduledAt.toLocaleString(undefined, {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {durationMinutes ? ` · ${durationMinutes} min` : ""}
                {scheduledAt.getTime() - now > 15 * 60_000 && " — you're early, feel free to wait here"}
              </p>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">
              Your name <span className="text-neutral-600">· joining as {ROLE_LABEL[role]}</span>
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500"
            />
          </label>

          <label className={`flex flex-col gap-1.5 ${settings?.audioOnly ? "hidden" : ""}`}>
            <span className="text-xs font-medium text-neutral-500">Camera</span>
            <select
              value={cameraId}
              onChange={(e) => acquire(e.target.value, micId || undefined)}
              disabled={cameras.length === 0}
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Microphone</span>
            <select
              value={micId}
              onChange={(e) => acquire(cameraId || undefined, e.target.value)}
              disabled={microphones.length === 0}
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              {microphones.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
            <MicMeter stream={stream} />
          </label>

          <button
            onClick={handleJoin}
            disabled={!stream || !name.trim() || joining}
            className="mt-2 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {joining
              ? role === "host"
                ? "Joining…"
                : "Asking to join…"
              : role === "host"
                ? "Join studio"
                : "Ask to join"}
          </button>
        </div>
      </div>
    </div>
  );
}
