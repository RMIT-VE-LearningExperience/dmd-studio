"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { Camera, CameraOff, Mic, MicOff, Sparkles } from "lucide-react";
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
import { createBlurredStream, type BlurPipeline } from "@/lib/backgroundBlur";
import type { ParticipantRole } from "@/hooks/useWebRTCMesh";

export type JoinOptions = {
  startMuted: boolean;
  startCamOff: boolean;
  // The untouched camera stream and (if blur is on) the pipeline producing
  // the joined stream — the room needs both to toggle blur mid-call.
  rawStream: MediaStream;
  pipeline: BlurPipeline | null;
  blurOn: boolean;
};

const ROLE_LABEL: Record<ParticipantRole, string> = {
  host: "Host",
  guest: "Guest",
  producer: "Producer",
};

const DEVICE_STORAGE_KEY = "dmd-studio-devices";

type SavedDevices = {
  cameraId?: string;
  micId?: string;
  speakerId?: string;
};

function readSavedDevices(): SavedDevices {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(DEVICE_STORAGE_KEY) ?? "{}") as SavedDevices;
  } catch {
    return {};
  }
}

function saveDevices(devices: SavedDevices) {
  if (typeof window === "undefined") return;
  const current = readSavedDevices();
  window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ ...current, ...devices }));
}

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
  onJoin: (stream: MediaStream, displayName: string, options: JoinOptions) => void | Promise<void>;
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
  const [speakers, setSpeakers] = useState<MediaDeviceChoice[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const micMutedRef = useRef(false);
  const [camOff, setCamOff] = useState(false);
  const camOffRef = useRef(false);
  const [blurOn, setBlurOn] = useState(false);
  const blurOnRef = useRef(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const [blurNote, setBlurNote] = useState<string | null>(null);
  // The untouched camera stream; streamRef points at what's displayed and
  // joined with — the blur pipeline's output when blur is on, else this.
  const rawStreamRef = useRef<MediaStream | null>(null);
  const pipelineRef = useRef<BlurPipeline | null>(null);

  const applySpeaker = useCallback(async (deviceId?: string) => {
    const video = videoRef.current;
    if (!video || !deviceId || !("setSinkId" in video)) return;
    try {
      await (video as HTMLVideoElement & { setSinkId: (sinkId: string) => Promise<void> }).setSinkId(deviceId);
      saveDevices({ speakerId: deviceId });
    } catch {
      // Some browsers/devices reject speaker routing; keep the default output.
    }
  }, []);

  const acquire = useCallback(async (videoDeviceId?: string, audioDeviceId?: string, speakerDeviceId?: string) => {
    // Tear down in order: processing first (its canvas track), then the
    // previous camera itself.
    pipelineRef.current?.disposeKeepSource();
    pipelineRef.current = null;
    rawStreamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const saved = readSavedDevices();
      const raw = await getBestUserMedia(
        videoDeviceId ?? saved.cameraId,
        audioDeviceId ?? saved.micId,
        settingsRef.current,
      );
      setError(null);
      // A fresh getUserMedia stream always starts enabled — reapply any mute
      // the guest already chose (e.g. after switching microphones).
      raw.getAudioTracks().forEach((t) => {
        t.enabled = !micMutedRef.current;
      });
      rawStreamRef.current = raw;

      // Re-apply blur across device switches; fall back to the raw camera
      // if the pipeline can't start on this device.
      let next = raw;
      if (blurOnRef.current && !settingsRef.current.audioOnly) {
        try {
          const pipeline = await createBlurredStream(raw);
          pipelineRef.current = pipeline;
          next = pipeline.stream;
        } catch {
          blurOnRef.current = false;
          setBlurOn(false);
          setBlurNote("Background blur isn't available on this device.");
        }
      }
      next.getVideoTracks().forEach((t) => {
        t.enabled = !camOffRef.current;
      });
      streamRef.current = next;
      setStream(next);
      setResolution(
        settingsRef.current.audioOnly
          ? "Audio only"
          : getVideoResolutionLabel(next) + (blurOnRef.current ? " · blurred" : ""),
      );

      const devices = await listMediaDevices();
      setCameras(devices.cameras);
      setMicrophones(devices.microphones);
      setSpeakers(devices.speakers);
      // Device ids come from the raw camera — a blur pipeline's canvas track
      // has none.
      const nextCameraId = raw.getVideoTracks()[0]?.getSettings().deviceId ?? "";
      const nextMicId = raw.getAudioTracks()[0]?.getSettings().deviceId ?? "";
      const nextSpeakerId = speakerDeviceId ?? saved.speakerId ?? devices.speakers[0]?.deviceId ?? "";
      setCameraId(nextCameraId);
      setMicId(nextMicId);
      setSpeakerId(nextSpeakerId);
      saveDevices({ cameraId: nextCameraId, micId: nextMicId, speakerId: nextSpeakerId });
      void applySpeaker(nextSpeakerId);
    } catch (err) {
      setStream(null);
      setError(friendlyMediaError(err));
    }
  }, [applySpeaker]);

  const toggleMic = () => {
    const next = !micMuted;
    setMicMuted(next);
    micMutedRef.current = next;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  };

  const toggleCam = () => {
    const next = !camOff;
    setCamOff(next);
    camOffRef.current = next;
    streamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
  };

  const toggleBlur = async () => {
    setBlurNote(null);
    if (blurOn) {
      setBlurOn(false);
      blurOnRef.current = false;
      pipelineRef.current?.disposeKeepSource();
      pipelineRef.current = null;
      const raw = rawStreamRef.current;
      if (raw) {
        raw.getVideoTracks().forEach((t) => {
          t.enabled = !camOffRef.current;
        });
        streamRef.current = raw;
        setStream(raw);
        setResolution(getVideoResolutionLabel(raw));
      }
      return;
    }
    const raw = rawStreamRef.current;
    if (!raw || blurBusy) return;
    setBlurBusy(true);
    try {
      const pipeline = await createBlurredStream(raw);
      pipelineRef.current = pipeline;
      pipeline.stream.getVideoTracks().forEach((t) => {
        t.enabled = !camOffRef.current;
      });
      streamRef.current = pipeline.stream;
      setStream(pipeline.stream);
      setResolution(`${getVideoResolutionLabel(pipeline.stream)} · blurred`);
      setBlurOn(true);
      blurOnRef.current = true;
    } catch {
      setBlurNote("Background blur isn't available on this device or browser.");
    } finally {
      setBlurBusy(false);
    }
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
        pipelineRef.current?.disposeKeepSource();
        rawStreamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
      }
    };
  }, [sessionId, acquire]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
    void applySpeaker(speakerId);
  }, [stream, speakerId, applySpeaker]);

  const handleJoin = async () => {
    if (!stream || !name.trim()) return;
    setJoining(true);
    joinedRef.current = true;
    try {
      await warmIceServers();
      await onJoin(stream, name.trim(), {
        startMuted: micMuted,
        startCamOff: camOff,
        rawStream: rawStreamRef.current ?? stream,
        pipeline: pipelineRef.current,
        blurOn,
      });
    } catch (err) {
      joinedRef.current = false;
      setJoining(false);
      setError(err instanceof Error ? err.message : "Could not join the studio. Please try again.");
    }
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
          {stream && camOff && !settings?.audioOnly && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/90">
              <CameraOff aria-hidden="true" className="h-10 w-10 text-neutral-500" strokeWidth={1.6} />
              <span className="text-sm text-neutral-400">Your camera is hidden</span>
            </div>
          )}
          {stream && (
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              {!settings?.audioOnly && (
                <button
                  onClick={toggleBlur}
                  disabled={blurBusy}
                  title={
                    blurOn
                      ? "Turn background blur off"
                      : "Blur your background (records at up to 720p)"
                  }
                  className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition disabled:opacity-60 ${
                    blurOn
                      ? "border-indigo-400/70 bg-indigo-500/25 text-indigo-300"
                      : "border-white/20 bg-black/60 text-white hover:border-white/40"
                  }`}
                >
                  <Sparkles
                    aria-hidden="true"
                    className={`h-4 w-4 ${blurBusy ? "animate-pulse" : ""}`}
                    strokeWidth={1.8}
                  />
                </button>
              )}
              {!settings?.audioOnly && (
                <button
                  onClick={toggleCam}
                  title={camOff ? "Show your camera" : "Hide your camera before joining"}
                  className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition ${
                    camOff
                      ? "border-red-500/60 bg-red-500/20 text-red-400"
                      : "border-white/20 bg-black/60 text-white hover:border-white/40"
                  }`}
                >
                  {camOff ? (
                    <CameraOff aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                  ) : (
                    <Camera aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                  )}
                </button>
              )}
              <button
                onClick={toggleMic}
                title={micMuted ? "Unmute microphone" : "Mute microphone before joining"}
                className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition ${
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
            </div>
          )}
          {(micMuted || camOff) && (
            <span className="absolute bottom-3 left-3 rounded-md bg-red-600/90 px-2 py-1 text-xs font-semibold text-white">
              {micMuted && camOff ? "Joining muted, camera hidden" : micMuted ? "Joining muted" : "Joining with camera hidden"}
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
                onClick={() => acquire(cameraId || undefined, micId || undefined, speakerId || undefined)}
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
              onChange={(e) => acquire(e.target.value, micId || undefined, speakerId || undefined)}
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
              onChange={(e) => acquire(cameraId || undefined, e.target.value, speakerId || undefined)}
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

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Speaker</span>
            <select
              value={speakerId}
              onChange={(e) => {
                setSpeakerId(e.target.value);
                void applySpeaker(e.target.value);
              }}
              disabled={
                speakers.length === 0 ||
                typeof HTMLMediaElement === "undefined" ||
                !("setSinkId" in HTMLMediaElement.prototype)
              }
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              {speakers.length === 0 ? (
                <option value="">Default speaker</option>
              ) : (
                speakers.map((s) => (
                  <option key={s.deviceId} value={s.deviceId}>
                    {s.label}
                  </option>
                ))
              )}
            </select>
          </label>

          {blurNote && <p className="text-xs text-amber-400">{blurNote}</p>}
          {blurOn && (
            <p className="text-xs text-neutral-500">
              Background blur is on — your video records at up to 720p while blurred.
            </p>
          )}

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
