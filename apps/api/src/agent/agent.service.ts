import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import type { Client } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AnthropicService } from '../integrations/anthropic/anthropic.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { ALL_TOOLS } from '../tools';
import { toClaudeTool } from '../tools/tool.types';
import type { CalendarGateway, ToolContext, ToolDefinition } from '../tools/tool.types';
import { isOffsetlessIso, withClientOffset } from '../tools/time';
import { buildVolatilePrompt, STABLE_TEMPLATE } from './system-prompt';

/** Hard ceiling on tool-use round trips per client message. */
const MAX_TOOL_ITERATIONS = 8;
/** Conversation context: last N messages. */
const HISTORY_LIMIT = 12;

/**
 * Tools that CHANGE data. A reply claiming a completed action is only
 * truthful if one of these ran successfully this turn.
 */
const MUTATING_TOOLS = new Set<string>([
  'create_task',
  'update_task',
  'complete_task',
  'delete_task',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'save_memory',
  'forget_memory',
  'set_reminder_preference',
]);

/**
 * Detects when the assistant ASSERTS it just completed/committed an action.
 * Deliberately high-precision (only the very start of the reply, or explicit
 * first-person/impersonal completion phrasing) so honest, negated replies like
 * "nothing was changed", "you have nothing scheduled", or a listing like
 * "1. Booked venue — 5pm" do NOT trigger it. Used to catch a claimed change
 * when the real work didn't happen — the last line of defence against a
 * model-hallucinated confirmation.
 */
const COMPLETION_CLAIM = new RegExp(
  [
    // Reply that OPENS with a completion verb: "Added …", "Booked …", "Done —".
    "^\\s*(added|created|booked|scheduled|rescheduled|moved|updated|deleted|removed|cancell?ed|completed|done|set|marked|saved)\\b",
    // "All done", "All set", "You're all set/booked" as a standalone confirmation.
    "\\b(all (done|set)|you'?re all (set|booked))\\b",
    // First-person claim of a DONE action: "I added", "I've booked", "I have
    // put", "I just set". NOTE: only past / present-perfect — NOT future
    // ("I'll set it up", "I will add that" are intentions after asking a
    // question, not completions). "I'll remind/ping you" is handled separately.
    "\\bi(?:'ve| have)?\\s+(?:just\\s+)?(added|created|booked|scheduled|rescheduled|moved|updated|changed|deleted|removed|cancell?ed|completed|set|marked|saved|noted|put|arranged|confirmed|logged)\\b",
    // "Got it — reminder for 9:30" style.
    "\\bgot it\\b[\\s\\S]{0,40}\\bremind",
    // Impersonal confirmations ("now" optional): "is scheduled", "is/it's on your calendar", "is confirmed".
    "\\breminder(?:'?s)?\\s+(?:is\\s+|has\\s+been\\s+)?set\\b",
    "\\bi'?ll\\s+(?:remind|ping)\\s+you\\b",
    "\\b(is|it'?s)\\s+(?:now\\s+)?(on (?:your|the) calendar|scheduled|booked|set|confirmed|in your (tasks|list))\\b",
  ].join("|"),
  "i",
);

/**
 * Marks an honest acknowledgement of failure / no-op / read-only answer, so a
 * partial-failure reply ("Added A but couldn't delete B") or an honest
 * availability answer ("you're all set — nothing booked") is NOT flagged as a
 * fabrication. Consulted for EVERY completion-claim check.
 */
const FAILURE_ACK =
  /\b(couldn'?t|could not|can'?t|cannot|didn'?t|did not|wasn'?t|was not|unable|failed|no changes|nothing (was|to|booked|scheduled|planned|due|on)|not able|didn'?t go through|you'?re free|you have nothing|already (done|set|scheduled|booked))\b/i;

/** Tool-input keys whose values are datetimes (the only fields we anchor). */
const DATETIME_KEYS = new Set(['due_at', 'reminder_at', 'start', 'end', 'from', 'to', 'until']);

/**
 * Rewrite offset-less ISO datetimes in tool input to carry the client
 * timezone's offset — but ONLY for keys known to be datetime fields. Anchoring
 * by KEY (not by string shape) is essential: a task titled or noted "2026-01-01"
 * is a date-shaped string that must be left exactly as typed, not rewritten
 * into a timestamp. Free-text fields therefore always pass through untouched.
 */
function anchorDateTimes(value: unknown, timeZone: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => anchorDateTimes(v, timeZone));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && DATETIME_KEYS.has(k) && isOffsetlessIso(v)) {
      out[k] = withClientOffset(v, timeZone);
    } else {
      out[k] = anchorDateTimes(v, timeZone);
    }
  }
  return out;
}

export interface CalendarGatewayFactory {
  /** Returns a gateway bound to this client's Google credentials, or null if not connected. */
  forClient(client: Client): Promise<CalendarGateway | null>;
}

/**
 * THE reliability core: the app-owned tool loop.
 *
 * 1. Send the client's message (with history + system prompt) to Claude with
 *    the tool schemas.
 * 2. While Claude requests tools: OUR code validates the input (zod),
 *    executes the REAL tool against tenant-scoped data, writes an audit row,
 *    and feeds the actual result back (is_error on failure).
 * 3. Only when Claude stops requesting tools is its final text used as the
 *    reply. Every tool EFFECT is real and provable from the audit log; the
 *    reply text itself is additionally guarded by a completion-claim check
 *    (see COMPLETION_CLAIM) that forces a correction if the model asserts an
 *    action no successful mutation this turn backs up.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly toolByName = new Map<string, ToolDefinition<never>>(
    ALL_TOOLS.map((t) => [t.name, t]),
  );
  private readonly claudeTools = ALL_TOOLS.map(toClaudeTool);
  /** Set by the Google module (M4); null-safe before that. */
  calendarFactory: CalendarGatewayFactory | null = null;

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly tenancy: TenancyService,
  ) {}

  /**
   * Handles one inbound client message end-to-end and returns the reply text.
   * PRECONDITION: the inbound message has already been persisted (it arrives
   * as the last entry of the loaded history).
   */
  async respond(client: Client): Promise<string> {
    const repo = this.tenancy.repoFor(client.id);

    if (!this.anthropic.isConfigured) {
      return 'I can’t answer right now — my AI service isn’t configured yet. Please contact your administrator.';
    }

    const [history, memories, calendar] = await Promise.all([
      repo.recentMessages(HISTORY_LIMIT),
      repo.getMemories(),
      this.calendarFactory?.forClient(client) ?? Promise.resolve(null),
    ]);

    const now = new Date();
    const ctx: ToolContext = { repo, client, now, calendar: calendar ?? undefined };

    // Stable prefix carries the cache breakpoint; volatile context comes after.
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: STABLE_TEMPLATE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: buildVolatilePrompt(client, memories, now) },
    ];

    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    }));
    if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
      // Defensive: the loop requires a trailing user turn.
      this.logger.error(`respond() called for client ${client.id} without a trailing inbound message`);
      return 'Something went wrong on my side — please send that again.';
    }

    // Tracks whether any real mutation succeeded, so the error path below never
    // claims "nothing was changed" when something actually did.
    const outcome = { mutated: false };
    try {
      return await this.runLoop(system, messages, ctx, outcome);
    } catch (err) {
      // Honest failure — never pretend. Details go to logs, not the client.
      this.logger.error(
        `Agent loop failed for client ${client.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // If a mutation already succeeded before the error, DON'T say "nothing was
      // changed" (false) and don't invite a blind retry that would duplicate it.
      return outcome.mutated
        ? 'I hit a problem partway through, so I may have only done part of that. Please check before sending it again, so nothing gets duplicated.'
        : 'Sorry — that didn’t go through on my side. Nothing was changed. Please try again in a moment.';
    }
  }

  private async runLoop(
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
    ctx: ToolContext,
    outcome: { mutated: boolean },
  ): Promise<string> {
    let successfulMutation = false;
    let mutationError = false;
    let anyToolRan = false;
    let corrected = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.anthropic.createMessage({
        system,
        tools: this.claudeTools,
        messages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        // Echo the assistant turn (thinking blocks included, unchanged).
        messages.push({ role: 'assistant', content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const block = await this.executeTool(use, ctx);
          results.push(block);
          anyToolRan = true;
          if (MUTATING_TOOLS.has(use.name)) {
            if (block.is_error === true) mutationError = true;
            else {
              successfulMutation = true;
              outcome.mutated = true;
            }
          }
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      if (response.stop_reason === 'refusal') {
        return 'I can’t help with that request.';
      }
      if (response.stop_reason === 'max_tokens') {
        this.logger.warn(`max_tokens hit for client ${ctx.client.id}`);
        return (
          this.extractText(response) ||
          'My answer got cut off — could you ask that again, maybe in smaller parts?'
        );
      }

      // end_turn: the model is done. Before trusting the reply, enforce the
      // core invariant BEHAVIOURALLY. Force a correction when the reply claims
      // a completed action but the real work didn't happen:
      //   (a) NO mutating tool succeeded this turn, or
      //   (b) a mutating tool ERRORED and the reply doesn't own up to it
      //       (catches "Added A and deleted B" when B failed).
      const text = this.extractText(response);
      const claimsCompletion = text ? COMPLETION_CLAIM.test(text) : false;
      // A turn where ONLY read tools ran (no mutation attempted) is a status /
      // read-back answer ("yes, your reminder IS set for 9:30") grounded in that
      // read — never force a correction on it, or we'd push a duplicate mutation.
      const mutationAttempted = successfulMutation || mutationError;
      const readOnlyTurn = anyToolRan && !mutationAttempted;
      // An honest failure/no-op/availability acknowledgement also exempts the
      // reply. Correction fires only when the reply claims a completed action
      // that a real mutation this turn didn't back up.
      const fabricated =
        claimsCompletion &&
        !FAILURE_ACK.test(text) &&
        !readOnlyTurn &&
        (!successfulMutation || mutationError);
      if (text && fabricated && !corrected) {
        corrected = true;
        iteration--; // don't charge the correction against the tool budget
        this.logger.warn(
          `Client ${ctx.client.id}: reply claimed an action that didn't fully happen — forcing correction`,
        );
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content:
            "SYSTEM CHECK (internal — the client must NEVER see this note or any mention of it): your last reply implied an action was already completed, but no tool actually performed it this turn. Decide what's true and reply to the CLIENT naturally: if the action can be done now, call the correct tool and then confirm; if you were only ASKING for information (e.g. a missing time), just ask that question naturally; if it truly couldn't be done, say so plainly. Never write meta-commentary like \"I didn't claim anything\" — just respond as the assistant.",
        });
        continue;
      }

      if (text) return text;
      return 'I didn’t produce a reply — please try again.';
    }

    this.logger.warn(`Tool-iteration ceiling reached for client ${ctx.client.id}`);
    return 'That request needed more steps than I allow in one go, so I stopped safely. What I completed is recorded; please break the request into smaller parts.';
  }

  /**
   * Validate → execute → AUDIT → tool_result. The audit write sits INSIDE
   * this method so no tool call can ever bypass it.
   */
  private async executeTool(
    use: Anthropic.ToolUseBlock,
    ctx: ToolContext,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = this.toolByName.get(use.name);
    const rawInput = use.input as Prisma.InputJsonValue;

    let resultText: string;
    let success: boolean;

    if (!tool) {
      resultText = `ERROR: unknown tool "${use.name}".`;
      success = false;
    } else {
      // TIMEZONE GUARANTEE: anchor every offset-less datetime the model sent to
      // THIS client's timezone before the tool sees it, so "9:30" from a Beirut
      // client is 9:30 in Beirut — never 9:30 on the UTC server. One choke
      // point covers every current and future time field.
      const input = anchorDateTimes(use.input, ctx.client.timezone);
      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        resultText = `ERROR: invalid input for ${use.name}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}. Nothing was changed.`;
        success = false;
      } else {
        try {
          resultText = await tool.execute(parsed.data, ctx);
          // Tools signal domain failures with an ERROR:/CONFLICT prefix.
          success = !resultText.startsWith('ERROR:') && !resultText.startsWith('CONFLICT');
        } catch (err) {
          this.logger.error(
            `Tool ${use.name} threw for client ${ctx.client.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
          );
          resultText = `ERROR: ${use.name} failed to execute. Nothing can be assumed about its effect — tell the client this didn't go through.`;
          success = false;
        }
      }
    }

    await ctx.repo.writeAudit({
      toolName: use.name,
      input: rawInput,
      result: resultText,
      success,
    });

    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: resultText,
      is_error: !success,
    };
  }

  private extractText(response: Anthropic.Message): string {
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
}
