import { forgetMemory, getProfile, saveMemory } from './memory.tools';
import type { ToolContext } from './tool.types';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

const CLIENT = { id: 'c1', timezone: 'UTC', name: 'T', assistantName: 'A' } as never;

function ctxWith(memories: { key: string; value: string; category?: string }[]): {
  ctx: ToolContext;
  saved: { key: string; value: string; category?: string }[];
  deleted: string[];
} {
  const saved: { key: string; value: string; category?: string }[] = [];
  const deleted: string[] = [];
  const repo = {
    getMemories: jest.fn().mockResolvedValue(memories),
    saveMemory: jest.fn().mockImplementation((key: string, value: string, category?: string) => {
      saved.push({ key, value, category });
      return Promise.resolve({ key, value, category });
    }),
    deleteMemory: jest.fn().mockImplementation((key: string) => {
      deleted.push(key);
      return Promise.resolve(memories.some((m) => m.key === key));
    }),
  } as unknown as ClientScopedRepository;
  return { ctx: { repo, client: CLIENT, now: new Date() }, saved, deleted };
}

describe('memory tools — categorized, editable', () => {
  it('save_memory maps the category to the DB enum', async () => {
    const { ctx, saved } = ctxWith([]);
    await saveMemory.execute({ key: 'occupation', value: 'CEO', category: 'profile' }, ctx);
    expect(saved[0]).toEqual({ key: 'occupation', value: 'CEO', category: 'PROFILE' });
  });

  it('get_profile groups memories by category with headings', async () => {
    const { ctx } = ctxWith([
      { key: 'occupation', value: 'CEO', category: 'PROFILE' },
      { key: 'likes_mornings', value: 'true', category: 'PREFERENCE' },
    ]);
    const out = await getProfile.execute({}, ctx);
    expect(out).toContain('Profile:');
    expect(out).toContain('occupation: CEO');
    expect(out).toContain('Preferences:');
  });

  it('forget_memory deletes by key, and reports honestly when absent', async () => {
    const { ctx, deleted } = ctxWith([{ key: 'likes_mornings', value: 'true' }]);
    const ok = await forgetMemory.execute({ key: 'likes_mornings' }, ctx);
    expect(deleted).toEqual(['likes_mornings']);
    expect(ok).toContain('Forgotten');
    const missing = await forgetMemory.execute({ key: 'nope' }, ctx);
    expect(missing).toContain('ERROR');
  });
});
