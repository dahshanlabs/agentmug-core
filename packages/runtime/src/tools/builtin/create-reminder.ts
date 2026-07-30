// create_reminder — first builtin tool definition.
//
// The DEFINITION is portable and lives here. The EXECUTOR (which
// inserts a row in the cloud's reminders table via Drizzle) lives
// in api-server. A desktop runner would supply its own executor
// that writes to local SQLite.

import type { InlineToolDefinition } from "../types";

export const createReminderDefinition: InlineToolDefinition = {
  type: "inline",
  name: "create_reminder",
  description:
    "Create a reminder/task for the user. Delivery is handled by the PLATFORM: " +
    "when the reminder is due, it is pushed to the owner's verified " +
    "WhatsApp/SMS/email automatically — you do NOT need a send/delivery tool " +
    "for this, and you must not tell the user that delivery needs extra setup.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short reminder title",
      },
      due_date: {
        type: "string",
        format: "date-time",
        description:
          "Optional ISO 8601 due date WITH an explicit UTC offset (e.g. " +
          "2026-07-03T04:23:00+03:00). Compute it carefully from the current " +
          "date/time — mixing a UTC clock reading with a local offset shifts " +
          "the instant into the past. A past due date is rejected with the " +
          "correct current time so you can recompute and retry.",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      notes: {
        type: "string",
      },
    },
    required: ["title"],
  },
};

export type CreateReminderInput = {
  title: string;
  due_date?: string;
  priority?: "low" | "medium" | "high";
  notes?: string;
};

export type CreateReminderResult = {
  id: string;
  status: "created";
  title: string;
  /** Tells the MODEL delivery is covered (platform dispatcher → owner's
   *  verified channel at due time) so it stops hedging "I can't push this". */
  delivery?: string;
};
