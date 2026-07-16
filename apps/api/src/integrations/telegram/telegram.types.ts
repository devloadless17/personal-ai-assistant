import { z } from 'zod';

/** The subset of a Telegram Update we consume. Everything else is ignored. */
export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      text: z.string().optional(),
      date: z.number().int(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
