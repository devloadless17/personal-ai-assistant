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
    'Durably remember a preference or fact about the client (e.g. "meeting_length_default: 30min", "assistant_language: Arabic"). Overwrites the key if it exists. Use short snake_case keys.',
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
