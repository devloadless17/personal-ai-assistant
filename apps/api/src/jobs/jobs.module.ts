import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { GoogleModule } from '../integrations/google/google.module';
import { TelegramModule } from '../integrations/telegram/telegram.module';
import { AdminAlertService } from './admin-alert.service';
import { CalendarSweepJob } from './calendar-sweep.job';
import { DailyBriefJob } from './daily-brief.job';
import { JobsDiagnosticsService } from './jobs-diagnostics.service';
import { ReminderJob } from './reminder.job';

@Module({
  imports: [ScheduleModule.forRoot(), TelegramModule, GoogleModule],
  providers: [
    AdminAlertService,
    ReminderJob,
    DailyBriefJob,
    CalendarSweepJob,
    JobsDiagnosticsService,
  ],
  exports: [AdminAlertService, JobsDiagnosticsService],
})
export class JobsModule {}
