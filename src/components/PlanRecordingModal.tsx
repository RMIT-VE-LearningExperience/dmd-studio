"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, Link2, X } from "lucide-react";
import type { User } from "firebase/auth";
import { createProject } from "@/hooks/useProjects";

type Props = {
  user: User;
  initialDate?: Date | null;
  onClose: () => void;
};

function toDatetimeLocal(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

export default function PlanRecordingModal({ user, initialDate, onClose }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState("Untitled");
  const [scheduledAt, setScheduledAt] = useState(() => toDatetimeLocal(defaultStart(initialDate)));
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const links = useMemo(() => {
    if (!createdId) return [];
    return [
      { key: "host", label: "Host", url: `${origin}/session/${createdId}` },
      { key: "guest", label: "Guest", url: `${origin}/session/${createdId}?role=guest` },
      { key: "producer", label: "Producer", url: `${origin}/session/${createdId}?role=producer` },
    ];
  }, [createdId, origin]);

  const create = async () => {
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      window.alert("Choose a valid date and time.");
      return;
    }

    setCreating(true);
    try {
      const id = await createProject(user, {
        title,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
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

        <div className="grid gap-5 p-5 md:grid-cols-[1fr_0.9fr]">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-500">Project title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!!createdId}
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-neutral-500">Date and time</span>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  disabled={!!createdId}
                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 disabled:opacity-60"
                />
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

          <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
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
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-neutral-600 hover:text-white"
                    >
                      {copied === link.key ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : (
                        <Copy aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                      )}
                      <span className="w-14 shrink-0 font-semibold">{link.label}</span>
                      <span className="truncate text-neutral-500">{link.url}</span>
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
