"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useProjects, createProject, type Project } from "@/hooks/useProjects";
import { deleteProject } from "@/lib/deletion";
import AppNav from "@/components/AppNav";
import SignInScreen from "@/components/SignInScreen";
import ProjectCard from "@/components/ProjectCard";
import ScriptModal from "@/components/ScriptModal";

const RETENTION_DAYS = 30;

function ArchivedRow({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);

  const purgeDate = new Date(
    project.archivedAt!.toMillis() + RETENTION_DAYS * 24 * 3600 * 1000,
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const restore = async () => {
    setBusy(true);
    try {
      await updateDoc(doc(db, "sessions", project.id), { archivedAt: null });
    } finally {
      setBusy(false);
    }
  };

  const deleteNow = async () => {
    const sure = window.confirm(
      `Permanently delete "${project.title}" and its recordings right now? This can't be undone.`,
    );
    if (!sure) return;
    setBusy(true);
    try {
      await deleteProject(project.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete project.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-neutral-800/70 bg-neutral-900/50 px-5 py-3">
      <div className="mr-auto flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-neutral-300">{project.title}</span>
        <span className="text-xs text-neutral-500">
          {project.recordingCount === 0
            ? "No recordings"
            : `${project.recordingCount} recording${project.recordingCount === 1 ? "" : "s"}`}{" "}
          · permanently deleted on {purgeDate}
        </span>
      </div>
      <button
        onClick={restore}
        disabled={busy}
        className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50"
      >
        Restore
      </button>
      <button
        onClick={deleteNow}
        disabled={busy}
        className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-medium text-neutral-400 transition hover:border-red-500 hover:text-red-400 disabled:opacity-50"
      >
        {busy ? "Working…" : "Delete now"}
      </button>
    </div>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const { user, authLoading, projects, archived } = useProjects();
  const [creating, setCreating] = useState(false);
  const [scriptProject, setScriptProject] = useState<Project | null>(null);

  if (authLoading) {
    return <p className="min-h-screen bg-neutral-950 p-6 text-neutral-500">Loading…</p>;
  }
  if (!user) {
    return <SignInScreen />;
  }

  const newProject = async () => {
    setCreating(true);
    const id = await createProject(user);
    setCreating(false);
    router.push(`/session/${id}`);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <AppNav user={user} />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-8 py-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Projects</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {projects.length === 0
                ? "All your recording sessions in one place."
                : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            onClick={newProject}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New
          </button>
        </header>

        {projects.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No projects yet — click &ldquo;New&rdquo; to record your first session.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onScript={setScriptProject} />
            ))}
          </div>
        )}

        {archived.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-neutral-400">
              Archived · kept for {RETENTION_DAYS} days
            </h2>
            <div className="flex flex-col gap-2">
              {archived.map((project) => (
                <ArchivedRow key={project.id} project={project} />
              ))}
            </div>
          </section>
        )}

        {scriptProject && (
          <ScriptModal
            sessionId={scriptProject.id}
            title={scriptProject.title}
            onClose={() => setScriptProject(null)}
          />
        )}
      </main>
    </div>
  );
}
