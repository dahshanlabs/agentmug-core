// Abstract reminders interface used by the create_reminder tool.
//
// The runtime never knows whether a reminder ends up in iCloud, Google
// Tasks, a local SQLite DB, or just a Postgres audit row — that's the
// adapter's job. The cloud deployment will push to iCloud via CalDAV
// (see api-server/src/adapters/icloud-caldav-reminders.ts). A future
// desktop runner can write directly to the local Reminders app via an
// AppleScript bridge with the same interface.

export type ReminderInput = {
  title: string;
  // ISO 8601 string; undefined means "no specific due date set".
  dueDate?: string;
  priority?: "low" | "medium" | "high";
  notes?: string;
};

export type ReminderContext = {
  runId: string;
  agentId: string;
  userId: string;
};

export type ReminderResult = {
  // Stable identifier the adapter chose. For iCloud, this is the
  // CalDAV resource href so the reminder can be looked up or deleted
  // later. For audit-only adapters, a UUID.
  id: string;
  // Where the reminder actually landed: "icloud", "postgres", etc.
  // Recorded on the trace event so the run trace shows the sink.
  provider: string;
};

export interface RemindersAdapter {
  createReminder(
    input: ReminderInput,
    context: ReminderContext,
  ): Promise<ReminderResult>;
}
