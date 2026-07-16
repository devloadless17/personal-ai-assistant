import { Controller, Get, Query } from '@nestjs/common';
import { GoogleOAuthService } from './google-oauth.service';

/**
 * Google OAuth callback. The START of the flow is admin-initiated (M6
 * dashboard → connect link → sent to the client); this endpoint is where
 * Google redirects the client's browser after consent.
 */
@Controller('google/oauth')
export class GoogleController {
  constructor(private readonly oauth: GoogleOAuthService) {}

  @Get('callback')
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<string> {
    if (error) {
      return `Google authorization was cancelled (${error}). You can close this tab — ask your administrator for a new link if you want to try again.`;
    }
    if (!code || !state) {
      return 'Missing authorization parameters. Please use the exact link you were given.';
    }
    try {
      await this.oauth.handleCallback(code, state);
      return '✅ Calendar connected! You can close this tab and go back to Telegram — your assistant can now manage your calendar.';
    } catch (err) {
      return `Connection failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
  }
}
