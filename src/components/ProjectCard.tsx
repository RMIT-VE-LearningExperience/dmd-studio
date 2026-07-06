"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, updateDoc, Timestamp } from "firebase/firestore";
import { CalendarDays, FileText, FolderOpen, MoreHorizontal, Pencil, Trash2, Video } from "lucide-react";
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
  const [menuOpen, setMenuOpen] = useState(false);

  const commitRename = async () => {
    const title = titleDraft.trim();
    setRenaming(false);
    if (!title) return;
    await updateDoc(doc(db, "sessions", project.id), { title });
  };

  const startSchedule = () => {
    setMenuOpen(false);
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
        ? `Delete "${project.title}" and its ${project.recordingCount} recording${project.recordingCount === 1 ? "" : "s"} permanently? This can't be undone.`
        : `Delete "${project.title}" permanently? This can't be undone.`,
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
      className="group flex cursor-pointer flex-col rounded-2xl border border-neutral-800 bg-neutral-900 transition hover:border-neutral-700"
    >
      <div className="relative overflow-hidden rounded-t-2xl">
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
          {project.previews.length > 0 ? (
            <span className="flex h-full w-full bg-neutral-950">
              {project.previews.map((preview) => (
                <span
                  key={preview.id}
                  aria-label={preview.displayName}
                  className="min-w-0 flex-1 overflow-hidden border-r border-neutral-950 last:border-r-0"
                >
                  <span
                    className="block h-full w-full bg-cover bg-center transition duration-300 group-hover:scale-[1.03]"
                    style={{ backgroundImage: `url(${preview.thumbnailUrl})` }}
                  />
                </span>
              ))}
            </span>
          ) : (
            <FolderOpen aria-hidden="true" className="h-11 w-11 text-neutral-200/70" strokeWidth={1.5} />
          )}
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
          className="relative shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((open) => !open);
              }}
              aria-label="More project actions"
              aria-expanded={menuOpen}
              title="More actions"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-neutral-300 transition hover:border-neutral-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
            >
              <MoreHorizontal aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
          {menuOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-2 w-48 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 py-1 text-sm shadow-2xl">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  startSchedule();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-300 transition hover:bg-neutral-800 hover:text-white"
              >
                <CalendarDays aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                Schedule
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onScript(project);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-300 transition hover:bg-neutral-800 hover:text-white"
              >
                <FileText aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                Script
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  setRenaming(true);
                  setTitleDraft(project.title);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-300 transition hover:bg-neutral-800 hover:text-white"
              >
                <Pencil aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                Rename
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  router.push(`/session/${project.id}/recordings`);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-300 transition hover:bg-neutral-800 hover:text-white"
              >
                <Video aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                {project.recordingCount > 0 ? "Recordings" : "Open folder"}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  remove();
                }}
                disabled={deleting}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-300 transition hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
