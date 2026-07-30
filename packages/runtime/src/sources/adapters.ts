import type {
  EvidenceChunk,
  EvidenceRef,
  RunReceipt,
  SourceAdapterCapabilities,
  SourceBinding,
  SourceBindingCandidate,
  SourceRevision,
} from "./types";

export type SourceReadRequest = {
  /** Adapter-specific structural selector, e.g. a sheet/range or relative path. */
  selector?: Record<string, unknown>;
  revision?: string;
  maxChunks?: number;
};

export type SourceWriteRequest = {
  operation: "write" | "append" | "create" | "delete";
  selector?: Record<string, unknown>;
  content?: string | Uint8Array | Record<string, unknown>;
  mediaType?: string;
  /**
   * Idempotency key supplied by the host. Adapters should reject duplicate
   * destructive requests rather than applying them twice.
   */
  idempotencyKey: string;
  /** Approval receipt id when the portable contract requires approval. */
  approvalId?: string;
  expectedRevision?: string;
};

export type SourceWriteResult = {
  status: "applied" | "rejected";
  revision?: SourceRevision;
  evidence?: EvidenceRef;
  beforeHash?: string;
  afterHash?: string;
  diffSummary?: string;
  message?: string;
};

export type SourceListRequest = {
  cursor?: string;
  limit?: number;
  selector?: Record<string, unknown>;
};

export type SourceListResult = {
  items: SourceBindingCandidate[];
  nextCursor?: string;
};

/**
 * Raw artifact access. Implementations bind one provider/local source without
 * coupling the portable runtime to Drive, OneDrive, a filesystem, or Klypix.
 */
export interface SourceAdapter {
  readonly id: string;
  readonly capabilities: SourceAdapterCapabilities;
  inspect(binding: SourceBinding): Promise<SourceBindingCandidate>;
  read(
    binding: SourceBinding,
    request?: SourceReadRequest,
  ): Promise<EvidenceChunk[]>;
  list?(
    binding: SourceBinding,
    request?: SourceListRequest,
  ): Promise<SourceListResult>;
  write?(
    binding: SourceBinding,
    request: SourceWriteRequest,
  ): Promise<SourceWriteResult>;
}

export type KnowledgeSyncResult = {
  sourceId: string;
  status: "synced" | "unchanged" | "failed";
  revision?: SourceRevision;
  chunksIndexed?: number;
  message?: string;
};

export type KnowledgeQuery = {
  query: string;
  sourceIds?: string[];
  limit?: number;
  minScore?: number;
  atRevision?: Record<string, string>;
  filters?: Record<string, unknown>;
};

/**
 * Search/index seam over source evidence. Query results retain EvidenceRef so
 * citations and source revisions survive retrieval.
 */
export interface KnowledgeAdapter {
  sync(binding: SourceBinding): Promise<KnowledgeSyncResult>;
  query(request: KnowledgeQuery): Promise<EvidenceChunk[]>;
  remove?(bindingId: string): Promise<void>;
}

export type BrainEntry = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  revision?: string;
  state: "proposed" | "confirmed" | "superseded";
  evidence: EvidenceRef[];
  updatedAt: string;
};

export type BrainEntryInput = {
  title: string;
  content: string;
  summary?: string;
  evidence?: EvidenceRef[];
  /** Machine-derived conclusions remain proposed until a human confirms them. */
  state?: "proposed" | "confirmed";
  supersedes?: string;
};

export type BrainQuery = {
  query: string;
  limit?: number;
  includeProposed?: boolean;
  asOf?: string;
};

/**
 * Curated durable memory seam. Unlike KnowledgeAdapter, this stores decisions
 * and conclusions rather than mirroring every raw document chunk.
 */
export interface BrainAdapter {
  lookup(request: BrainQuery): Promise<BrainEntry[]>;
  remember(input: BrainEntryInput): Promise<BrainEntry>;
  get?(id: string): Promise<BrainEntry | null>;
}

/** Host persistence seam for auditable run receipts. */
export interface ReceiptAdapter {
  save(receipt: RunReceipt): Promise<void>;
  get(runId: string): Promise<RunReceipt | null>;
  list?(
    agentId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ receipts: RunReceipt[]; nextCursor?: string }>;
}
