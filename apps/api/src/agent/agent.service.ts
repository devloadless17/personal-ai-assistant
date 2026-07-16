import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import type { Client } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AnthropicService } from '../integrations/anthropic/anthropic.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { ALL_TOOLS } from '../tools';
import { toClaudeTool } from '../tools/tool.types';
import type { CalendarGateway, ToolContext, ToolDefinition } from '../tools/tool.types';
import { buildVolatilePrompt, STABLE_TEMPLATE } from './system-prompt';

/** Hard ceiling on tool-use round trips per client message. */
const MAX_TOOL_ITERATIONS = 8;
/** Conversation context: last N messages. */
const HISTORY_LIMIT = 30;

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
  'set_reminder_preference',
]);

/**
 * Detects when the assistant ASSERTS it just completed/committed an action.
 * Deliberately high-precision (first-person or leading-verb forms) so honest,
 * negated replies like "nothing was changed" or "you have nothing scheduled"
 * do NOT trigger it. Used only to catch a claimed change when NO mutating tool
 * ran — the last line of defence against a model-hallucinated confirmation.
 */
const COMPLETION_CLAIM = new RegExp(
  [
    // Sentence that STARTS with a completion verb: "Added …", "Booked …".
    "(^|[.!?]\\s+)(added|created|booked|scheduled|rescheduled|moved|updated|deleted|removed|cancell?ed|completed|done)\\b",
    // First-person claim: "I added", "I've booked", "I'll set", "I have scheduled".
    "\\bi(?:'ve| have| will|'ll)?\\s+(?:just\\s+)?(added|created|booked|scheduled|rescheduled|moved|updated|changed|deleted|removed|cancell?ed|completed|set|marked|saved|noted|remind)",
    // Reminder confirmations.
    "\\breminder(?:'?s)?\\s+(?:is\\s+|has\\s+been\\s+)?set\\b",
    "\\bi'?ll\\s+(?:remind|ping)\\s+you\\b",
  ].join("|"),
  "i",
);

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
 *    reply. The model can never emit a confirmation this code didn't produce,
 *    and every action is provable from the audit log.
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

    try {
      return await this.runLoop(system, messages, ctx);
    } catch (err) {
      // Honest failure — never pretend. Details go to logs, not the client.
      this.logger.error(
        `Agent loop failed for client ${client.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      return 'Sorry — that didn’t go through on my side. Nothing was changed. Please try again in a moment.';
    }
  }

  private async runLoop(
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
    ctx: ToolContext,
  ): Promise<string> {
    let successfulMutation = false;
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
          if (MUTATING_TOOLS.has(use.name) && block.is_error !== true) {
            successfulMutation = true;
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
      // core invariant BEHAVIOURALLY: if it claims a completed action but no
      // mutating tool actually ran this turn, force it to either do it or drop
      // the claim. One correction attempt, then we trust the corrected reply.
      const text = this.extractText(response);
      if (text && !successfulMutation && !corrected && COMPLETION_CLAIM.test(text)) {
        corrected = true;
        this.logger.warn(
          `Client ${ctx.client.id}: reply claimed an action with no tool call — forcing correction`,
        );
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content:
            'SYSTEM CHECK: your last message told me something was done, but you did not call any tool this turn, so nothing actually happened. If I asked you to add, update, schedule, remind, complete, or delete something, call the correct tool NOW to really do it. If nothing needed changing, reply again WITHOUT claiming any action was completed.',
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
      const parsed = tool.schema.safeParse(use.input);
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
