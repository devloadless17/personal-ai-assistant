import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@prisma/client';
import { AgentService } from './agent.service';
import type { AnthropicService } from '../integrations/anthropic/anthropic.service';
import type { TenancyService } from '../tenancy/tenancy.service';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

/**
 * Invariant tests for the app-owned tool loop. The Anthropic client is faked;
 * the repository is an in-memory fake that records every audit write — so we
 * can prove structurally that:
 *   1. a tool_use from the model → OUR code executes → audit row → real result
 *      fed back;
 *   2. failures produce is_error results + success:false audit rows, never
 *      silent lies;
 *   3. the reply is exactly the model's end_turn text (grounded in results);
 *   4. a runaway model hits the iteration ceiling with an honest message.
 */

const CLIENT: Client = {
  id: 'client-1',
  name: 'Test Client',
  status: 'active',
  timezone: 'UTC',
  assistantName: 'Aya',
  telegramBotTokenEnc: null,
  telegramChatId: null,
  telegramWebhookSecretEnc: null,
  googleOAuthEnc: null,
  googleNeedsReauth: false,
  dailyBriefHour: 7,
  lastBriefDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface FakeRepo {
  audits: { toolName: string; result: unknown; success: boolean }[];
  tasks: { id: string; title: string; status: string }[];
}

function makeFakeRepo(): { repo: ClientScopedRepository; state: FakeRepo } {
  const state: FakeRepo = { audits: [], tasks: [] };
  const repo = {
    clientId: CLIENT.id,
    recentMessages: jest
      .fn()
      .mockResolvedValue([
        { direction: 'inbound', content: 'add a task to buy milk', createdAt: new Date() },
      ]),
    getMemories: jest.fn().mockResolvedValue([]),
    writeAudit: jest.fn().mockImplementation((entry: FakeRepo['audits'][number]) => {
      state.audits.push(entry);
      return Promise.resolve(entry);
    }),
    createTask: jest.fn().mockImplementation((data: { title: string }) => {
      const task = {
        id: `task-${state.tasks.length + 1}`,
        title: data.title,
        type: 'task',
        status: 'open',
        dueAt: null,
        reminderAt: null,
        reminderSent: false,
        notes: null,
        clientId: CLIENT.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.tasks.push(task);
      return Promise.resolve(task);
    }),
    updateTask: jest.fn().mockResolvedValue(null), // "not found" by default
    findTasks: jest.fn().mockResolvedValue({ tasks: [], more: 0 }),
    findTaskById: jest.fn().mockResolvedValue(null),
  } as unknown as ClientScopedRepository;
  return { repo, state };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text, citations: [] }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function toolUseResponse(
  name: string,
  input: unknown,
  id = 'toolu_1',
): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function makeAgent(
  responses: Anthropic.Message[],
  repo: ClientScopedRepository,
): { agent: AgentService; createMessage: jest.Mock<Promise<Anthropic.Message>, unknown[]> } {
  const createMessage = jest.fn<Promise<Anthropic.Message>, unknown[]>();
  for (const r of responses) createMessage.mockResolvedValueOnce(r);
  const anthropic = {
    isConfigured: true,
    model: 'claude-opus-4-8',
    createMessage,
  } as unknown as AnthropicService;
  const tenancy = { repoFor: () => repo } as unknown as TenancyService;
  return { agent: new AgentService(anthropic, tenancy), createMessage };
}

describe('AgentService — reliability invariants', () => {
  it('executes a real tool for a tool_use, audits it, and feeds the real result back', async () => {
    const { repo, state } = makeFakeRepo();
    const { agent, createMessage } = makeAgent(
      [
        toolUseResponse('create_task', { title: 'buy milk' }),
        textResponse('Added "buy milk" to your tasks.'),
      ],
      repo,
    );

    const reply = await agent.respond(CLIENT);

    // The REAL tool ran (task exists) and was audited as success.
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.title).toBe('buy milk');
    expect(state.audits).toEqual([
      expect.objectContaining({ toolName: 'create_task', success: true }),
    ]);
    // The actual tool result text was fed back to the model.
    const secondCall = createMessage.mock.calls[1]?.[0] as {
      messages: Anthropic.MessageParam[];
    };
    const toolResultTurn = secondCall.messages[secondCall.messages.length - 1];
    expect(JSON.stringify(toolResultTurn?.content)).toContain('Created:');
    expect(reply).toBe('Added "buy milk" to your tasks.');
  });

  it('a failing tool produces is_error + success:false audit — and the loop continues honestly', async () => {
    const { repo, state } = makeFakeRepo();
    // update_task on a nonexistent id → tool returns ERROR text.
    const { agent, createMessage } = makeAgent(
      [
        toolUseResponse('update_task', { task_id: 'nope', title: 'x' }),
        textResponse('I couldn’t find that task, so nothing was changed.'),
      ],
      repo,
    );

    const reply = await agent.respond(CLIENT);

    expect(state.audits).toEqual([
      expect.objectContaining({ toolName: 'update_task', success: false }),
    ]);
    const secondCall = createMessage.mock.calls[1]?.[0] as {
      messages: Anthropic.MessageParam[];
    };
    const resultBlock = (
      secondCall.messages[secondCall.messages.length - 1]?.content as Anthropic.ToolResultBlockParam[]
    )[0];
    expect(resultBlock?.is_error).toBe(true);
    expect(reply).toContain('nothing was changed');
  });

  it('schema-invalid tool input is rejected at the boundary, audited as failure, and never executes', async () => {
    const { repo, state } = makeFakeRepo();
    const { agent } = makeAgent(
      [
        toolUseResponse('create_task', { title: '' }), // violates min(1)
        textResponse('That didn’t work.'),
      ],
      repo,
    );

    await agent.respond(CLIENT);

    expect(state.tasks).toHaveLength(0); // execute() never ran
    expect(state.audits).toEqual([
      expect.objectContaining({ toolName: 'create_task', success: false }),
    ]);
  });

  it('unknown tool names are audited and errored, not silently dropped', async () => {
    const { repo, state } = makeFakeRepo();
    const { agent } = makeAgent(
      [toolUseResponse('send_email', { to: 'x' }), textResponse('I can’t send emails yet.')],
      repo,
    );

    await agent.respond(CLIENT);
    expect(state.audits).toEqual([
      expect.objectContaining({ toolName: 'send_email', success: false }),
    ]);
  });

  it('a runaway model stops at the iteration ceiling with an honest message', async () => {
    const { repo } = makeFakeRepo();
    const endless = Array.from({ length: 10 }, (_, i) =>
      toolUseResponse('get_tasks', {}, `toolu_${i}`),
    );
    const { agent, createMessage } = makeAgent(endless, repo);

    const reply = await agent.respond(CLIENT);
    expect(createMessage).toHaveBeenCalledTimes(8); // MAX_TOOL_ITERATIONS
    expect(reply).toContain('stopped safely');
  });

  it('calendar tools answer honestly when Google is not connected', async () => {
    const { repo, state } = makeFakeRepo();
    const { agent, createMessage } = makeAgent(
      [
        toolUseResponse('get_calendar_events', {
          from: '2026-07-16T00:00:00Z',
          to: '2026-07-17T00:00:00Z',
        }),
        textResponse('Your calendar isn’t connected yet.'),
      ],
      repo,
    );

    await agent.respond(CLIENT);
    expect(state.audits[0]).toEqual(
      expect.objectContaining({ toolName: 'get_calendar_events', success: false }),
    );
    const secondCall = createMessage.mock.calls[1]?.[0] as {
      messages: Anthropic.MessageParam[];
    };
    expect(JSON.stringify(secondCall.messages)).toContain('not connected');
  });

  it('anthropic API failure returns an honest error, never a fake success', async () => {
    const { repo } = makeFakeRepo();
    const createMessage = jest.fn().mockRejectedValue(new Error('529 overloaded'));
    const anthropic = {
      isConfigured: true,
      model: 'claude-opus-4-8',
      createMessage,
    } as unknown as AnthropicService;
    const tenancy = { repoFor: () => repo } as unknown as TenancyService;
    const agent = new AgentService(anthropic, tenancy);

    const reply = await agent.respond(CLIENT);
    expect(reply).toContain('didn’t go through');
    expect(reply).toContain('Nothing was changed');
  });
});
