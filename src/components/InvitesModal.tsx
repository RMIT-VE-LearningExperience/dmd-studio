"use client";

import { useEffect, useState } from "react";
import { Mail, Trash2, X } from "lucide-react";
import { addInvites, listInvites, parseEmailList, removeInvite, setInviteOnly, type Invite } from "@/lib/invites";

type Props = {
  sessionId: string;
  title: string;
  onClose: () => void;
};

// Host-side management of a tutorial's invite list after it was planned:
// add more teachers, or take someone off. The session is invite-only
// whenever the list is non-empty.
export default function InvitesModal({ sessionId, title, onClose }: Props) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listInvites(sessionId)
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch(() => {
        if (!cancelled) setInvites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const refresh = async (list: Invite[]) => {
    setInvites(list);
    await setInviteOnly(sessionId, list.length > 0).catch(() => {});
  };

  const add = async () => {
    const { emails, invalid } = parseEmailList(draft);
    if (invalid.length) {
      setError(`Not an email address: ${invalid.join(", ")}`);
      return;
    }
    if (!emails.length) return;
    setBusy(true);
    setError(null);
    try {
      await addInvites(sessionId, emails);
      await refresh(await listInvites(sessionId));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add invites.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (invite: Invite) => {
    setBusy(true);
    try {
      await removeInvite(sessionId, invite.key);
      await refresh((invites ?? []).filter((i) => i.key !== invite.key));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that invite.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-neutral-200">
            <Mail aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="mr-auto min-w-0">
            <h2 className="text-base font-semibold">Invited teachers</h2>
            <p className="truncate text-xs text-neutral-500">{title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-800 text-neutral-400 transition hover:border-neutral-600 hover:text-white"
          >
            <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <p className="text-xs leading-5 text-neutral-500">
            Only these email addresses can open the teacher link and record. With no one listed,
            anyone with the link can record.
          </p>

          {invites === null ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : invites.length === 0 ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              No one is invited yet — the teacher link is open to anyone.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800 rounded-lg border border-neutral-800">
              {invites.map((invite) => (
                <li key={invite.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-neutral-200">{invite.email}</span>
                  <button
                    type="button"
                    onClick={() => void remove(invite)}
                    disabled={busy}
                    aria-label={`Remove ${invite.email}`}
                    title="Remove"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-500">Add email addresses</span>
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              rows={3}
              placeholder="one per line, or separated by commas"
              className="w-full min-w-0 resize-y rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500"
            />
          </label>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !draft.trim()}
            className="w-fit rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : "Add to invite list"}
          </button>
        </div>
      </div>
    </div>
  );
}
