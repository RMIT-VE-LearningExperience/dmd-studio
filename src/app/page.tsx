"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  onSnapshot,
  getCountFromServer,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { signInHost } from "@/lib/auth";
import { deleteProject } from "@/lib/deletion";

type Project = {
  id: string;
  title: string;
  createdAt: Timestamp | null;
  recordingCount: number;
};

function formatDate(ts: Timestamp | null) {
  if (!ts) return "Just now";
  return ts.toDate().toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "sessions"), where("hostUid", "==", user.uid), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, async (snap) => {
      const withCounts = await Promise.all(
        snap.docs.map(async (docSnap) => {
          const data = docSnap.data();
          const countSnap = await getCountFromServer(collection(db, "sessions", docSnap.id, "recordings"));
          return {
            id: docSnap.id,
            title: (data.title as string) || "Untitled",
            createdAt: (data.createdAt as Timestamp) ?? null,
            recordingCount: countSnap.data().count,
          };
        }),
      );
      setProjects(withCounts);
    });
    return unsub;
  }, [user]);

  const createProject = async () => {
    if (!user) return;
    setCreating(true);
    const sessionRef = await addDoc(collection(db, "sessions"), {
      hostUid: user.uid,
      title: "Untitled",
      createdAt: serverTimestamp(),
      status: "created",
    });
    setCreating(false);
    router.push(`/session/${sessionRef.id}`);
  };

  const startRename = (project: Project) => {
    setRenamingId(project.id);
    setTitleDraft(project.title);
  };

  const commitRename = async (projectId: string) => {
    const title = titleDraft.trim();
    setRenamingId(null);
    if (!title) return;
    await updateDoc(doc(db, "sessions", projectId), { title });
  };

  const removeProject = async (project: Project) => {
    const sure = window.confirm(
      project.recordingCount > 0
        ? `Delete "${project.title}" and its ${project.recordingCount} recording${project.recordingCount === 1 ? "" : "s"}? This can't be undone.`
        : `Delete "${project.title}"? This can't be undone.`,
    );
    if (!sure) return;
    setDeletingId(project.id);
    try {
      await deleteProject(project.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete project.");
    } finally {
      setDeletingId(null);
    }
  };

  if (!user) {
    return (
      <main className="flex min-h-screen justify-center bg-neutral-950 px-6 py-16 text-neutral-100">
        <div className="flex w-full max-w-xl flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold">DMD Studio</h1>
            <p className="mt-2 text-sm text-neutral-400">
              Record interview-style conversations with guests, locally in-browser,
              for later playback and download.
            </p>
          </div>
          <button
            onClick={signInHost}
            className="w-fit rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
          >
            Sign in with Google
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-8 py-10 text-neutral-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Projects</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Signed in as {user.displayName ?? user.email}{" "}
              <button onClick={() => signOut(auth)} className="text-neutral-500 underline hover:text-neutral-300">
                Sign out
              </button>
            </p>
          </div>
          <button
            onClick={createProject}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New
          </button>
        </header>

        {projects.length === 0 ? (
          <p className="text-sm text-neutral-500">No projects yet — click &ldquo;New&rdquo; to record your first session.</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <div
                key={project.id}
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
                    {renamingId === project.id ? (
                      <input
                        autoFocus
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(project.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(project.id);
                          if (e.key === "Escape") setRenamingId(null);
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
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(project);
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
                        removeProject(project);
                      }}
                      disabled={deletingId === project.id}
                      title="Delete project"
                      className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-400 transition hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingId === project.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
