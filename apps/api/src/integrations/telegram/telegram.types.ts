import { z } from 'zod';

/** A Telegram file reference (voice note / audio). We only need the id + how
 * long it is; the actual bytes are fetched later via getFile + download. */
const telegramMediaSchema = z.object({
  file_id: z.string(),
  duration: z.number().int().nonnegative(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

/** The subset of a Telegram Update we consume. Everything else is ignored. */
export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      text: z.string().optional(),
      // Voice notes (OGG/Opus) and forwarded audio files — transcribed to text
      // before they reach the agent. Anything else stays unhandled.
      voice: telegramMediaSchema.optional(),
      audio: telegramMediaSchema.optional(),
      date: z.number().int(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
