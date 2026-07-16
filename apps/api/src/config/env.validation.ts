import { z } from 'zod';

/**
 * Environment schema — validated once at boot. The app refuses to start if a
 * required variable is missing or malformed, so misconfiguration is caught at
 * deploy time, never at request time.
 *
 * Keys needed by later milestones (Anthropic, Google, admin alerts) are
 * optional here and become required by the modules that consume them.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a postgresql:// connection string',
    }),

  // 32-byte hex key for AES-256-GCM encryption of per-client secrets at rest.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars (openssl rand -hex 32)'),

  // Milestone 2+
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  // Milestone 4+
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Milestone 5+
  ADMIN_ALERT_BOT_TOKEN: z.string().optional(),
  ADMIN_ALERT_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  // Empty strings in .env files mean "not set" (e.g. `GOOGLE_CLIENT_ID=`) —
  // normalize them to undefined so optional keys stay optional and required
  // keys still fail with a clear "Required"/min-length message.
  const normalized = Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const result = envSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
