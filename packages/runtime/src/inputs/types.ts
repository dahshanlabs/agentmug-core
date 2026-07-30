// Agent input shapes. Phase 0 only consumes TextInput; the other types
// are declared so future phases (Whisper transcription, vision input)
// can plug into the engine without reshaping its signature.

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

export type AgentInput = TextInput | AudioInput | ImageInput;
