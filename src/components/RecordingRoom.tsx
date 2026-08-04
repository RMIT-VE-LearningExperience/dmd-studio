"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  MessageCircle,
  Mic,
  MicOff,
  Monitor,
  ScrollText,
  Settings,
  Video,
  VideoOff,
} from "lucide-react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useWebRTCMesh, type ParticipantRole, type RemotePeer } from "@/hooks/useWebRTCMesh";
import { useLocalRecorder } from "@/hooks/useLocalRecorder";
import {
  getBestUserMedia,
  getVideoResolutionLabel,
  listMediaDevices,
  type CaptureSettings,
  type MediaDeviceChoice,
} from "@/lib/media";
import { resumePendingUploads, hasPendingUploads } from "@/lib/resumeUploads";
import Lobby from "@/components/Lobby";
import Teleprompter from "@/components/Teleprompter";

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

function canSelectSpeakerOutput() {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

// Tile badge: surfaces the mesh's automatic retries instead of an
// indistinguishable eternal "Connecting…", and gives a next step once the
// retry budget is spent.
function peerBadge(peer: RemotePeer) {
  if (peer.retriesExhausted) return "Connection failed — ask them to refresh their page";
  if (peer.retryAttempt && peer.connectionState !== "connected") {
    return `Reconnecting… (attempt ${peer.retryAttempt}/3)`;
  }
  return CONNECTION_LABEL[peer.connectionState] ?? peer.connectionState;
}

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

// Per-tile speaking detector: RMS of the tile's audio with a short hold so
// the green highlight doesn't flicker off between words. A muted mic
// (track.enabled = false) produces silence, so muted tiles never light up.
function useIsSpeaking(stream: MediaStream | null, enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!enabled || !stream || stream.getAudioTracks().length === 0) return;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    void ctx.resume().catch(() => {});

    const THRESHOLD = 0.015; // RMS above this counts as speech
    const HOLD_MS = 650; // keep the highlight through short pauses
    let lastAbove = 0;
    let current = false;
    let raf: number;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > THRESHOLD) lastAbove = now;
      const next = now - lastAbove < HOLD_MS;
      if (next !== current) {
        current = next;
        setSpeaking(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close().catch(() => {});
      setSpeaking(false);
    };
  }, [stream, enabled]);

  return speaking && enabled;
}

function VideoTile({
  stream,
  muted,
  mirrored,
  label,
  badge,
  actions,
  highlightSpeaking,
  speakerId,
}: {
  stream: MediaStream | null;
  muted: boolean;
  mirrored?: boolean;
  label: string;
  badge?: string;
  actions?: React.ReactNode;
  highlightSpeaking?: boolean;
  speakerId?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const speaking = useIsSpeaking(stream, !!highlightSpeaking);
  const reconnecting = !!badge?.startsWith("Reconnecting");
  const failed = !!badge?.startsWith("Connection failed");

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || muted || !speakerId || !("setSinkId" in video)) return;
    void (video as HTMLVideoElement & { setSinkId: (sinkId: string) => Promise<void> })
      .setSinkId(speakerId)
      .catch(() => {});
  }, [speakerId, muted]);

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-2xl border bg-black transition-shadow duration-150 ${
        speaking
          ? "border-emerald-400 shadow-[0_0_0_4px_rgba(16,185,129,0.72),0_0_28px_rgba(16,185,129,0.3)]"
          : failed
            ? "border-red-500/70"
            : reconnecting
              ? "border-amber-400/80 shadow-[0_0_0_3px_rgba(251,191,36,0.35)]"
              : "border-neutral-800"
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        muted={muted}
        playsInline
        className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""}`}
      />
      <span
        className={`absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs font-medium backdrop-blur ${
          speaking ? "text-emerald-300" : ""
        }`}
      >
        {speaking && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
        {label}
      </span>
      {badge && (
        <span
          className={`absolute right-3 top-3 rounded-md px-2 py-1 text-xs font-medium backdrop-blur ${
            failed
              ? "bg-red-950/85 text-red-200"
              : reconnecting
                ? "bg-amber-950/85 text-amber-200"
                : "bg-black/60 text-neutral-200"
          }`}
        >
          {badge}
        </span>
      )}
      {(reconnecting || failed) && (
        <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-xl bg-black/75 px-4 py-3 text-center backdrop-blur">
          <p className={`text-sm font-semibold ${failed ? "text-red-200" : "text-amber-200"}`}>
            {failed ? "Connection failed" : "Reconnecting…"}
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            {failed ? "Ask them to refresh and rejoin." : "Rebuilding the studio connection."}
          </p>
        </div>
      )}
      {actions && <div className="absolute left-3 top-3 flex gap-1.5">{actions}</div>}
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
  label,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`flex h-12 min-w-20 flex-col items-center justify-center gap-1 rounded-2xl border px-3 transition disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:min-w-24 ${
        active === true
          ? "border-neutral-500 bg-neutral-800 text-white"
          : "border-neutral-700 bg-neutral-950 text-white hover:border-neutral-500 hover:bg-neutral-900"
      }`}
    >
      {children}
      <span className="text-[10px] font-medium leading-none text-neutral-400">{label}</span>
    </button>
  );
}

type UploadInfo = {
  state: "recording" | "finishing" | "uploaded" | "error";
  take: number;
  uploadedBytes?: number;
  totalBytes?: number;
};

type ParticipantDoc = {
  uid: string;
  role: ParticipantRole;
  displayName: string;
  active?: boolean;
  admission?: "pending" | "admitted" | "denied";
  upload?: UploadInfo;
  screenUpload?: UploadInfo;
  muted?: boolean;
};

// Live view of every participant doc, for the host/producer control surfaces:
// admission requests and the per-track upload panel.
function useParticipantDocs(sessionId: string, enabled: boolean) {
  const [participants, setParticipants] = useState<ParticipantDoc[]>([]);
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(collection(db, "sessions", sessionId, "participants"), (snap) => {
      setParticipants(
        snap.docs.map((d) => ({ ...(d.data() as Omit<ParticipantDoc, "uid">), uid: d.id })),
      );
    });
  }, [sessionId, enabled]);
  return participants;
}

function AdmissionRequests({
  sessionId,
  requests,
}: {
  sessionId: string;
  requests: ParticipantDoc[];
}) {
  const decide = (uid: string, admission: "admitted" | "denied") => {
    void updateDoc(doc(db, "sessions", sessionId, "participants", uid), { admission }).catch(
      () => {},
    );
  };

  if (requests.length === 0) return null;

  return (
    <div className="fixed left-1/2 top-16 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 flex-col gap-2 sm:w-auto">
      {requests.map((p) => (
        <div
          key={p.uid}
          className="flex flex-wrap items-center justify-end gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 px-4 py-3 shadow-lg backdrop-blur"
        >
          <span className="text-sm">
            <span className="font-semibold">{p.displayName || "Someone"}</span>{" "}
            <span className="text-neutral-400">wants to join as {ROLE_LABEL[p.role] ?? p.role}</span>
          </span>
          <button
            onClick={() => decide(p.uid, "admitted")}
            className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Admit
          </button>
          <button
            onClick={() => decide(p.uid, "denied")}
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-red-500 hover:text-red-400"
          >
            Deny
          </button>
        </div>
      ))}
    </div>
  );
}

function uploadLabel(u: UploadInfo) {
  switch (u.state) {
    case "recording":
      return `Recording · ${formatBytes(u.uploadedBytes ?? 0)} uploaded`;
    case "finishing": {
      const pct = u.totalBytes
        ? Math.min(100, Math.round(((u.uploadedBytes ?? 0) / u.totalBytes) * 100))
        : 0;
      return `Uploading… ${pct}%`;
    }
    case "uploaded":
      return "Uploaded ✓";
    case "error":
      return "Upload failed";
  }
}

type UploadRow = { key: string; name: string; upload: UploadInfo };

// Host/producer answer to "did everyone's track actually land?" — stays
// visible even after a guest's tile disappears because they left the call.
function UploadStatusPanel({ rows }: { rows: UploadRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div className="fixed bottom-32 right-4 z-40 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/95 p-3 shadow-lg backdrop-blur sm:bottom-4">
      <p className="text-xs font-semibold text-neutral-400">Track uploads</p>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-neutral-300">{row.name}</span>
          <span
            className={
              row.upload.state === "uploaded"
                ? "text-emerald-400"
                : row.upload.state === "error"
                  ? "text-red-400"
                  : "text-neutral-400"
            }
          >
            {uploadLabel(row.upload)}
          </span>
        </div>
      ))}
    </div>
  );
}

type ChatMessage = {
  id: string;
  uid: string;
  displayName: string;
  text: string;
  sentAt: Timestamp | null;
};

// `enabled` must stay false until this client is actually allowed to read
// chat (host, or admitted+joined) — a listener that starts earlier gets
// permission-denied and Firestore terminates it permanently, leaving chat
// dead for the whole session even after admission.
function useChatMessages(sessionId: string, enabled: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const q = query(
      collection(db, "sessions", sessionId, "chat"),
      orderBy("sentAt", "asc"),
      limitToLast(200),
    );
    return onSnapshot(q, (snap) => {
      setMessages(
        snap.docs.map((d) => {
          // "estimate" keeps our own just-sent message ordered correctly
          // before the server timestamp lands.
          const data = d.data({ serverTimestamps: "estimate" });
          return {
            id: d.id,
            uid: (data.uid as string) ?? "",
            displayName: (data.displayName as string) ?? "",
            text: (data.text as string) ?? "",
            sentAt: (data.sentAt as Timestamp) ?? null,
          };
        }),
      );
    });
  }, [sessionId, enabled]);
  return messages;
}

function formatChatTime(ts: Timestamp | null) {
  if (!ts) return "";
  return ts.toDate().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function ChatPanel({
  messages,
  selfUid,
  onSend,
  onClose,
}: {
  messages: ChatMessage[];
  selfUid: string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="fixed bottom-24 left-4 right-4 z-40 flex h-96 flex-col rounded-2xl border border-neutral-700 bg-neutral-900/95 shadow-xl backdrop-blur sm:left-auto sm:w-80">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <span className="text-xs font-semibold text-neutral-300">Chat</span>
        <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
          Close
        </button>
      </div>
      <div ref={listRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-xs text-neutral-600">No messages yet — say hi!</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5">
            <span className="text-[11px] text-neutral-500">
              <span className={m.uid === selfUid ? "text-indigo-400" : "text-neutral-400"}>
                {m.uid === selfUid ? "You" : m.displayName || "Someone"}
              </span>{" "}
              {formatChatTime(m.sentAt)}
            </span>
            <p className="whitespace-pre-wrap break-words text-xs text-neutral-200">{m.text}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-neutral-800 p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message everyone…"
          className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none transition focus:border-indigo-500"
        />
        <button
          onClick={send}
          disabled={!draft.trim()}
          className="rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
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
  const [admission, setAdmission] = useState<"pending" | "denied" | null>(null);
  const [removed, setRemoved] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: "info" | "success" | "error" }[]>([]);
  const toastIdRef = useRef(0);
  const [leftAfterRecording, setLeftAfterRecording] = useState(false);
  const [sessionSettings, setSessionSettings] = useState<CaptureSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceChoice[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceChoice[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceChoice[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [switchingDevice, setSwitchingDevice] = useState(false);
  const [prompterOpen, setPrompterOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeenCount, setChatSeenCount] = useState(0);
  const startedTakeRef = useRef(0);

  const isRecordingParticipant = role !== "producer";
  const canModerate = role === "host";
  const canRename = role === "host" || role === "producer";
  // Producers only gain list access once admitted — subscribing earlier
  // permanently kills the listener (see useChatMessages).
  const participantDocs = useParticipantDocs(sessionId, role === "host" || (role === "producer" && joined));
  const pendingRequests = participantDocs.filter((p) => p.admission === "pending");

  // A knock is easy to miss if the host is on another tab — chime once per
  // new request and flash the tab title while anyone is waiting.
  const prevKnockCountRef = useRef(0);
  useEffect(() => {
    if (!canModerate) return;
    const count = pendingRequests.length;
    if (count > prevKnockCountRef.current) {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.6);
        osc.onended = () => void ctx.close();
      } catch {
        // Autoplay policy blocked it — the title flash still works.
      }
    }
    prevKnockCountRef.current = count;
  }, [canModerate, pendingRequests.length]);

  useEffect(() => {
    if (!canModerate || pendingRequests.length === 0) return;
    const original = document.title;
    let flip = false;
    const interval = setInterval(() => {
      document.title = flip ? original : `🔔 ${pendingRequests.length} waiting — ${original}`;
      flip = !flip;
    }, 1200);
    return () => {
      clearInterval(interval);
      document.title = original;
    };
  }, [canModerate, pendingRequests.length]);

  const uploadRows = participantDocs.flatMap((p) => {
    if (p.uid === uid) return [];
    const who = p.displayName || p.uid.slice(0, 6);
    const rows: UploadRow[] = [];
    if (p.upload) rows.push({ key: p.uid, name: who, upload: p.upload });
    if (p.screenUpload) rows.push({ key: `${p.uid}-screen`, name: `${who} (screen)`, upload: p.screenUpload });
    return rows;
  });

  const chatMessages = useChatMessages(sessionId, role === "host" || joined);
  // While the panel is open every message counts as seen — synced during
  // render (React's "adjust state when inputs change" pattern) so the badge
  // only ever tracks messages that land while the panel is closed.
  if (chatOpen && chatSeenCount !== chatMessages.length) {
    setChatSeenCount(chatMessages.length);
  }
  const chatUnread = chatOpen ? 0 : Math.max(0, chatMessages.length - chatSeenCount);

  const sendChat = (text: string) => {
    void addDoc(collection(db, "sessions", sessionId, "chat"), {
      uid,
      displayName: name,
      role,
      text,
      sentAt: serverTimestamp(),
    }).catch(() => {});
  };

  const pushToast = useCallback((text: string, tone: "info" | "success" | "error" = "info") => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const {
    peers,
    screenPeers,
    localScreenStream,
    join,
    leave,
    replaceLocalStream,
    startScreenShare,
    stopScreenShare,
  } = useWebRTCMesh(sessionId, uid, role);

  // Join/leave announcements — derived by diffing the mesh's peer list, so
  // they fire exactly when someone appears in / drops from the room.
  const prevPeerNamesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!joined) {
      prevPeerNamesRef.current = {};
      return;
    }
    const current: Record<string, string> = {};
    peers.forEach((p) => {
      current[p.uid] = p.displayName || "Someone";
    });
    const prev = prevPeerNamesRef.current;
    Object.entries(current).forEach(([peerUid, peerName]) => {
      if (!(peerUid in prev)) pushToast(`${peerName} joined the studio`);
    });
    Object.entries(prev).forEach(([peerUid, peerName]) => {
      if (!(peerUid in current)) pushToast(`${peerName} left the studio`);
    });
    prevPeerNamesRef.current = current;
  }, [peers, joined, pushToast]);
  const {
    status: recordingStatus,
    error: recordingError,
    progress,
    start,
    stopAndUpload,
  } = useLocalRecorder(sessionId, uid);
  const {
    status: screenRecStatus,
    start: startScreenRec,
    stopAndUpload: stopScreenRec,
  } = useLocalRecorder(sessionId, uid, "screen");
  const screenStartedTakeRef = useRef(0);

  // Upload outcome toasts — status transitions, not renders, drive these.
  const prevRecStatusRef = useRef(recordingStatus);
  useEffect(() => {
    const prev = prevRecStatusRef.current;
    prevRecStatusRef.current = recordingStatus;
    if (prev === recordingStatus) return;
    if (recordingStatus === "uploaded") {
      pushToast("Your recording finished uploading ✓", "success");
    } else if (recordingStatus === "error") {
      pushToast("Your recording upload hit a problem — rejoin to resume it.", "error");
    }
  }, [recordingStatus, pushToast]);

  // The session doc's `recording` field is the single source of truth for
  // whether a take is running — the host flips it and every recording
  // participant's local recorder follows.
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "sessions", sessionId), (snap) => {
      // "estimate" fills in pending serverTimestamps locally so the host's
      // own countdown starts ticking immediately, before the server ack.
      const data = snap.data({ serverTimestamps: "estimate" });
      setRecordingFlag((data?.recording as RecordingFlag) ?? null);
      setSessionSettings((data?.settings as CaptureSettings) ?? {});
    });
    return unsub;
  }, [sessionId]);

  // Heartbeat while the host is in the studio, so the dashboard's LIVE badge
  // can expire if the host's tab dies without a clean Leave.
  useEffect(() => {
    if (!joined || role !== "host") return;
    const beat = setInterval(() => {
      void setDoc(
        doc(db, "sessions", sessionId),
        { lastLiveAt: serverTimestamp() },
        { merge: true },
      ).catch(() => {});
    }, 60_000);
    return () => clearInterval(beat);
  }, [joined, role, sessionId]);

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

  // The screen recorder follows the same take clock as the camera, but only
  // while a screen is actually shared — sharing mid-take starts a screen
  // track from that moment (startedAtMs keeps it aligned in the episode),
  // and stopping the share mid-take finishes just the screen upload.
  useEffect(() => {
    if (!joined || !isRecordingParticipant) return;
    const target = recordingFlag?.startedAt ? recordingFlag.startedAt.toMillis() + COUNTDOWN_MS : null;
    const takeRunning = !!recordingFlag?.active && target !== null && now >= target;
    if (
      takeRunning &&
      localScreenStream &&
      recordingFlag.take > screenStartedTakeRef.current &&
      screenRecStatus !== "finishing"
    ) {
      screenStartedTakeRef.current = recordingFlag.take;
      startScreenRec(localScreenStream, recordingFlag.take, { displayName: name, role });
    } else if ((!recordingFlag?.active || !localScreenStream) && screenRecStatus === "recording") {
      void stopScreenRec();
    }
  }, [recordingFlag, joined, isRecordingParticipant, localScreenStream, screenRecStatus, startScreenRec, stopScreenRec, name, role, now]);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await listMediaDevices();
      setCameras(devices.cameras);
      setMicrophones(devices.microphones);
      setSpeakers(devices.speakers);
    } catch {
      // Device lists can fail if permissions are revoked mid-call.
    }
  }, []);

  const applySpeaker = useCallback((nextSpeakerId: string) => {
    setSpeakerId(nextSpeakerId);
    saveDevices({ speakerId: nextSpeakerId });
  }, []);

  const switchInputDevice = async (nextCameraId = cameraId, nextMicId = micId) => {
    if (!localStreamRef.current) return;
    setSwitchingDevice(true);
    try {
      const next = await getBestUserMedia(
        nextCameraId || undefined,
        nextMicId || undefined,
        sessionSettings,
      );
      next.getAudioTracks().forEach((track) => {
        track.enabled = micOn;
      });
      next.getVideoTracks().forEach((track) => {
        track.enabled = camOn;
      });
      await replaceLocalStream(next);
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = next;
      setLocalStream(next);
      const resolvedCameraId = next.getVideoTracks()[0]?.getSettings().deviceId ?? "";
      const resolvedMicId = next.getAudioTracks()[0]?.getSettings().deviceId ?? "";
      setCameraId(resolvedCameraId);
      setMicId(resolvedMicId);
      setResolutionLabel(getVideoResolutionLabel(next));
      saveDevices({ cameraId: resolvedCameraId, micId: resolvedMicId });
      void refreshDevices();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not switch devices.", "error");
    } finally {
      setSwitchingDevice(false);
    }
  };

  const toggleScreenShare = async () => {
    if (localScreenStream) {
      if (screenRecStatus === "recording") void stopScreenRec();
      await stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15 } },
        audio: false,
      });
      // The browser's own "Stop sharing" bar bypasses our button.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        void stopScreenRec();
        void stopScreenShare();
      });
      await startScreenShare(stream);
    } catch {
      // User dismissed the screen picker.
    }
  };

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
  // make the browser ask first in both phases (camera or screen track).
  useEffect(() => {
    const busy = (s: string) => s === "recording" || s === "finishing";
    if (!busy(recordingStatus) && !busy(screenRecStatus)) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recordingStatus, screenRecStatus]);

  const handleJoin = async (stream: MediaStream, chosenName: string, startMuted: boolean) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
    setResolutionLabel(getVideoResolutionLabel(stream));
    setName(chosenName);
    const savedDevices = readSavedDevices();
    const resolvedCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    const resolvedMicId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? "";
    setCameraId(resolvedCameraId);
    setMicId(resolvedMicId);
    setSpeakerId(savedDevices.speakerId ?? "");
    saveDevices({ cameraId: resolvedCameraId, micId: resolvedMicId, speakerId: savedDevices.speakerId });
    void refreshDevices();
    // The lobby already applied `enabled = false` to the audio tracks when
    // the guest chose to join muted — mirror that into the room's own toggle
    // state so the mic button/badge reflect it correctly from the first frame.
    setMicOn(!startMuted);
    if (role === "host") {
      await join(stream, chosenName);
      await setDoc(
        doc(db, "sessions", sessionId, "participants", uid),
        { muted: startMuted },
        { merge: true },
      );
      setJoined(true);
      // Drives the "Live" badge on the dashboard.
      void setDoc(
        doc(db, "sessions", sessionId),
        { status: "live", lastLiveAt: serverTimestamp() },
        { merge: true },
      ).catch(() => {});
      return;
    }
    // Guests and producers knock first and wait for the host to let them in.
    // Anyone already admitted this session skips the queue on rejoin, and
    // when the host enabled auto-admit there's no queue at all (rules allow
    // the self-admit only while that setting is on).
    const participantRef = doc(db, "sessions", sessionId, "participants", uid);
    const [existing, sessionSnap] = await Promise.all([
      getDoc(participantRef),
      getDoc(doc(db, "sessions", sessionId)),
    ]);
    if (existing.data()?.admission === "admitted") {
      await join(stream, chosenName);
      await setDoc(participantRef, { muted: startMuted }, { merge: true });
      setJoined(true);
      return;
    }
    const autoAdmit = sessionSnap.data()?.settings?.autoAdmit === true;
    if (autoAdmit && existing.data()?.admission !== "denied") {
      try {
        await setDoc(participantRef, { admission: "admitted" }, { merge: true });
        await join(stream, chosenName);
        await setDoc(participantRef, { muted: startMuted }, { merge: true });
        setJoined(true);
        return;
      } catch {
        // Setting flipped off between read and write — fall through to knock.
      }
    }
    await setDoc(
      participantRef,
      {
        role,
        displayName: chosenName,
        admission: "pending",
        active: false,
        muted: startMuted,
        knockedAt: serverTimestamp(),
      },
      { merge: true },
    );
    setAdmission("pending");
  };

  // While waiting at the door, follow our own participant doc — the host
  // flipping `admission` is what lets us in (or turns us away).
  useEffect(() => {
    if (admission !== "pending") return;
    let handled = false;
    const unsub = onSnapshot(doc(db, "sessions", sessionId, "participants", uid), (snap) => {
      const decision = snap.data()?.admission;
      if (decision === "admitted" && !handled) {
        handled = true;
        const stream = localStreamRef.current;
        if (!stream) return;
        void join(stream, name).then(() => {
          setJoined(true);
          setAdmission(null);
        });
      } else if (decision === "denied") {
        setAdmission("denied");
      }
    });
    return unsub;
  }, [admission, sessionId, uid, join, name]);

  const cancelKnock = () => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setAdmission(null);
    setRemoved(false);
  };

  // Host moderation: request-mute (participant can unmute themselves) and
  // remove (flips admission to denied — the mesh drops them and they can't
  // rejoin without knocking again).
  const requestMute = (peerUid: string) => {
    void updateDoc(doc(db, "sessions", sessionId, "participants", peerUid), {
      muteRequested: serverTimestamp(),
      muted: true,
    }).catch(() => {});
  };

  const removeParticipant = (peerUid: string, peerName: string) => {
    const sure = window.confirm(
      `Remove ${peerName} from the studio? They'll need to be admitted again to rejoin.`,
    );
    if (!sure) return;
    void updateDoc(doc(db, "sessions", sessionId, "participants", peerUid), {
      admission: "denied",
      active: false,
    }).catch(() => {});
  };

  // Host or producer only — rules restrict a producer's write on someone
  // else's participant doc to just this field, so it can't be used to admit,
  // remove, or otherwise moderate.
  const renameParticipant = (peerUid: string, currentName: string) => {
    const next = window.prompt("Rename participant", currentName)?.trim();
    if (!next || next === currentName) return;
    void setDoc(
      doc(db, "sessions", sessionId, "participants", peerUid),
      { displayName: next },
      { merge: true },
    ).catch(() => {
      window.alert("Couldn't rename — try again.");
    });
  };

  // Participant side of moderation: watch our own doc for a mute request or
  // a removal while we're in the room.
  useEffect(() => {
    if (!joined || role === "host") return;
    let removedHandled = false;
    const unsub = onSnapshot(doc(db, "sessions", sessionId, "participants", uid), (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.muteRequested) {
        localStreamRef.current?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        setMicOn(false);
        pushToast("The host muted your microphone — you can unmute yourself anytime.");
        void setDoc(snap.ref, { muteRequested: null, muted: true }, { merge: true }).catch(() => {});
      }
      // Removal forces the same teardown as Leave, minus the confirm.
      if (data.admission === "denied" && !removedHandled) {
        removedHandled = true;
        void stopAndUpload();
        void stopScreenRec();
        void leave();
        localStreamRef.current?.getTracks().forEach((track) => track.stop());
        setRemoved(true);
        setJoined(false);
        setAdmission("denied");
      }
    });
    return unsub;
  }, [joined, role, sessionId, uid, stopAndUpload, stopScreenRec, leave, pushToast]);

  // Everyone the mesh knows about but hasn't finished connecting to —
  // recording now would likely produce a session missing their track.
  const notReadyPeers = peers.filter((p) => p.connectionState !== "connected");

  const toggleRecording = async () => {
    const sessionRef = doc(db, "sessions", sessionId);
    if (!recordingFlag?.active && notReadyPeers.length > 0) {
      const names = notReadyPeers.map((p) => p.displayName || "A guest").join(", ");
      const sure = window.confirm(
        `${names} ${notReadyPeers.length === 1 ? "isn't" : "aren't"} fully connected yet — they may not hear the session or record properly. Start recording anyway?`,
      );
      if (!sure) return;
    }
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
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
    void setDoc(
      doc(db, "sessions", sessionId, "participants", uid),
      { muted: !next },
      { merge: true },
    ).catch(() => {});
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
    if (screenRecStatus === "recording") void stopScreenRec();
    await leave();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    setJoined(false);
    // Guests who recorded something get a clear "you're done" screen rather
    // than being dropped back into the device check.
    if (isRecordingParticipant && role !== "host" && recordingStatus !== "idle") {
      setLeftAfterRecording(true);
    }
    if (role === "host") {
      void setDoc(doc(db, "sessions", sessionId), { status: "ended" }, { merge: true }).catch(
        () => {},
      );
    }
  };

  const uploadPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100))
      : 0;

  if (admission === "pending") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-neutral-950 p-6 text-neutral-100">
        <div className="w-full max-w-sm">
          <VideoTile stream={localStream} muted mirrored label={`${name} (You)`} />
        </div>
        <div className="flex flex-col items-center gap-1">
          <p className="text-sm font-medium">Asking to join…</p>
          <p className="text-xs text-neutral-500">Waiting for the host to let you in.</p>
        </div>
        <button
          onClick={cancelKnock}
          className="text-xs text-neutral-500 underline hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (admission === "denied") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-neutral-100">
        <p className="text-sm text-neutral-300">
          {removed
            ? "The host removed you from this studio."
            : "The host didn’t let you into this studio."}
        </p>
        <button
          onClick={cancelKnock}
          className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
        >
          Back to device check
        </button>
      </div>
    );
  }

  if (!joined && leftAfterRecording) {
    const stillUploading = recordingStatus === "finishing" || screenRecStatus === "finishing";
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-neutral-950 p-6 text-center text-neutral-100">
        {stillUploading ? (
          <>
            <p className="text-lg font-semibold">Finishing your upload…</p>
            <div className="w-full max-w-xs">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                {uploadPercent}% — keep this tab open just a little longer
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="text-4xl">🎉</p>
            <div className="flex flex-col gap-1">
              <p className="text-lg font-semibold">You&rsquo;re all done — thank you!</p>
              <p className="text-sm text-neutral-400">
                Your recording {recordingStatus === "error" ? "had an upload problem — please rejoin so it can finish." : "is uploaded. It's now safe to close this tab."}
              </p>
            </div>
          </>
        )}
        <button
          onClick={() => setLeftAfterRecording(false)}
          className="text-xs text-neutral-500 underline hover:text-neutral-300"
        >
          Rejoin the studio
        </button>
      </div>
    );
  }

  if (!joined) {
    return (
      <>
        <ResumeUploadsBanner sessionId={sessionId} uid={uid} />
        {canModerate && <AdmissionRequests sessionId={sessionId} requests={pendingRequests} />}
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
        <Lobby sessionId={sessionId} role={role} initialName={displayName} onJoin={handleJoin} />
      </>
    );
  }

  const tileCount = 1 + peers.length + screenPeers.length + (localScreenStream ? 1 : 0);
  const gridColsClass = tileCount > 2 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2";
  const isRecordingActive = recordingFlag?.active ?? false;
  const callTiles = (
    <>
      <VideoTile
        stream={localStream}
        muted
        mirrored
        highlightSpeaking
        speakerId={speakerId}
        label={`${name} (You) · ${ROLE_LABEL[role]}`}
        badge={[resolutionLabel, !micOn ? "Muted" : null].filter(Boolean).join(" · ") || undefined}
      />

      {localScreenStream && (
        <VideoTile
          stream={localScreenStream}
          muted
          speakerId={speakerId}
          label={`${name} (Your screen)`}
          badge={screenRecStatus === "recording" ? "REC" : undefined}
        />
      )}

      {peers.map((peer) => (
        <VideoTile
          key={peer.uid}
          stream={peer.stream}
          muted={false}
          highlightSpeaking
          speakerId={speakerId}
          label={`${peer.displayName} · ${ROLE_LABEL[peer.role]}`}
          badge={[peer.muted ? "Muted" : null, peerBadge(peer)].filter(Boolean).join(" · ")}
          actions={
            canModerate || canRename ? (
              <>
                {canRename && (
                  <button
                    onClick={() => renameParticipant(peer.uid, peer.displayName)}
                    title="Rename this participant"
                    className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/80"
                  >
                    Rename
                  </button>
                )}
                {canModerate && (
                  <>
                    <button
                      onClick={() => requestMute(peer.uid)}
                      title="Mute their microphone"
                      className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-neutral-200 backdrop-blur transition hover:bg-black/80"
                    >
                      Mute
                    </button>
                    <button
                      onClick={() => removeParticipant(peer.uid, peer.displayName)}
                      title="Remove from studio"
                      className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-red-300 backdrop-blur transition hover:bg-black/80"
                    >
                      Remove
                    </button>
                  </>
                )}
              </>
            ) : undefined
          }
        />
      ))}

      {screenPeers.map((sp) => (
        <VideoTile
          key={`screen-${sp.uid}`}
          stream={sp.stream}
          muted
          speakerId={speakerId}
          label={`${sp.displayName} · Screen`}
          badge={CONNECTION_LABEL[sp.connectionState] ?? sp.connectionState}
        />
      ))}

      {peers.length === 0 && <VideoTile stream={null} muted label="Waiting for others to join…" />}
    </>
  );

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-neutral-950 p-4 text-neutral-100 sm:gap-6 sm:p-6">
      <ResumeUploadsBanner sessionId={sessionId} uid={uid} />
      {canModerate && <AdmissionRequests sessionId={sessionId} requests={pendingRequests} />}
      {(role === "host" || role === "producer") && <UploadStatusPanel rows={uploadRows} />}
      {chatOpen && (
        <ChatPanel
          messages={chatMessages}
          selfUid={uid}
          onSend={sendChat}
          onClose={() => setChatOpen(false)}
        />
      )}
      {toasts.length > 0 && (
        <div className="fixed left-1/2 top-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 flex-col items-center gap-1.5">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`rounded-full border px-4 py-2 text-xs font-medium shadow-lg backdrop-blur ${
                t.tone === "success"
                  ? "border-emerald-700 bg-neutral-900/95 text-emerald-300"
                  : t.tone === "error"
                    ? "border-red-700 bg-neutral-900/95 text-red-300"
                    : "border-neutral-700 bg-neutral-900/95 text-neutral-200"
              }`}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
      {devicesOpen && (
        <div className="fixed right-4 top-16 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 shadow-xl backdrop-blur">
          <p className="text-xs font-semibold text-neutral-300">Devices</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Camera</span>
            <select
              value={cameraId}
              onChange={(e) => void switchInputDevice(e.target.value, micId)}
              disabled={
                switchingDevice ||
                recordingStatus === "recording" ||
                cameras.length === 0 ||
                !!sessionSettings.audioOnly
              }
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              {cameras.map((camera) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                  {camera.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Microphone</span>
            <select
              value={micId}
              onChange={(e) => void switchInputDevice(cameraId, e.target.value)}
              disabled={switchingDevice || recordingStatus === "recording" || microphones.length === 0}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              {microphones.map((microphone) => (
                <option key={microphone.deviceId} value={microphone.deviceId}>
                  {microphone.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Speaker</span>
            <select
              value={speakerId}
              onChange={(e) => applySpeaker(e.target.value)}
              disabled={speakers.length === 0 || !canSelectSpeakerOutput()}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none transition focus:border-indigo-500 disabled:opacity-50"
            >
              <option value="">Default speaker</option>
              {speakers.map((speaker) => (
                <option key={speaker.deviceId} value={speaker.deviceId}>
                  {speaker.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Device choices are remembered for the next time you join this browser.
            Camera and microphone switching is paused while recording.
          </p>
        </div>
      )}
      {settingsOpen && role === "host" && (
        <div className="fixed right-4 top-16 z-50 flex w-72 flex-col gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 shadow-xl backdrop-blur">
          <p className="text-xs font-semibold text-neutral-300">Recording settings</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Max video quality</span>
            <select
              value={String(sessionSettings.maxHeight ?? 2160)}
              onChange={(e) =>
                void setDoc(
                  doc(db, "sessions", sessionId),
                  { settings: { ...sessionSettings, maxHeight: Number(e.target.value) } },
                  { merge: true },
                ).catch(() => {})
              }
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none transition focus:border-indigo-500"
            >
              <option value="2160">Source (up to 4K)</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={!!sessionSettings.audioOnly}
              onChange={(e) =>
                void setDoc(
                  doc(db, "sessions", sessionId),
                  { settings: { ...sessionSettings, audioOnly: e.target.checked } },
                  { merge: true },
                ).catch(() => {})
              }
              className="accent-indigo-500"
            />
            Audio-only session (podcast mode)
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={!!sessionSettings.autoAdmit}
              onChange={(e) =>
                void setDoc(
                  doc(db, "sessions", sessionId),
                  { settings: { ...sessionSettings, autoAdmit: e.target.checked } },
                  { merge: true },
                ).catch(() => {})
              }
              className="accent-indigo-500"
            />
            Skip waiting room (auto-admit guests)
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Applies to participants when they join or rejoin the studio — people already in the
            call keep their current quality until they rejoin.
          </p>
        </div>
      )}
      {inCountdown && (
        <div className="studio-fade-in fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <span className="text-8xl font-bold tabular-nums text-white">{countdownSeconds}</span>
          <span className="text-sm text-neutral-300">Recording is about to start</span>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {role === "host" && (
            <Link href="/projects" className="text-sm text-neutral-500 hover:text-neutral-300">
              ← Projects
            </Link>
          )}
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
          <button
            onClick={() => {
              setDevicesOpen((o) => !o);
              void refreshDevices();
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              devicesOpen
                ? "border-indigo-500 text-indigo-300"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
            }`}
          >
            Devices
          </button>
          {role === "host" && (
            <button
              onClick={() => setSettingsOpen((o) => !o)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                settingsOpen
                  ? "border-indigo-500 text-indigo-300"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              Settings
            </button>
          )}
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

      {prompterOpen ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Teleprompter
            sessionId={sessionId}
            uid={uid}
            recordingActive={isRecordingActive && !inCountdown}
            onClose={() => setPrompterOpen(false)}
            mode="embedded"
          />
          <div className="grid max-h-[calc(100vh-14rem)] grid-cols-2 gap-3 overflow-y-auto lg:grid-cols-1">
            {callTiles}
          </div>
        </div>
      ) : (
        <div className={`grid flex-1 grid-cols-1 gap-4 ${gridColsClass}`}>{callTiles}</div>
      )}

      <footer className="flex flex-col items-center gap-3">
        {role === "host" && !isRecordingActive && notReadyPeers.length > 0 && (
          <p className="px-4 text-center text-xs text-amber-400">
            Waiting for {notReadyPeers.map((p) => p.displayName || "a guest").join(", ")} to
            connect — recording now may miss their track.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
          <ControlButton
            onClick={toggleMic}
            active={micOn}
            title={micOn ? "Mute microphone" : "Unmute microphone"}
            label={micOn ? "Mic on" : "Muted"}
          >
            {micOn ? (
              <Mic aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
            ) : (
              <MicOff aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
            )}
          </ControlButton>
          <ControlButton
            onClick={toggleCam}
            active={camOn}
            title={camOn ? "Turn camera off" : "Turn camera on"}
            label={camOn ? "Camera" : "Camera off"}
          >
            {camOn ? (
              <Video aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
            ) : (
              <VideoOff aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
            )}
          </ControlButton>

          <ControlButton
            onClick={toggleScreenShare}
            active={!!localScreenStream}
            title={localScreenStream ? "Stop sharing screen" : "Share screen"}
            label={localScreenStream ? "Sharing" : "Share"}
          >
            <Monitor aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
          </ControlButton>

          <ControlButton
            onClick={() => setPrompterOpen((o) => !o)}
            active={prompterOpen}
            title={prompterOpen ? "Close script" : "Open script / teleprompter"}
            label="Prompter"
          >
            <ScrollText aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
          </ControlButton>

          <div className="relative">
            <ControlButton
              onClick={() => setChatOpen((o) => !o)}
              active={chatOpen}
              title={chatOpen ? "Close chat" : "Open chat"}
              label="Chat"
            >
              <MessageCircle aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
            </ControlButton>
            {chatUnread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-500 px-1 text-[10px] font-bold text-white">
                {chatUnread > 9 ? "9+" : chatUnread}
              </span>
            )}
          </div>

          <ControlButton
            onClick={() => {
              setDevicesOpen((o) => !o);
              void refreshDevices();
            }}
            active={devicesOpen}
            title={devicesOpen ? "Close devices" : "Change camera, microphone, or speaker"}
            label="Devices"
          >
            <Settings aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
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
            Leave
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

        {screenRecStatus === "finishing" && (
          <p className="text-xs text-neutral-500">Uploading screen recording… keep this tab open</p>
        )}

        {isRecordingParticipant && recordingError && <p className="text-xs text-red-400">{recordingError}</p>}
      </footer>
    </div>
  );
}
