"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, updateDoc, Timestamp } from "firebase/firestore";
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
      <div className="flex aspect-video items-center justify-center bg-neutral-800/60">
        <svg
          className="h-10 w-10 text-neutral-600"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      </div>
      <div className="flex items-end justify-between gap-2 p-4">
        <div className="flex flex-col gap-0.5">
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
              <span className="text-xs text-indigo-300">
                📅{" "}
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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              startSchedule();
            }}
            title="Schedule this recording"
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
          >
            Schedule
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onScript(project);
            }}
            title="Prepare the session script"
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
          >
            Script
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
              setTitleDraft(project.title);
            }}
            title="Rename project"
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
          >
            Rename
          </button>
          {project.recordingCount > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/session/${project.id}/recordings`);
              }}
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
            >
              Recordings
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              remove();
            }}
            disabled={deleting}
            title="Delete project"
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
