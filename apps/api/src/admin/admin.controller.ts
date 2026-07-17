import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type {
  AuditLogEntry,
  ClientSummary,
  ConversationMessage,
  Paginated,
} from '@assistant/shared';
import { JobsDiagnosticsService, type JobsDiagnostics } from '../jobs/jobs-diagnostics.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminClientsService } from './admin-clients.service';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

const createClientSchema = z.object({
  name: z.string().min(1).max(200),
  // 99% of clients are in Lebanon — default so the zone is never accidentally
  // left wrong; the admin can still override per client.
  timezone: z.string().min(1).default('Asia/Beirut'),
  assistantName: z.string().min(1).max(100).default('Assistant'),
  email: z.string().email().toLowerCase().optional(),
  reminderLeads: z.array(z.number().int().min(1).max(10080)).max(5).optional(),
  defaultMeetingMinutes: z.number().int().min(5).max(1440).optional(),
  dailyBriefHour: z.number().int().min(0).max(23).optional(),
});

const updateClientSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).optional(),
  assistantName: z.string().min(1).max(100).optional(),
  email: z.string().email().toLowerCase().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  reminderLeads: z.array(z.number().int().min(1).max(10080)).max(5).optional(),
  defaultMeetingMinutes: z.number().int().min(5).max(1440).optional(),
  dailyBriefHour: z.number().int().min(0).max(23).optional(),
});

const connectTelegramSchema = z.object({ botToken: z.string().min(20) });

@Controller('admin')
export class AdminController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly clients: AdminClientsService,
    private readonly diagnostics: JobsDiagnosticsService,
  ) {}

  /** Live background-job health — is the reminder cron ticking? backlog? */
  @UseGuards(AdminAuthGuard)
  @Get('diagnostics')
  async getDiagnostics(): Promise<JobsDiagnostics> {
    return this.diagnostics.get();
  }

  // Brute-force wall: 5 login attempts per minute per IP.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<{ token: string }> {
    const input = loginSchema.parse(body);
    return this.auth.login(input.email, input.password);
  }

  @UseGuards(AdminAuthGuard)
  @Get('clients')
  async list(): Promise<ClientSummary[]> {
    return this.clients.list();
  }

  @UseGuards(AdminAuthGuard)
  @Post('clients')
  async create(@Body() body: unknown): Promise<ClientSummary> {
    return this.clients.create(createClientSchema.parse(body));
  }

  @UseGuards(AdminAuthGuard)
  @Get('clients/:id')
  async get(@Param('id') id: string): Promise<ClientSummary> {
    return this.clients.get(id);
  }

  @UseGuards(AdminAuthGuard)
  @Patch('clients/:id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<ClientSummary> {
    return this.clients.update(id, updateClientSchema.parse(body));
  }

  @UseGuards(AdminAuthGuard)
  @Delete('clients/:id')
  @HttpCode(200)
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    await this.clients.deleteClient(id);
    return { ok: true };
  }

  @UseGuards(AdminAuthGuard)
  @Post('clients/:id/telegram')
  async connectTelegram(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ botUsername: string }> {
    const input = connectTelegramSchema.parse(body);
    return this.clients.connectTelegram(id, input.botToken);
  }

  /** Clear the bound chat if the wrong person connected to a client's bot. */
  @UseGuards(AdminAuthGuard)
  @Post('clients/:id/telegram/reset-binding')
  async resetTelegramBinding(@Param('id') id: string): Promise<{ ok: true }> {
    await this.clients.resetTelegramBinding(id);
    return { ok: true };
  }

  @UseGuards(AdminAuthGuard)
  @Post('clients/:id/google/connect-url')
  connectGoogle(@Param('id') id: string): { url: string } {
    return this.clients.googleConnectUrl(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('clients/:id/audit')
  async audit(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('success') success?: string,
  ): Promise<Paginated<AuditLogEntry>> {
    return this.clients.auditLog(id, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      success: success === undefined ? undefined : success === 'true',
    });
  }

  /** Super-admin view of a client's assistant conversation (to improve the AI). */
  @UseGuards(AdminAuthGuard)
  @Get('clients/:id/messages')
  async messages(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Paginated<ConversationMessage>> {
    return this.clients.conversation(id, { cursor, limit: limit ? Number(limit) : undefined });
  }

  @UseGuards(AdminAuthGuard)
  @Get('clients/:id/usage')
  async usage(@Param('id') id: string): Promise<{
    messagesIn: number;
    messagesOut: number;
    toolCalls: number;
    toolFailures: number;
    lastActivity: string | null;
  }> {
    return this.clients.usage(id);
  }
}
