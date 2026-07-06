"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProjects, createProject, type Project } from "@/hooks/useProjects";
import AppNav from "@/components/AppNav";
import SignInScreen from "@/components/SignInScreen";
import ProjectCard from "@/components/ProjectCard";
import ScriptModal from "@/components/ScriptModal";

export default function Home() {
  const router = useRouter();
  const { user, authLoading, projects } = useProjects();
  const [creating, setCreating] = useState(false);
  const [scriptProject, setScriptProject] = useState<Project | null>(null);
  // Captured once per mount — "upcoming" doesn't need to tick live.
  const [now] = useState(() => Date.now());

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

  // Anything planned from an hour ago onwards counts as upcoming.
  const upcoming = projects
    .filter((p) => p.scheduledAt && p.scheduledAt.toMillis() > now - 3600_000)
    .sort((a, b) => a.scheduledAt!.toMillis() - b.scheduledAt!.toMillis())
    .slice(0, 4);
  const recent = projects.slice(0, 6);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <AppNav user={user} />
      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-8 py-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">
              Welcome back{user.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Plan, record and review your interview sessions.
            </p>
          </div>
          <button
            onClick={newProject}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New recording
          </button>
        </header>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">Upcoming recordings</h2>
            <Link href="/calendar" className="text-xs text-indigo-400 hover:underline">
              Open calendar →
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-neutral-800 p-5 text-sm text-neutral-500">
              Nothing planned yet — schedule a session from the{" "}
              <Link href="/calendar" className="text-indigo-400 hover:underline">
                calendar
              </Link>{" "}
              or a project card.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {upcoming.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-neutral-800 bg-neutral-900 px-5 py-3.5"
                >
                  <div className="flex w-32 flex-col">
                    <span className="text-xs font-semibold text-indigo-300">
                      {p.scheduledAt!.toDate().toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {p.scheduledAt!.toDate().toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <span className="mr-auto text-sm font-medium">{p.title}</span>
                  <button
                    onClick={() => setScriptProject(p)}
                    className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
                  >
                    Script
                  </button>
                  <Link
                    href={`/session/${p.id}`}
                    className="rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
                  >
                    Enter studio
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">Recent projects</h2>
            <Link href="/projects" className="text-xs text-indigo-400 hover:underline">
              View all →
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No projects yet — click &ldquo;New recording&rdquo; to record your first session.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((project) => (
                <ProjectCard key={project.id} project={project} onScript={setScriptProject} />
              ))}
            </div>
          )}
        </section>

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
