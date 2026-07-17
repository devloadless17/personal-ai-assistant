"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MAX_REMINDERS = 5;

/** Parse the editor's string rows into clean minute values (positive ints). */
export function leadsToMinutes(leads: string[]): number[] {
  return leads
    .map((l) => Number(l))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** "60" → "1 hour", "10" → "10 min", "90" → "1h 30m", "1440" → "1 day". */
function formatLead(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} day${min > 1440 ? "s" : ""}`;
  if (min % 60 === 0) return `${min / 60} hour${min > 60 ? "s" : ""}`;
  if (min > 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min} min`;
}

function preview(leads: number[]): string {
  if (leads.length === 0) return "No reminders — the client won't be pinged before meetings.";
  const p = [...leads].sort((a, b) => b - a).map(formatLead);
  const list = p.length === 1 ? p[0] : `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
  return `Reminds ${list} before each meeting.`;
}

/**
 * Editor for a client's meeting reminder lead times (minutes before). Each row
 * is one Telegram ping; remove rows to have just one — or none. Controlled: the
 * parent owns `leads` (string[]) so it can submit them.
 */
export function ReminderLeadsEditor({
  leads,
  onChange,
  idPrefix,
}: {
  leads: string[];
  onChange: (leads: string[]) => void;
  idPrefix: string;
}) {
  const set = (i: number, v: string) => onChange(leads.map((l, j) => (j === i ? v : l)));
  const remove = (i: number) => onChange(leads.filter((_, j) => j !== i));
  const add = () => onChange([...leads, "10"]);

  return (
    <div className="space-y-2">
      <Label>Meeting reminders</Label>
      {leads.length === 0 && (
        <p className="text-sm text-muted-foreground">No reminders set.</p>
      )}
      <div className="space-y-2">
        {leads.map((lead, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-lead-${i}`}
              type="number"
              min={1}
              max={10080}
              value={lead}
              onChange={(e) => set(i, e.target.value)}
              className="w-24"
              aria-label={`Reminder ${i + 1} minutes before`}
            />
            <span className="text-sm text-muted-foreground">minutes before</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      {leads.length < MAX_REMINDERS && (
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + Add reminder
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{preview(leadsToMinutes(leads))}</p>
    </div>
  );
}
