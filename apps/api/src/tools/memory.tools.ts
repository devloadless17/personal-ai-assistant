import { z } from 'zod';
import { defineTool } from './tool.types';
import { formatLeads } from './time';

const CATEGORY_LABEL: Record<string, string> = {
  PROFILE: 'Profile',
  PREFERENCE: 'Preferences',
  LONGTERM: 'Long-term',
};

export const getProfile = defineTool({
  name: 'get_profile',
  description:
    'Read everything remembered about this client (profile, preferences, standing facts), grouped by category. Call when a stored preference might change how you should act.',
  schema: z.object({}),
  async execute(_input, ctx) {
    const memories = await ctx.repo.getMemories();
    if (memories.length === 0) return 'No stored preferences or facts yet.';
    // Group by category so the model sees a clean profile / preferences / facts view.
    const order = ['PROFILE', 'PREFERENCE', 'LONGTERM'];
    const groups = new Map<string, string[]>();
    for (const m of memories) {
      const cat = (m as { category?: string }).category ?? 'LONGTERM';
      const arr = groups.get(cat) ?? [];
      arr.push(`  ${m.key}: ${m.value}`);
      groups.set(cat, arr);
    }
    return order
      .filter((c) => groups.has(c))
      .map((c) => `${CATEGORY_LABEL[c] ?? c}:\n${(groups.get(c) ?? []).join('\n')}`)
      .join('\n');
  },
});

export const saveMemory = defineTool({
  name: 'save_memory',
  description:
    'Durably remember a preference or fact about the client (e.g. "assistant_language: Arabic", "prefers_morning_meetings: true"). Use SPARINGLY — only when the client explicitly asks you to remember something, or states a genuinely durable, clearly important fact. Do not store passing chatter, one-off details, or anything uncertain. Overwrites the key if it exists. Use short snake_case keys. Set category: profile (who they are — job, location), preference (how they like things), or longterm (goals/projects/facts). For reminder lead time or the daily-summary hour, use set_reminder_preference instead.',
  schema: z.object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9_]+$/, 'snake_case key')
      .describe('Short snake_case identifier, e.g. "preferred_meeting_time".'),
    value: z.string().min(1).max(2000).describe('The fact/preference to remember.'),
    category: z
      .enum(['profile', 'preference', 'longterm'])
      .optional()
      .describe('profile = who they are; preference = how they like things; longterm = goals/facts. Default longterm.'),
  }),
  async execute(input, ctx) {
    const category = input.category
      ? (input.category.toUpperCase() as 'PROFILE' | 'PREFERENCE' | 'LONGTERM')
      : undefined;
    await ctx.repo.saveMemory(input.key, input.value, category);
    return `Remembered ${input.key}: ${input.value}`;
  },
});

export const forgetMemory = defineTool({
  name: 'forget_memory',
  description:
    'Forget a previously stored fact/preference by its key (e.g. the client says "forget that I like morning meetings"). Get keys from get_profile.',
  schema: z.object({
    key: z.string().min(1).max(100).describe('The snake_case key to remove.'),
  }),
  async execute(input, ctx) {
    const removed = await ctx.repo.deleteMemory(input.key);
    return removed ? `Forgotten: ${input.key}.` : `ERROR: no stored memory with key "${input.key}".`;
  },
});

export const setReminderPreference = defineTool({
  name: 'set_reminder_preference',
  description:
    'Update the client\'s standing preferences: their default meeting reminder lead times, the hour their daily summary is sent, and/or their default meeting length. Use when the client says things like "always remind me an hour and 10 minutes before", "just one reminder 15 min before", "send my morning summary at 8", or "my meetings are usually 2 hours".',
  schema: z.object({
    reminder_leads: z
      .array(z.number().int().min(0).max(10080))
      .max(5)
      .optional()
      .describe(
        'New default reminder lead times (minutes before a meeting) — the client gets ONE ping per value. "an hour and 10 min before" → [60, 10]; "just 15 min before" → [15]; "drop the hour one, keep 10 min" → [10]; "no automatic reminders" → []. Sets the WHOLE list (replaces the old one).',
      ),
    daily_summary_hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .describe(
        "Hour (0–23, 24-hour, the client's local time) to send the daily summary. CONVERT AM/PM correctly: 8am=8, noon=12, 11pm=23, midnight=0. If the client gives a bare hour with no am/pm (e.g. 'at 11'), briefly confirm morning vs evening before setting it.",
      ),
    default_meeting_minutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .optional()
      .describe(
        'New default meeting/event length in minutes, applied when the client names only a start time. E.g. "my meetings are 2 hours" → 120. A single event can still be shorter/longer when the client says so.',
      ),
  }),
  async execute(input, ctx) {
    const parts: string[] = [];
    if (input.reminder_leads !== undefined) {
      await ctx.repo.setReminderLeads(input.reminder_leads);
      // Mutate in-turn so a same-message "remind me 1h & 10m before, book a
      // meeting at 3pm" applies the new defaults to the event created this turn.
      const clean = Array.from(
        new Set(input.reminder_leads.filter((n) => Number.isInteger(n) && n > 0)),
      ).sort((a, b) => b - a);
      ctx.client.reminderLeads = clean;
      parts.push(
        clean.length === 0
          ? 'no automatic meeting reminders'
          : `meeting reminders ${formatLeads(clean)} before`,
      );
    }
    if (input.daily_summary_hour !== undefined) {
      await ctx.repo.setDailyBriefHour(input.daily_summary_hour);
      parts.push(`daily summary at ${input.daily_summary_hour}:00`);
    }
    if (input.default_meeting_minutes !== undefined) {
      await ctx.repo.setDefaultMeetingMinutes(input.default_meeting_minutes);
      // Mutate in-turn so a same-message "my meetings are 2h, book one at 3pm"
      // uses the new default when the event is created later this turn.
      ctx.client.defaultMeetingMinutes = input.default_meeting_minutes;
      parts.push(`default meeting length ${input.default_meeting_minutes} min`);
    }
    if (parts.length === 0) return 'ERROR: no preference provided. Nothing changed.';
    return `Preferences updated: ${parts.join(', ')}.`;
  },
});
