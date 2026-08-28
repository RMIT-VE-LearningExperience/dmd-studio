"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type ProjectPreview = {
  id: string;
  displayName: string;
  thumbnailUrl: string;
};

export type SessionKind = "podcast" | "tutorial";

export type Project = {
  id: string;
  title: string;
  // "podcast": host-driven synchronised takes (the original studio).
  // "tutorial": each teacher records their own screen + camera on demand.
  kind: SessionKind;
  // Tutorials with an invite list: guests must enter an invited email.
  inviteOnly: boolean;
  createdAt: Timestamp | null;
  scheduledAt: Timestamp | null;
  durationMinutes: number | null;
  archivedAt: Timestamp | null;
  recordingCount: number;
  previews: ProjectPreview[];
  live: boolean;
};

export type CreateProjectInput = {
  title?: string;
  kind?: SessionKind;
  inviteOnly?: boolean;
  scheduledAt?: Date;
  durationMinutes?: number;
};

// Auth + the signed-in host's project list, shared by Home, Calendar and
// Projects pages. `recordingCount` and `previews` are denormalized onto the
// session doc by the syncSessionSummary Cloud Function, so rendering the
// dashboard costs one query — not one recordings fetch per project.
export function useProjects() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archived, setArchived] = useState<Project[]>([]);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthLoading(false);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "sessions"),
      where("hostUid", "==", user.uid),
      orderBy("createdAt", "desc"),
    );
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((docSnap): Project => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          title: (data.title as string) || "Untitled",
          kind: data.kind === "tutorial" ? "tutorial" : "podcast",
          inviteOnly: data.inviteOnly === true,
          createdAt: (data.createdAt as Timestamp) ?? null,
          scheduledAt: (data.scheduledAt as Timestamp) ?? null,
          durationMinutes: (data.durationMinutes as number) ?? null,
          archivedAt: data.archivedAt instanceof Timestamp ? data.archivedAt : null,
          recordingCount: (data.recordingCount as number) ?? 0,
          previews: (data.previews as ProjectPreview[]) ?? [],
          // The heartbeat refreshes lastLiveAt every minute while the host
          // is in the studio — a stale timestamp means the tab died
          // without a clean Leave, so don't show a stuck LIVE badge.
          live:
            data.status === "live" &&
            data.lastLiveAt instanceof Timestamp &&
            Date.now() - data.lastLiveAt.toMillis() < 3 * 60_000,
        };
      });
      setProjects(all.filter((p) => !p.archivedAt));
      setArchived(
        all
          .filter((p) => p.archivedAt)
          .sort((a, b) => b.archivedAt!.toMillis() - a.archivedAt!.toMillis()),
      );
    });
  }, [user]);

  return { user, authLoading, projects, archived };
}

export async function createProject(
  user: User,
  titleOrInput: string | CreateProjectInput = "Untitled",
  scheduledAt?: Date,
) {
  const input =
    typeof titleOrInput === "string"
      ? { title: titleOrInput, scheduledAt }
      : titleOrInput;
  const durationMinutes = input.durationMinutes ? Math.max(15, Math.round(input.durationMinutes)) : null;

  const ref = await addDoc(collection(db, "sessions"), {
    hostUid: user.uid,
    title: input.title?.trim() || "Untitled",
    kind: input.kind ?? "podcast",
    // A teacher recording a tutorial works alone — no host at the door.
    ...(input.kind === "tutorial" ? { settings: { autoAdmit: true } } : {}),
    ...(input.inviteOnly ? { inviteOnly: true } : {}),
    createdAt: serverTimestamp(),
    ...(input.scheduledAt ? { scheduledAt: Timestamp.fromDate(input.scheduledAt) } : {}),
    ...(durationMinutes ? { durationMinutes } : {}),
    status: "created",
  });
  return ref.id;
}
