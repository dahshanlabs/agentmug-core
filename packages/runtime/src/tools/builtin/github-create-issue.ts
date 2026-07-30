// github.create_issue — file an issue on a GitHub repo the user has
// authorized.
//
// The user installs the AgentMug GitHub App (or grants OAuth with
// repo scope) and the token lives encrypted in user_credentials.
// Cloud executor calls api.github.com on the user's behalf.

import type { InlineToolDefinition } from "../types";

export const githubCreateIssueDefinition: InlineToolDefinition = {
  type: "inline",
  name: "github.create_issue",
  description:
    "Create an issue on a GitHub repo the user has access to. Uses the user's own GitHub OAuth token — AgentMug never stores credentials.",
  inputSchema: {
    type: "object",
    properties: {
      owner: {
        type: "string",
        description: "Repository owner (user or org), e.g. 'dahshanlabs'.",
      },
      repo: {
        type: "string",
        description: "Repository name, e.g. 'AgenitLit'.",
      },
      title: {
        type: "string",
        description: "Issue title.",
      },
      body: {
        type: "string",
        description: "Markdown body for the issue.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Optional labels to apply to the issue.",
      },
    },
    required: ["owner", "repo", "title", "body"],
  },
};

export type GithubCreateIssueInput = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
};

export type GithubCreateIssueResult = {
  number: number;
  htmlUrl: string;
  status: "created";
};
