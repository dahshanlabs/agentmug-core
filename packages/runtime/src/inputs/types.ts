// Portable agent input shapes used across cloud, desktop, and CLI runners.
// Hosts validate and bound binary content before handing it to the engine.

export type TextInput = {
  type: "text";
  content: string;
};

export type AudioInput = {
  type: "audio";
  data: Buffer | ArrayBuffer;
  mimeType: string;
};

export type ImageInput = {
  type: "image";
  data: Buffer | ArrayBuffer | string;
  mimeType: string;
  /**
   * Optional accompanying text. When the user attaches an image
   * alongside a typed message, the text becomes the user turn's
   * first content block and the image follows. Without text, the
   * engine falls back to "[Image attached]" as the descriptor.
   */
  text?: string;
};

export type MultiModalInput = {
  type: "multimodal";
  /** Optional text or extracted document content accompanying the images. */
  text?: string;
  /** Bounded by the host before dispatch. Each image is base64 or binary data. */
  images: Array<{
    data: Buffer | ArrayBuffer | string;
    mimeType: string;
  }>;
};

export type AgentInput = TextInput | AudioInput | ImageInput | MultiModalInput;
