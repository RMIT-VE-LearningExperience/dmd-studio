"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

type Props = {
  sessionId: string;
  compact?: boolean;
};

export default function SessionInviteLinks({ sessionId, compact = false }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const links = [
    { key: "guest", label: "Guest", url: `${origin}/session/${sessionId}?role=guest` },
    { key: "producer", label: "Producer", url: `${origin}/session/${sessionId}?role=producer` },
  ];

  const copy = async (key: string, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {links.map((link) => (
        <button
          key={link.key}
          type="button"
          onClick={() => copy(link.key, link.url)}
          className={`flex items-center gap-1.5 rounded-full border border-neutral-700 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white ${
            compact ? "px-2.5 py-1" : "px-3 py-1.5"
          }`}
        >
          {copied === link.key ? (
            <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" strokeWidth={1.8} />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3 text-neutral-500" strokeWidth={1.8} />
          )}
          {copied === link.key ? "Copied" : link.label}
        </button>
      ))}
    </div>
  );
}
