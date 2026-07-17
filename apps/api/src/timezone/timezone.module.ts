import { Module } from '@nestjs/common';
import { GoogleModule } from '../integrations/google/google.module';
import { TimezoneService } from './timezone.service';

/**
 * Travel-aware timezone sync. Depends on Google (to read the client's calendar
 * timezone) and Prisma (global). Imported by JobsModule (periodic sweep) and
 * TelegramModule (opportunistic per-message sync).
 */
@Module({
  imports: [GoogleModule],
  providers: [TimezoneService],
  exports: [TimezoneService],
})
export class TimezoneModule {}
