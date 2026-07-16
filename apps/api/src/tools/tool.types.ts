import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@prisma/client';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

/**
 * Everything a tool may touch. Tools receive a tenant-scoped repository —
 * never a raw Prisma client — so cross-tenant access is impossible to
 * express. Integration gateways (calendar, …) are injected per-request and
 * are already bound to this client's credentials.
 */
export interface ToolContext {
  repo: ClientScopedRepository;
  client: Client;
  now: Date;
  /** Google Calendar gateway — present once the client has connected Google. */
  calendar?: CalendarGateway;
}

/** Calendar operations the tools may perform (implemented in Milestone 4). */
export interface CalendarGateway {
  listEvents(params: { from: Date; to: Date; limit?: number }): Promise<CalendarEvent[]>;
  createEvent(params: {
    title: string;
    start: Date;
    end: Date;
    description?: string;
    location?: string;
  }): Promise<CalendarEvent>;
  updateEvent(
    eventId: string,
    params: Partial<{
      title: string;
      start: Date;
      end: Date;
      description: string;
      location: string;
    }>,
  ): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
  /** Events overlapping [start, end) — conflict checking before create/move. */
  findConflicts(start: Date, end: Date, excludeEventId?: string): Promise<CalendarEvent[]>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  description?: string;
  location?: string;
}

/**
 * A tool = one file exporting a ToolDefinition. The zod schema is the single
 * source of truth: it validates the model's input at the boundary AND
 * generates the JSON schema sent to Claude. `execute` returns a plain,
 * human-readable string the model can quote; it may include internal ids
 * (the system prompt forbids showing them to the client).
 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** Output type is TInput; wire input is unknown (zod transforms allowed). */
  schema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  execute(input: TInput, ctx: ToolContext): Promise<string>;
}

export function defineTool<TInput>(def: ToolDefinition<TInput>): ToolDefinition<TInput> {
  return def;
}

// Call through a simplified signature: zod-to-json-schema's generics blow the
// TS instantiation-depth limit on transform-heavy schemas (TS2589).
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: z.ZodTypeAny,
  options: { target: 'jsonSchema7' },
) => Record<string, unknown>;

/** Claude `tools` array entry for a definition. */
export function toClaudeTool(def: ToolDefinition<never>): Anthropic.Tool {
  const json = toJsonSchema(def.schema as z.ZodTypeAny, { target: 'jsonSchema7' });
  delete json.$schema;
  return {
    name: def.name,
    description: def.description,
    input_schema: json as unknown as Anthropic.Tool.InputSchema,
  };
}
