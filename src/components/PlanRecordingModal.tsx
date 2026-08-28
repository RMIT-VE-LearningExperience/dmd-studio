"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, Link2, X } from "lucide-react";
import type { User } from "firebase/auth";
import { createProject, type SessionKind } from "@/hooks/useProjects";

type Props = {
  user: User;
  initialDate?: Date | null;
  onClose: () => void;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toDateInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateAndTime(date: string, time: string) {
  return new Date(`${date}T${time}`);
}

function timeLabel(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildTimeOptions() {
  const options: string[] = [];
  for (let minutes = 6 * 60; minutes <= 22 * 60; minutes += 15) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    options.push(`${pad(hours)}:${pad(mins)}`);
  }
  return options;
}

function defaultStart(initialDate?: Date | null) {
  const date = initialDate ? new Date(initialDate) : new Date();
  if (!initialDate) date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return date;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

const TIME_OPTIONS = buildTimeOptions();
const QUICK_TIMES = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00"];

export default function PlanRecordingModal({ user, initialDate, onClose }: Props) {
  const router = useRouter();
  const initialStart = useMemo(() => defaultStart(initialDate), [initialDate]);
  const [title, setTitle] = useState("Untitled");
  const [kind, setKind] = useState<SessionKind>("podcast");
  const [scheduledDate, setScheduledDate] = useState(() => toDateInput(initialStart));
  const [scheduledTime, setScheduledTime] = useState(() => toTimeInput(initialStart));
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const links = useMemo(() => {
    if (!createdId) return [];
    return [
      { key: "host", label: "Host", url: `${origin}/session/${createdId}` },
      {
        key: "guest",
        label: kind === "tutorial" ? "Teacher" : "Guest",
        url: `${origin}/session/${createdId}?role=guest`,
      },
      { key: "producer", label: "Producer", url: `${origin}/session/${createdId}?role=producer` },
    ];
  }, [createdId, origin, kind]);

  const create = async () => {
    const when = fromDateAndTime(scheduledDate, scheduledTime);
    if (Number.isNaN(when.getTime())) {
      window.alert("Choose a valid date and time.");
      return;
    }

    setCreating(true);
    try {
      const id = await createProject(user, {
        title,
        kind,
        scheduledAt: when,
        durationMinutes,
      });
      setCreatedId(id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to plan recording.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (key: string, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const copyAll = async () => {
    await navigator.clipboard.writeText(links.map((link) => `${link.label}: ${link.url}`).join("\n"));
    setCopied("all");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-neutral-200">
            <CalendarClock aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="mr-auto min-w-0">
            <h2 className="text-base font-semibold">Plan studio recording</h2>
            <p className="text-xs text-neutral-500">Schedule the session and copy invite links.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-800 text-neutral-400 transition hover:border-neutral-600 hover:text-white"
            aria-label="Close"
          >
            <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="grid min-w-0 gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.85fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-500">Session type</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["podcast", "Podcast / interview", "Host runs the recording; everyone's takes start together."],
                    ["tutorial", "Tutorial", "The teacher records their own screen + camera whenever they're ready. No host needed."],
                  ] as const
                ).map(([value, heading, blurb]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setKind(value)}
                    disabled={!!createdId}
                    aria-pressed={kind === value}
                    className={`rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                      kind === value
                        ? "border-indigo-500 bg-indigo-500/10"
                        : "border-neutral-700 hover:border-neutral-500"
                    }`}
                  >
                    <span className="block text-sm font-semibold">{heading}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-neutral-400">{blurb}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-500">Project title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!!createdId}
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-[1fr_11rem_9rem]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-neutral-500">Date</span>
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  disabled={!!createdId}
                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-neutral-500">Start time</span>
                <select
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  disabled={!!createdId}
                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
                >
                  {TIME_OPTIONS.map((time) => (
                    <option key={time} value={time}>
                      {timeLabel(time)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-neutral-500">Duration</span>
                <select
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  disabled={!!createdId}
                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
                >
                  {[30, 45, 60, 75, 90, 120, 180].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {formatDuration(minutes)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-neutral-500">Quick start</span>
              {QUICK_TIMES.map((time) => (
                <button
                  key={time}
                  type="button"
                  onClick={() => setScheduledTime(time)}
                  disabled={!!createdId}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    scheduledTime === time
                      ? "border-indigo-400 bg-indigo-500/15 text-indigo-200"
                      : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                  }`}
                >
                  {timeLabel(time)}
                </button>
              ))}
            </div>

            {createdId ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                Recording planned. The links are ready to send.
              </div>
            ) : (
              <button
                type="button"
                onClick={create}
                disabled={creating}
                className="flex w-fit items-center gap-2 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CalendarClock aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                {creating ? "Planning..." : "Plan recording"}
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
            <div className="flex items-center gap-2">
              <Link2 aria-hidden="true" className="h-4 w-4 text-neutral-400" strokeWidth={1.8} />
              <h3 className="text-sm font-semibold text-neutral-200">Invite links</h3>
            </div>

            {createdId ? (
              <>
                <div className="flex flex-col gap-2">
                  {links.map((link) => (
                    <button
                      key={link.key}
                      type="button"
                      onClick={() => copy(link.key, link.url)}
                      className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-neutral-600 hover:text-white"
                    >
                      {copied === link.key ? (
                        <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : (
                        <Copy aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-semibold text-neutral-200">{link.label}</span>
                        <span className="break-all leading-relaxed text-neutral-500">{link.url}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={copyAll}
                    className="rounded-full border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
                  >
                    {copied === "all" ? "Copied all" : "Copy all"}
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/session/${createdId}`)}
                    className="rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition hover:bg-white"
                  >
                    Enter studio
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs leading-5 text-neutral-500">
                Links are generated after the recording is planned. Guests use the guest link;
                producers use the producer link.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
