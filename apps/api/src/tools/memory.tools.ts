import { z } from 'zod';
import { defineTool } from './tool.types';

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
    'Update the client\'s standing preferences: their default reminder lead time (minutes before a task is due) and/or the hour their daily summary is sent. Use when the client says things like "always remind me 30 minutes before" or "send my morning summary at 8".',
  schema: z.object({
    default_reminder_minutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .optional()
      .describe('New default reminder lead time in minutes (0 = no automatic reminders).'),
    daily_summary_hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .describe(
        "Hour (0–23, 24-hour, the client's local time) to send the daily summary. CONVERT AM/PM correctly: 8am=8, noon=12, 11pm=23, midnight=0. If the client gives a bare hour with no am/pm (e.g. 'at 11'), briefly confirm morning vs evening before setting it.",
      ),
  }),
  async execute(input, ctx) {
    const parts: string[] = [];
    if (input.default_reminder_minutes !== undefined) {
      await ctx.repo.setDefaultReminderMinutes(input.default_reminder_minutes);
      parts.push(
        input.default_reminder_minutes === 0
          ? 'no automatic reminders'
          : `reminders ${input.default_reminder_minutes} min before due`,
      );
    }
    if (input.daily_summary_hour !== undefined) {
      await ctx.repo.setDailyBriefHour(input.daily_summary_hour);
      parts.push(`daily summary at ${input.daily_summary_hour}:00`);
    }
    if (parts.length === 0) return 'ERROR: no preference provided. Nothing changed.';
    return `Preferences updated: ${parts.join(', ')}.`;
  },
});
