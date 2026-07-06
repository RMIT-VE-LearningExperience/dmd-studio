"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, updateDoc, Timestamp } from "firebase/firestore";
import { CalendarDays, FileText, FolderOpen, Pencil, Trash2, Video } from "lucide-react";
import { db } from "@/lib/firebase";
import { deleteProject } from "@/lib/deletion";
import type { Project } from "@/hooks/useProjects";

function formatDate(ts: Timestamp | null) {
  if (!ts) return "Just now";
  return ts.toDate().toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

// Local-time value for <input type="datetime-local">.
function toDatetimeLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = {
  project: Project;
  onScript: (project: Project) => void;
};

export default function ProjectCard({ project, onScript }: Props) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState("");
  const [deleting, setDeleting] = useState(false);

  const commitRename = async () => {
    const title = titleDraft.trim();
    setRenaming(false);
    if (!title) return;
    await updateDoc(doc(db, "sessions", project.id), { title });
  };

  const startSchedule = () => {
    setScheduling(true);
    const base =
      project.scheduledAt?.toDate() ??
      (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(10, 0, 0, 0);
        return d;
      })();
    setScheduleDraft(toDatetimeLocal(base));
  };

  const commitSchedule = async () => {
    setScheduling(false);
    if (!scheduleDraft) return;
    const when = new Date(scheduleDraft);
    if (Number.isNaN(when.getTime())) return;
    await updateDoc(doc(db, "sessions", project.id), { scheduledAt: Timestamp.fromDate(when) });
  };

  const clearSchedule = async () => {
    setScheduling(false);
    await updateDoc(doc(db, "sessions", project.id), { scheduledAt: null });
  };

  const remove = async () => {
    const sure = window.confirm(
      project.recordingCount > 0
        ? `Delete "${project.title}" and its ${project.recordingCount} recording${project.recordingCount === 1 ? "" : "s"}? This can't be undone.`
        : `Delete "${project.title}"? This can't be undone.`,
    );
    if (!sure) return;
    setDeleting(true);
    try {
      await deleteProject(project.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete project.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      onClick={() => router.push(`/session/${project.id}`)}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 transition hover:border-neutral-700"
    >
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/session/${project.id}/recordings`);
          }}
          className="flex aspect-video w-full items-center justify-center bg-neutral-800/60 transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
          aria-label={`Open recordings for ${project.title}`}
          title="Open recordings"
        >
          <FolderOpen aria-hidden="true" className="h-11 w-11 text-neutral-200/70" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            remove();
          }}
          disabled={deleting}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950/80 text-neutral-400 shadow-lg backdrop-blur transition hover:border-red-500 hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Delete ${project.title}`}
          title="Delete project"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>
      <div className="flex items-end justify-between gap-2 p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          {project.live && (
            <span className="flex w-fit items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              LIVE
            </span>
          )}
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="w-full rounded-md border border-indigo-500 bg-neutral-800 px-1.5 py-0.5 text-sm font-semibold text-neutral-100 outline-none"
            />
          ) : (
            <span className="text-sm font-semibold text-neutral-100">{project.title}</span>
          )}
          <span className="text-xs text-neutral-500">
            Created {formatDate(project.createdAt)} ·{" "}
            {project.recordingCount === 0
              ? "Empty"
              : `${project.recordingCount} Recording${project.recordingCount === 1 ? "" : "s"}`}
          </span>
          {scheduling ? (
            <div className="mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <input
                type="datetime-local"
                autoFocus
                value={scheduleDraft}
                onChange={(e) => setScheduleDraft(e.target.value)}
                className="rounded-md border border-indigo-500 bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-100 outline-none"
              />
              <button
                onClick={commitSchedule}
                className="rounded-full bg-indigo-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-indigo-500"
              >
                Set
              </button>
              {project.scheduledAt && (
                <button
                  onClick={clearSchedule}
                  className="text-[11px] text-neutral-500 underline hover:text-neutral-300"
                >
                  Clear
                </button>
              )}
            </div>
          ) : (
            project.scheduledAt && (
              <span className="flex items-center gap-1 text-xs text-neutral-300">
                <CalendarDays aria-hidden="true" className="h-3 w-3 text-neutral-400" strokeWidth={1.8} />
                {project.scheduledAt.toDate().toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )
          )}
        </div>
        <div
          className="relative min-w-0 max-w-[min(100%,24rem)] shrink"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex max-w-full items-center justify-end gap-1.5 overflow-x-auto pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              onClick={(e) => {
                e.stopPropagation();
                startSchedule();
              }}
              title="Schedule this recording"
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white"
            >
              <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
              Schedule
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onScript(project);
              }}
              title="Prepare the session script"
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white"
            >
              <FileText aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
              Script
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
                setTitleDraft(project.title);
              }}
              title="Rename project"
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white"
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
              Rename
            </button>
            {project.recordingCount > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/session/${project.id}/recordings`);
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white"
              >
                <Video aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
                Recordings
              </button>
            )}
          </div>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-neutral-900 via-neutral-900 to-transparent pr-1 text-lg leading-none text-neutral-500"
          >
            ...
          </span>
        </div>
      </div>
    </div>
  );
}
