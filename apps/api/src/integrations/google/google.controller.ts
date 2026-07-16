import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { GoogleOAuthService } from './google-oauth.service';

/**
 * Google OAuth callback. The START of the flow is admin-initiated (M6
 * dashboard → connect link → sent to the client); this endpoint is where
 * Google redirects the client's browser after consent.
 *
 * SECURITY: responses are plain text and NEVER reflect attacker-controllable
 * query params (`error`) or internal error text back into the page — otherwise
 * the callback URL becomes an HTML/phishing-injection surface on our own
 * origin. Real errors are logged server-side; the client sees a static message.
 */
@Controller('google/oauth')
export class GoogleController {
  private readonly logger = new Logger(GoogleController.name);

  constructor(private readonly oauth: GoogleOAuthService) {}

  @Get('callback')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<string> {
    if (error) {
      this.logger.warn(`Google OAuth callback returned error: ${error.slice(0, 100)}`);
      return 'Google authorization was cancelled or denied. You can close this tab — ask your administrator for a new link if you want to try again.';
    }
    if (!code || !state) {
      return 'Missing authorization parameters. Please use the exact link you were given.';
    }
    try {
      await this.oauth.handleCallback(code, state);
      return '✅ Calendar connected! You can close this tab and go back to Telegram — your assistant can now manage your calendar.';
    } catch (err) {
      this.logger.error(
        `Google OAuth callback failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return 'Connection failed — the link may have expired. Please ask your administrator for a new connection link.';
    }
  }
}
