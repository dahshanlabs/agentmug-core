import type { InlineToolDefinition } from "../types";

/**
 * Read-only reminder inventory for the authenticated owner and current worker.
 * The host owns persistence and authorization; the portable runtime owns the
 * stable tool contract.
 */
export const listRemindersDefinition: InlineToolDefinition = {
  type: "inline",
  name: "list_reminders",
  description:
    "List reminders previously created for the authenticated owner by this worker. " +
    "Use this for questions such as 'what reminders do you know?' or 'show my pending reminders'. " +
    "It is read-only and never creates, edits, sends, or deletes a reminder.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "delivered", "all"],
        description:
          "Which reminders to return. Defaults to pending reminders that have not been delivered yet.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum reminders to return. Defaults to 20.",
      },
    },
  },
};

export type ListRemindersInput = {
  status?: "pending" | "delivered" | "all";
  limit?: number;
};

export type ReminderListItem = {
  id: string;
  title: string;
  due_date: string | null;
  priority: "low" | "medium" | "high";
  notes: string | null;
  status: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
};

export type ListRemindersResult = {
  reminders: ReminderListItem[];
  count: number;
  scope: "current_worker";
  filter: "pending" | "delivered" | "all";
};
