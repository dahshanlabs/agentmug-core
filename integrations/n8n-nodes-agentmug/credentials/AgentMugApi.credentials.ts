import type {
  IAuthenticateGeneric,
  Icon,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

/**
 * AgentMug API credentials for the n8n node.
 *
 * The key is the user's OWN AgentMug key — the agent runs on their own
 * model + connected-account credentials, so n8n never pays an inference
 * tax and the agent acts with the user's own Gmail/Sheets/etc. tokens.
 */
export class AgentMugApi implements ICredentialType {
  name = "agentMugApi";
  displayName = "AgentMug API";
  icon: Icon = {
    light: "file:../icons/agentmug.svg",
    dark: "file:../icons/agentmug.dark.svg",
  };
  documentationUrl =
    "https://github.com/dahshanlabs/agentmug-core/tree/main/integrations/n8n-nodes-agentmug#configure";
  supportedNodes = ["agentMug"];
  restrictToSupportedNodes = true as const;
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        "Your AgentMug user key (am_user_…) or an agent-scoped key (am_agent_…). Create one in AgentMug → Settings → API Keys.",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://agentmug.com",
      description: "Your AgentMug instance URL (change only for self-hosted).",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        "X-API-Key": "={{$credentials.apiKey}}",
      },
    },
  };
}
