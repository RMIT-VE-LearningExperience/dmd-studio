import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";

// Invite-only sessions (tutorials) keep their guest list under
// sessions/{id}/invites/{key}, where key = sha256(normalised email). A guest
// entering the email they were invited with can `get` exactly that one doc
// (rules forbid listing), so the list itself is never exposed — and the
// participant they then create must carry a key that exists here.

export function normalizeEmail(raw: string) {
  return raw.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string) {
  return EMAIL_RE.test(email);
}

// Splits a pasted list (commas, semicolons, whitespace, newlines) into
// unique, normalised addresses; returns anything that didn't look like one.
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    if (!piece) continue;
    const email = normalizeEmail(piece);
    if (!isValidEmail(email)) {
      invalid.push(piece);
      continue;
    }
    seen.add(email);
  }
  return { emails: [...seen], invalid };
}

export async function inviteKeyFor(email: string) {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Invite = { key: string; email: string };

export async function addInvites(sessionId: string, emails: string[]) {
  if (!emails.length) return;
  const batch = writeBatch(db);
  for (const email of emails) {
    const key = await inviteKeyFor(email);
    batch.set(
      doc(db, "sessions", sessionId, "invites", key),
      { email: normalizeEmail(email), createdAt: serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();
}

export async function removeInvite(sessionId: string, key: string) {
  await deleteDoc(doc(db, "sessions", sessionId, "invites", key));
}

export async function listInvites(sessionId: string): Promise<Invite[]> {
  const snap = await getDocs(collection(db, "sessions", sessionId, "invites"));
  return snap.docs
    .map((d) => ({ key: d.id, email: (d.data().email as string) ?? "" }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function setInviteOnly(sessionId: string, inviteOnly: boolean) {
  await setDoc(doc(db, "sessions", sessionId), { inviteOnly }, { merge: true });
}

// A guest's check: does the email they typed match an invite? Resolves to
// the invite (key + email) or null. Only ever a single `get`.
export async function checkInvite(sessionId: string, email: string): Promise<Invite | null> {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return null;
  const key = await inviteKeyFor(normalized);
  try {
    const snap = await getDoc(doc(db, "sessions", sessionId, "invites", key));
    return snap.exists() ? { key, email: normalized } : null;
  } catch {
    return null;
  }
}

// Remembered per session so a refresh or a rejoin doesn't re-ask.
const storageKey = (sessionId: string) => `dmd-invite-${sessionId}`;

export function recallInvite(sessionId: string): Invite | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Invite>;
    return parsed.key && parsed.email ? { key: parsed.key, email: parsed.email } : null;
  } catch {
    return null;
  }
}

export function rememberInvite(sessionId: string, invite: Invite) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(invite));
  } catch {
    // Private mode / blocked storage — the guest just gets asked again next time.
  }
}
