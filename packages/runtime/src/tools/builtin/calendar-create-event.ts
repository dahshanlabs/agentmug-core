// calendar.create_event — companion to gmail.send. Same OAuth provider
// (google), different scope (calendar.events).
//
// Definition is portable; the cloud-side executor lives in
// api-server/src/tools/calendar-create-event-executor.ts.

import type { InlineToolDefinition } from "../types";

export const calendarCreateEventDefinition: InlineToolDefinition = {
  type: "inline",
  name: "calendar.create_event",
  description:
    "Create an event on the user's primary Google Calendar. The user has authorized AgentMug; the token never leaves the user's account.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Event title.",
      },
      description: {
        type: "string",
        description: "Optional longer description shown in the event body.",
      },
      start: {
        type: "string",
        format: "date-time",
        description: "ISO 8601 start datetime (e.g. 2026-05-20T15:00:00Z).",
      },
      end: {
        type: "string",
        format: "date-time",
        description: "ISO 8601 end datetime. If omitted, defaults to 30 minutes after start.",
      },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of attendee email addresses to invite.",
      },
    },
    required: ["summary", "start"],
  },
};

export type CalendarCreateEventInput = {
  summary: string;
  description?: string;
  start: string;
  end?: string;
  attendees?: string[];
};

export type CalendarCreateEventResult = {
  id: string;
  htmlLink: string;
  status: "created";
};
