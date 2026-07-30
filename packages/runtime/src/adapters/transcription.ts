// Abstract transcription interface used by the engine when AudioInput
// is supplied to runAgent.
//
// Concrete implementations live outside the runtime — Gemini in
// api-server today, a desktop runner could ship a local whisper.cpp
// implementation later. The runtime stays vendor-agnostic.

import type { AudioInput } from "../inputs/types";

export type TranscriptionResult = {
  text: string;
  // Identifies which adapter/model produced this transcript. Recorded
  // on the trace event so usage and quality can be audited per provider.
  provider: string;
  // Provider-reported audio token count, if available. Useful as a
  // proxy for audio duration when the adapter doesn't decode the
  // container itself.
  audioTokens?: number;
  // Provider-computed cost in cents, if the adapter knows its pricing.
  costCents?: number;
};

export interface TranscriptionAdapter {
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
}
