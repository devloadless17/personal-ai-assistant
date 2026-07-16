import { z } from 'zod';
import { defineTool } from './tool.types';

export const getProfile = defineTool({
  name: 'get_profile',
  description:
    'Read everything remembered about this client (preferences, facts, standing instructions). Call when a stored preference might change how you should act.',
  schema: z.object({}),
  async execute(_input, ctx) {
    const memories = await ctx.repo.getMemories();
    if (memories.length === 0) return 'No stored preferences or facts yet.';
    return memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  },
});

export const saveMemory = defineTool({
  name: 'save_memory',
  description:
    'Durably remember a preference or fact about the client (e.g. "assistant_language: Arabic", "prefers_morning_meetings: true"). Overwrites the key if it exists. Use short snake_case keys. For reminder lead time or the daily-summary hour, use set_reminder_preference instead.',
  schema: z.object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9_]+$/, 'snake_case key')
      .describe('Short snake_case identifier, e.g. "preferred_meeting_time".'),
    value: z.string().min(1).max(2000).describe('The fact/preference to remember.'),
  }),
  async execute(input, ctx) {
    await ctx.repo.saveMemory(input.key, input.value);
    return `Remembered ${input.key}: ${input.value}`;
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
      .describe("Hour (0–23, the client's local time) to send the daily summary."),
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
