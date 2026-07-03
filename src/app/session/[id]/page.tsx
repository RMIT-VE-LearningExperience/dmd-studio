"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { signInGuest } from "@/lib/auth";
import RecordingRoom from "@/components/RecordingRoom";
import type { ParticipantRole } from "@/hooks/useWebRTCMesh";

function roleFromParam(param: string | null): ParticipantRole {
  if (param === "guest" || param === "producer") return param;
  return "host";
}

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const role = roleFromParam(searchParams.get("role"));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (current) => {
      if (current) {
        setUser(current);
        setLoading(false);
        return;
      }
      if (role === "guest" || role === "producer") {
        const guestUser = await signInGuest();
        setUser(guestUser);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [role]);

  if (loading) {
    return <p className="p-6 text-neutral-500">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="p-6 text-neutral-500">
        Please sign in from the dashboard to host a session.
      </p>
    );
  }

  const displayName = user.displayName ?? user.email ?? `Guest ${user.uid.slice(0, 4)}`;

  return <RecordingRoom sessionId={id} role={role} uid={user.uid} displayName={displayName} />;
}
