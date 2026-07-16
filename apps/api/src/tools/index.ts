import type { ToolDefinition } from './tool.types';
import { completeTask, createTask, deleteTask, getTasks, updateTask } from './tasks.tools';
import { forgetMemory, getProfile, saveMemory, setReminderPreference } from './memory.tools';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  findFreeTime,
  getCalendarEvents,
  updateCalendarEvent,
} from './calendar.tools';

/**
 * The tool registry. Adding a capability = create the tool file and add one
 * line here. The agent loop, audit logging, and schema generation pick it up
 * automatically — no core changes.
 *
 * ORDER IS DELIBERATELY STABLE: the tools array is part of the Anthropic
 * prompt-cache prefix; reordering invalidates the cache.
 */
export const ALL_TOOLS: ToolDefinition<never>[] = [
  getTasks,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  getCalendarEvents,
  findFreeTime,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getProfile,
  saveMemory,
  forgetMemory,
  setReminderPreference,
] as ToolDefinition<never>[];
