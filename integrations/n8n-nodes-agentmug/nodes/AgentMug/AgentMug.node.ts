import type {
  IExecuteFunctions,
  IDataObject,
  ICredentialDataDecryptedObject,
  ICredentialsDecrypted,
  ICredentialTestFunctions,
  IHttpRequestOptions,
  INodeType,
  INodeTypeDescription,
  INodeExecutionData,
  INodeCredentialTestResult,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";

type CredentialTestHelpers = ICredentialTestFunctions["helpers"] & {
  httpRequest: (options: IHttpRequestOptions) => Promise<unknown>;
};

/**
 * AgentMug node — run an AgentMug agent as a step in any n8n workflow.
 *
 * Calls the agent's external-invoke endpoint with the user's AgentMug API key.
 * Tool calls act through the user's own connected-account credentials, but
 * model inference on the hosted endpoint runs on the OPERATOR's key — point
 * `Base URL` at a self-hosted deployment to bill inference to your own. Unlike
 * a node locked to one vendor's cloud, the agent is a portable .agent file the
 * user owns and can also run on desktop and CLI, with the caveat that tool
 * coverage differs per host.
 */
export class AgentMug implements INodeType {
  description: INodeTypeDescription = {
    displayName: "AgentMug",
    name: "agentMug",
    icon: {
      light: "file:../../icons/agentmug.svg",
      dark: "file:../../icons/agentmug.dark.svg",
    },
    group: ["transform"],
    version: 1,
    subtitle: '={{ "Run agent: " + $parameter["agentId"] }}',
    description:
      "Run an AgentMug agent — a portable, BYO-credential AI agent — as a step.",
    defaults: { name: "AgentMug" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [
      {
        name: "agentMugApi",
        required: true,
        testedBy: "agentMugApiCredentialTest",
      },
    ],
    properties: [
      {
        displayName: "Agent ID",
        name: "agentId",
        type: "string",
        default: "",
        required: true,
        description: "The AgentMug agent ID from its URL: /agents/&lt;ID&gt;",
      },
      {
        displayName: "Message",
        name: "message",
        type: "string",
        typeOptions: { rows: 3 },
        default: "",
        required: true,
        description: "What you want the agent to do, in plain English",
      },
      {
        displayName: "Output",
        name: "outputField",
        type: "options",
        options: [
          {
            name: "Full Response",
            value: "full",
            description:
              "The entire run record (output, tool calls, tokens, cost)",
          },
          {
            name: "Output Only",
            value: "output",
            description: "Just the agent's final output string",
          },
        ],
        default: "full",
      },
    ],
  };

  methods = {
    credentialTest: {
      async agentMugApiCredentialTest(
        this: ICredentialTestFunctions,
        credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
      ): Promise<INodeCredentialTestResult> {
        const credentialData = credential.data ?? {};
        const apiKey = String(credentialData.apiKey ?? "");
        if (!/^am_(?:agent|user)_[A-Za-z0-9_-]+$/.test(apiKey)) {
          return {
            status: "Error",
            message: "Enter a valid AgentMug user or agent API key",
          };
        }

        const rawBaseUrl = String(credentialData.baseUrl ?? "").replace(
          /\/+$/,
          "",
        );
        let parsedBaseUrl: URL;
        try {
          parsedBaseUrl = new URL(rawBaseUrl);
        } catch {
          return { status: "Error", message: "AgentMug Base URL is not valid" };
        }
        if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
          return {
            status: "Error",
            message: "AgentMug Base URL must use HTTP or HTTPS",
          };
        }

        try {
          const response = (await (
            this.helpers as CredentialTestHelpers
          ).httpRequest({
            method: "GET",
            url: `${parsedBaseUrl.toString().replace(/\/+$/, "")}/api/external/agents/00000000-0000-0000-0000-000000000000`,
            headers: { "X-API-Key": apiKey },
            json: true,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
            timeout: 10000,
          })) as { statusCode?: number };
          const statusCode = response.statusCode ?? 0;
          if ([200, 403, 404].includes(statusCode)) {
            return { status: "OK", message: "Authentication succeeded" };
          }
          if (statusCode === 401) {
            return {
              status: "Error",
              message: "AgentMug rejected this API key",
            };
          }
          return {
            status: "Error",
            message: `AgentMug returned unexpected status ${statusCode}`,
          };
        } catch (error) {
          return {
            status: "Error",
            message: `Could not reach AgentMug: ${(error as Error).message}`,
          };
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    const creds = await this.getCredentials("agentMugApi");
    const apiKey = String(creds.apiKey ?? "");
    if (!/^am_(?:agent|user)_[A-Za-z0-9_-]+$/.test(apiKey)) {
      throw new NodeOperationError(
        this.getNode(),
        "Enter a valid AgentMug user or agent API key",
      );
    }
    const rawBaseUrl = String(creds.baseUrl || "https://agentmug.com").replace(
      /\/+$/,
      "",
    );
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(rawBaseUrl);
    } catch {
      throw new NodeOperationError(
        this.getNode(),
        "AgentMug Base URL is not valid",
      );
    }
    if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
      throw new NodeOperationError(
        this.getNode(),
        "AgentMug Base URL must use HTTP or HTTPS",
      );
    }
    const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");

    for (let i = 0; i < items.length; i++) {
      const agentId = this.getNodeParameter("agentId", i) as string;
      const message = this.getNodeParameter("message", i) as string;
      const outputField = this.getNodeParameter("outputField", i) as string;

      try {
        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          "agentMugApi",
          {
            method: "POST",
            url: `${baseUrl}/api/external/agents/${encodeURIComponent(agentId)}/invoke`,
            headers: { "Content-Type": "application/json" },
            body: { message },
            json: true,
            timeout: 180000,
          },
        )) as { output?: string };

        out.push({
          json:
            outputField === "output"
              ? { output: response.output ?? "" }
              : (response as IDataObject),
          pairedItem: { item: i },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw new NodeOperationError(this.getNode(), error as Error, {
          itemIndex: i,
        });
      }
    }

    return [out];
  }
}
