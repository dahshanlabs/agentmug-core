// Trigger source shapes — the SINGLE definition shared by the .agent format
// (AgentFileV1.triggers) and every host runtime. Phase C unified these with
// the file's inline union (they had drifted: the file's schedule carried
// `prompt`, this one didn't — two sources of truth for one wire format).
//
// Execution is a HOST concern, not the engine's: cloud fires schedules from
// the schedules table (BullMQ), desktop from OS tasks (schtasks), CLI from
// cron. See triggers/plan.ts for the per-host capability matrix.

export type ManualTrigger = {
  type: "manual";
};

export type WebhookTrigger = {
  type: "webhook";
  path: string;
};

export type ScheduleTrigger = {
  type: "schedule";
  cron: string;
  /**
   * WHAT the agent should do when the schedule fires (a scheduled run has no
   * typed user message). Travels in the portable file so the recurring task
   * is declared once and runs the same wherever it's scheduled. Omitted =
   * the runtime falls back to a generic "scheduled run" instruction.
   */
  prompt?: string;
  /** IANA timezone the cron is evaluated in (host default when omitted). */
  timezone?: string;
  /** Human label shown in schedule UIs ("Morning triage"). */
  label?: string;
};

export type ApiTrigger = {
  type: "api";
  endpoint: string;
};

export type TriggerDefinition =
  | ManualTrigger
  | WebhookTrigger
  | ScheduleTrigger
  | ApiTrigger;
