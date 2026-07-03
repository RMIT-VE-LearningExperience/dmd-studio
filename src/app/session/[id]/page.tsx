"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { signInGuest } from "@/lib/auth";
import RecordingRoom from "@/components/RecordingRoom";
import type { Role } from "@/hooks/useWebRTCSession";

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const role: Role = searchParams.get("role") === "guest" ? "guest" : "host";
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (current) => {
      if (current) {
        setUser(current);
        setLoading(false);
        return;
      }
      if (role === "guest") {
        const guestUser = await signInGuest();
        setUser(guestUser);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [role]);

  if (loading) {
    return <p className="p-6 text-gray-500">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="p-6 text-gray-500">
        Please sign in from the dashboard to host a session.
      </p>
    );
  }

  return <RecordingRoom sessionId={id} role={role} />;
}
