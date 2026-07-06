"use client";

import { useState } from "react";
import { Timestamp } from "firebase/firestore";

export type CalendarEntry = {
  id: string;
  title: string;
  scheduledAt: Timestamp;
  durationMinutes?: number | null;
};

type Props = {
  entries: CalendarEntry[];
  onOpen: (id: string) => void;
  onCreate: (date: Date) => void;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Six fixed weeks starting on the Monday on/before the 1st — enough to show
// any month without layout shift between months.
function gridDays(monthStart: Date): Date[] {
  const first = new Date(monthStart);
  const offset = (first.getDay() + 6) % 7; // Monday-based
  first.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export default function PlannerCalendar({ entries, onOpen, onCreate }: Props) {
  const [monthStart, setMonthStart] = useState(() => startOfMonth(new Date()));
  const today = new Date();

  const shiftMonth = (delta: number) =>
    setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  const monthLabel = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-300">Recording planner</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftMonth(-1)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-700 text-xs text-neutral-300 transition hover:border-neutral-500"
            title="Previous month"
          >
            ‹
          </button>
          <span className="w-36 text-center text-xs font-medium text-neutral-300">{monthLabel}</span>
          <button
            onClick={() => shiftMonth(1)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-700 text-xs text-neutral-300 transition hover:border-neutral-500"
            title="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-800">
        <div className="grid grid-cols-7 border-b border-neutral-800 bg-neutral-900">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {gridDays(monthStart).map((day) => {
            const inMonth = day.getMonth() === monthStart.getMonth();
            const isToday = sameDay(day, today);
            const dayEntries = entries
              .filter((e) => sameDay(e.scheduledAt.toDate(), day))
              .sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis());

            return (
              <div
                key={day.toISOString()}
                onClick={() => onCreate(day)}
                title="Click to plan a recording on this day"
                className={`group flex min-h-20 cursor-pointer flex-col gap-1 border-b border-r border-neutral-800/60 p-1.5 transition hover:bg-neutral-900 ${
                  inMonth ? "" : "opacity-40"
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                    isToday ? "bg-indigo-600 text-white" : "text-neutral-500"
                  }`}
                >
                  {day.getDate()}
                </span>
                {dayEntries.map((e) => (
                  <button
                    key={e.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpen(e.id);
                    }}
                    className="truncate rounded-md bg-indigo-600/20 px-1.5 py-0.5 text-left text-[10px] font-medium text-indigo-300 transition hover:bg-indigo-600/40"
                    title={`${e.title} · ${e.scheduledAt.toDate().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${e.durationMinutes ? ` · ${e.durationMinutes} min` : ""}`}
                  >
                    {e.scheduledAt
                      .toDate()
                      .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}{" "}
                    {e.title}
                    {e.durationMinutes ? ` (${e.durationMinutes}m)` : ""}
                  </button>
                ))}
                <span className="hidden text-[10px] text-neutral-600 group-hover:block">+ plan</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
