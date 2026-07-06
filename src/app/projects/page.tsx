"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProjects, createProject, type Project } from "@/hooks/useProjects";
import AppNav from "@/components/AppNav";
import SignInScreen from "@/components/SignInScreen";
import ProjectCard from "@/components/ProjectCard";
import ScriptModal from "@/components/ScriptModal";

export default function ProjectsPage() {
  const router = useRouter();
  const { user, authLoading, projects } = useProjects();
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
