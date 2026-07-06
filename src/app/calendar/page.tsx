"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProjects, createProject, type Project } from "@/hooks/useProjects";
import AppNav from "@/components/AppNav";
import SignInScreen from "@/components/SignInScreen";
import PlannerCalendar from "@/components/PlannerCalendar";
import ScriptModal from "@/components/ScriptModal";

export default function CalendarPage() {
  const router = useRouter();
  const { user, authLoading, projects } = useProjects();
  const [scriptProject, setScriptProject] = useState<Project | null>(null);

  if (authLoading) {
    return <p className="min-h-screen bg-neutral-950 p-6 text-neutral-500">Loading…</p>;
  }
  if (!user) {
    return <SignInScreen />;
  }

  // Calendar day click: plan a new session on that day (10:00 by default).
  const createScheduled = async (date: Date) => {
    const title = window.prompt(
      `Plan a recording for ${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} — project title:`,
    );
    if (title === null) return;
    const when = new Date(date);
    when.setHours(10, 0, 0, 0);
    await createProject(user, title.trim() || "Untitled", when);
  };

  const scheduled = projects
    .filter((p) => p.scheduledAt)
    .sort((a, b) => a.scheduledAt!.toMillis() - b.scheduledAt!.toMillis());

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <AppNav user={user} />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-8 py-10">
        <header>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Click a day to plan a recording, or a session to enter its studio. Prep scripts from
            the list below.
          </p>
        </header>

        <PlannerCalendar
          entries={projects.flatMap((p) =>
            p.scheduledAt ? [{ id: p.id, title: p.title, scheduledAt: p.scheduledAt }] : [],
          )}
          onOpen={(id) => router.push(`/session/${id}`)}
          onCreate={createScheduled}
        />

        {scheduled.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-neutral-300">All scheduled sessions</h2>
            <div className="flex flex-col gap-2">
              {scheduled.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-neutral-800 bg-neutral-900 px-5 py-3.5"
                >
                  <span className="w-44 text-xs font-medium text-indigo-300">
                    {p.scheduledAt!.toDate().toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="mr-auto text-sm font-medium">{p.title}</span>
                  <button
                    onClick={() => setScriptProject(p)}
                    className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
                  >
                    Script
                  </button>
                  <button
                    onClick={() => router.push(`/session/${p.id}`)}
                    className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500"
                  >
                    Enter studio
                  </button>
                </div>
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
