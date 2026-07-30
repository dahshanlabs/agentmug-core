// Phase C — the pure trigger/connectivity PLAN: what a host must do to honor
// a .agent file's declared triggers, and what it must ADMIT it can't.
//
// The engine stays trigger-free (triggers are a host concern: cloud fires
// schedules from its DB, desktop from OS tasks, CLI from cron). This helper is
// the single shared derivation all three hosts consume, so "fail loud, never
// silent" renders the same everywhere.

import type { AgentFileV1 } from "../format/agent-file";
import type { ScheduleTrigger, TriggerDefinition } from "./types";

/** What a given host is able to execute. */
export type HostCapabilities = {
  /** "cloud" | "desktop" | "cli" — informational, shown in messages. */
  host: string;
  /** Can register recurring schedules (BullMQ / schtasks / cron). */
  schedules: boolean;
  /** Can receive inbound webhooks on a public URL (cloud only today). */
  webhooks: boolean;
};

export const CLOUD_CAPABILITIES: HostCapabilities = {
  host: "cloud",
  schedules: true,
  webhooks: true,
};
export const DESKTOP_CAPABILITIES: HostCapabilities = {
  host: "desktop",
  schedules: true,
  webhooks: false,
};
export const CLI_CAPABILITIES: HostCapabilities = {
  host: "cli",
  schedules: true,
  webhooks: false,
};

/** The file's schedule triggers (the ones a host should register). */
export function getScheduleTriggers(file: AgentFileV1): ScheduleTrigger[] {
  return (file.triggers ?? []).filter(
    (t): t is ScheduleTrigger => t.type === "schedule",
  );
}

export type UnsupportedTrigger = {
  trigger: TriggerDefinition | { type: string };
  /** Plain-language, honest: what this host can't do and where it CAN run. */
  reason: string;
};

/**
 * Triggers this host must fail LOUD about (render a banner, refuse to claim
 * "fully set up"). Manual is universal; unknown trigger types from newer
 * files are unsupported by definition (an old runtime must say so, not
 * silently drop them).
 */
export function unsupportedTriggers(
  file: AgentFileV1,
  caps: HostCapabilities,
): UnsupportedTrigger[] {
  const out: UnsupportedTrigger[] = [];
  for (const t of file.triggers ?? []) {
    const type = (t as { type: string }).type;
    if (type === "manual") continue;
    if (type === "schedule") {
      if (!caps.schedules) {
        out.push({
          trigger: t,
          reason: `This ${caps.host} runtime can't register recurring schedules — run it on cloud or desktop.`,
        });
      }
      continue;
    }
    if (type === "webhook" || type === "api") {
      if (!caps.webhooks) {
        out.push({
          trigger: t,
          reason: `Inbound ${type} triggers need a public endpoint — this agent's inbound runs on cloud (this ${caps.host} runtime has no public URL).`,
        });
      }
      continue;
    }
    out.push({
      trigger: t,
      reason: `This runtime doesn't understand trigger type "${type}" (a newer .agent format?) — it will not fire here.`,
    });
  }
  return out;
}
