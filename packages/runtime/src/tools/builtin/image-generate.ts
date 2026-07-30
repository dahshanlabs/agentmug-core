// image.generate — agents produce images, not just consume them.
//
// The ChatGPT-DALL-E equivalent as a tool. Closes the modality gap
// on the OUTPUT side: AgentMug already accepts image inputs (Phase
// 15a vision). This adds image output. Now an agent can be told
// "design a logo for X, then describe what you made" and it does
// both halves end-to-end.
//
// Backed by OpenAI's gpt-image-1 (their modern image model) — same
// API key as the OpenAI LLM provider, so operators with that key
// already configured get image generation for free. Without
// OPENAI_API_KEY, the tool returns a clear "not configured" error.
//
// User-facing label is "🎨 Generating an image" — hides the model
// name (gpt-image-1) so a future swap to gpt-image-2 or a different
// provider is invisible to end users.

import type { InlineToolDefinition } from "../types";

export const imageGenerateDefinition: InlineToolDefinition = {
  type: "inline",
  name: "image.generate",
  description:
    "Generate an image from a text description. Use this whenever the user asks for visual output — logos, illustrations, mockups, mood boards, scenes, product photos. The image is returned inline and renders directly in the dashboard. Each call generates one image; for variations, call multiple times with tweaked prompts. PRO TIP: detailed prompts produce better images. 'A minimalist logo for a coffee shop named Lumi, soft gold and warm white, mid-century modern, vector-style' beats 'logo for coffee shop'.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Detailed description of the image you want. Include subject, style, colors, mood, composition. Longer + more specific = better output.",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
        description:
          "Output dimensions. 1024x1024 = square (default), 1024x1536 = portrait, 1536x1024 = landscape, auto = let the model pick.",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high", "auto"],
        description:
          "Generation quality. 'low' is fastest + cheapest; 'high' takes longer + costs more but renders finer details. Default 'auto' picks based on the prompt complexity.",
      },
      background: {
        type: "string",
        enum: ["transparent", "opaque", "auto"],
        description:
          "transparent = PNG with alpha channel (for logos, icons that go on backgrounds). opaque = solid background. Default auto.",
      },
    },
    required: ["prompt"],
  },
};

export type ImageGenerateInput = {
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
};

export type ImageGenerateResult = {
  status: "generated" | "error";
  /** Base64-encoded PNG bytes (no data: prefix). */
  image_base64?: string;
  /** Standard MIME — always image/png from gpt-image-1. */
  media_type: string;
  /** The prompt the user asked for, echoed back. */
  prompt: string;
  /** What the model actually rendered — sometimes refined from the prompt. */
  revised_prompt?: string;
  /** Wall-clock ms the generation took. */
  duration_ms: number;
  /** Set when status="error". */
  error?: string;
};
