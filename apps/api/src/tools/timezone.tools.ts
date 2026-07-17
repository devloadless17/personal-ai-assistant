import { z } from 'zod';
import { defineTool } from './tool.types';
import { formatInTz, isValidTimezone } from './time';

/**
 * Conversational timezone control. The client tells the assistant where they are
 * ("I'm in Tokyo now", "back home", "keep me on Beirut time") and this updates
 * their CURRENT effective zone — everything (brief, reminders, scheduling,
 * display) follows it immediately. Mutates ctx.client in place so a same-turn
 * "I'm in Tokyo, remind me at 9am" anchors 9am to Tokyo.
 */
export const setTimezone = defineTool({
  name: 'set_timezone',
  description:
    'Set the client\'s CURRENT timezone when THEY indicate their own location changed ("I\'m in Tokyo now", "just landed in London", "back home in Beirut") — NOT when they merely mention a place ("book a flight to Dubai"). Pass a valid IANA zone (e.g. "Asia/Tokyo", "Europe/London"). Use set_as_home when they say a place is their new home base. Use pin=true for "keep me on <home> time while I travel" and unpin=true for "follow my location again". If the place is ambiguous (e.g. just "the US"), ask which city first instead of guessing.',
  schema: z.object({
    timezone: z
      .string()
      .min(1)
      .describe('IANA timezone for where the client now is, e.g. "Asia/Tokyo", "America/New_York".'),
    set_as_home: z
      .boolean()
      .optional()
      .describe('True when this becomes the client\'s home base ("I moved to Dubai for good").'),
    pin: z
      .boolean()
      .optional()
      .describe('True for "keep me on this/home time" — stops automatic location following.'),
    unpin: z.boolean().optional().describe('True for "follow my location again" — resumes auto-sync.'),
  }),
  async execute(input, ctx) {
    if (!isValidTimezone(input.timezone)) {
      return `ERROR: "${input.timezone}" isn't a recognized timezone. Ask the client which city they're in and try a valid IANA zone. Nothing was changed.`;
    }

    await ctx.repo.setTimezone(input.timezone, { setAsHome: input.set_as_home });
    // Mutate in-turn so anchorDateTimes + event stamping this turn use the new zone.
    ctx.client.timezone = input.timezone;
    ctx.client.timezoneSource = 'manual';
    if (input.set_as_home) ctx.client.homeTimezone = input.timezone;

    if (input.pin === true) {
      await ctx.repo.setTimezonePinned(true);
      ctx.client.timezonePinned = true;
    } else if (input.unpin === true) {
      await ctx.repo.setTimezonePinned(false);
      ctx.client.timezonePinned = false;
    }

    const localNow = formatInTz(ctx.now, input.timezone);
    const pinNote = input.pin ? ' Pinned — I won\'t auto-change it.' : '';
    return `Timezone set to ${input.timezone} (local time now ${localNow}). Your brief, reminders and new scheduling follow this zone; already-booked events keep their original moment.${pinNote}`;
  },
});
