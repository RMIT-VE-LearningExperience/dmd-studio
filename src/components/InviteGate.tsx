"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { checkInvite, isValidEmail, normalizeEmail, rememberInvite, type Invite } from "@/lib/invites";

type Props = {
  sessionId: string;
  onVerified: (invite: Invite) => void;
};

// The door on an invite-only tutorial: a guest must enter the email address
// they were invited with before they see the lobby. Matching is a single
// hashed lookup, so a wrong address reveals nothing about who was invited.
export default function InviteGate({ sessionId, onVerified }: Props) {
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      setError("Enter a valid email address.");
      return;
    }
    setChecking(true);
    setError(null);
    const invite = await checkInvite(sessionId, normalized);
    setChecking(false);
    if (!invite) {
      setError("That email address isn't on the invite list for this recording. Check it matches the address the invitation was sent to, or ask the organiser to add you.");
      return;
    }
    rememberInvite(sessionId, invite);
    onVerified(invite);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-2xl"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-300">
          <Mail aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <h1 className="mt-4 text-lg font-semibold">This recording is invite-only</h1>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">
          Enter the email address your invitation was sent to and we&apos;ll let you through to the
          studio.
        </p>
        <label className="mt-5 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-500">Email address</span>
          <input
            type="email"
            autoFocus
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="you@rmit.edu.au"
            className="w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500"
          />
        </label>
        {error && <p className="mt-2 text-sm leading-relaxed text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={checking || !email.trim()}
          className="mt-5 w-full rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
