"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/calendar", label: "Calendar" },
  { href: "/projects", label: "Projects" },
];

// Top navigation for the host-facing pages. The studio itself stays
// full-screen without it.
export default function AppNav({ user }: { user: User | null }) {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-8 py-3">
        <Link href="/" className="text-sm font-bold tracking-tight text-neutral-100">
          DMD <span className="text-indigo-400">Studio</span>
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                pathname === link.href
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
        {user && (
          <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
            <span className="hidden sm:inline">{user.displayName ?? user.email ?? "Signed in"}</span>
            <button onClick={() => signOut(auth)} className="underline hover:text-neutral-300">
              Sign out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
