// Public entry point for @agentmug/runtime.
//
// Consumers (api-server today; desktop and self-hosted runners later)
// import runAgent and the adapter interfaces from here. Tool, input,
// and trigger types are also exported so future phases can plug in
// without reaching into internal paths.

export {
  runAgent,
  AgentNotFoundError,
} from "./engine";
export type {
  EngineEvent,
  RunAgentAdapters,
  RunAgentOptions,
  RunAgentResult,
  ContextProvider,
} from "./engine";

export type {
  PersistenceAdapter,
  AgentRecord,
  BlueprintRecord,
  NewRun,
  RunCompletion,
  RunFailure,
  RunPause,
  ConnectedAccount,
} from "./adapters/persistence";
export { buildIdentityDirective } from "./identity-grounding";
export { buildCapabilityDirective } from "./capability-grounding";
export type { GroundedTool } from "./capability-grounding";
export { buildConnectionDirective } from "./connection-grounding";
export type { MissingConnection } from "./connection-grounding";

export type {
  TracingAdapter,
  LlmCallTrace,
  TranscriptionTrace,
  ToolCallTrace,
} from "./adapters/tracing";

export type {
  TranscriptionAdapter,
  TranscriptionResult,
} from "./adapters/transcription";

export type {
  RemindersAdapter,
  ReminderInput,
  ReminderContext,
  ReminderResult,
} from "./adapters/reminders";

// Portable source contracts. Requirements travel in `.agent`; SourceBinding
// remains runtime-private. Validation is pure so web/desktop/CLI/MCP can all
// render the same fail-loud setup result before they invoke the engine.
export {
  SOURCE_ROLES,
  SOURCE_KINDS,
  SOURCE_CAPABILITIES,
  EVALUATION_CHECK_TYPES,
} from "./sources/types";
export type {
  SourceRole,
  SourceKind,
  SourceCapability,
  SourceAcceptContract,
  SourceStructureContract,
  SourceFreshnessContract,
  SourceTruthContract,
  SourceAccessContract,
  SourceApprovalMode,
  SourceApprovalContract,
  SourceSharingContract,
  SourceRequirement,
  SourceRevision,
  SourceBindingStatus,
  SourceBinding,
  PrivateSourceBinding,
  SourceBindingCandidate,
  SourceAdapterCapabilities,
  SourceRuntimeContext,
  EvidenceLocation,
  EvidenceRef,
  EvidenceChunk,
  EvaluationCheckType,
  EvaluationCheck,
  EvaluationContract,
  ReceiptApproval,
  ReceiptSourceRead,
  ReceiptSourceWrite,
  ReceiptEvaluation,
  RunReceipt,
  StructuredCitation,
} from "./sources/types";
export type {
  SourceReadRequest,
  SourceWriteRequest,
  SourceWriteResult,
  SourceListRequest,
  SourceListResult,
  SourceAdapter,
  KnowledgeSyncResult,
  KnowledgeQuery,
  KnowledgeAdapter,
  BrainEntry,
  BrainEntryInput,
  BrainQuery,
  BrainAdapter,
  ReceiptAdapter,
} from "./sources/adapters";
export {
  validateSourceRequirements,
  validateEvaluationContract,
  checkSourceCompatibility,
  checkAgentSourceReadiness,
  assertAgentSourceReady,
  SourceReadinessError,
} from "./sources/validation";
export type {
  SourceContractIssueCode,
  SourceContractIssue,
  SourceCompatibility,
  SourceReadinessItem,
  SourceReadinessReport,
} from "./sources/validation";
export {
  formatEvidenceCitation,
  buildSourceGroundingDirective,
} from "./sources/grounding";
export type { SourceGroundingOptions } from "./sources/grounding";
export {
  prepareSourceExecution,
  noSourcePlan,
  assertSourceExecutionPlan,
  assertBoundSourcePreflight,
} from "./sources/execution-plan";
export type { SourceExecutionPlan } from "./sources/execution-plan";

export {
  AnthropicLlmClient,
} from "./adapters/llm";
export type { AnthropicLlmClientOptions } from "./adapters/llm";
export {
  OpenAiLlmClient,
} from "./adapters/llm-openai";
export type { OpenAiLlmClientOptions } from "./adapters/llm-openai";
export {
  GeminiLlmClient,
} from "./adapters/llm-gemini";
export type { GeminiLlmClientOptions } from "./adapters/llm-gemini";
export {
  MultiLlmClient,
  createMultiLlmClient,
  createMultiLlmClientFromEnv,
  detectProvider,
  OPENAI_COMPAT_PROVIDERS,
  NATIVE_PROVIDERS,
  GEMINI_OPENAI_BASE_URL,
} from "./adapters/llm-multi";
export type {
  LlmProvider,
  CompatProvider,
  CompatProviderInfo,
  NativeProvider,
  MultiLlmClientOptions,
  CustomEndpointOptions,
} from "./adapters/llm-multi";
export type {
  LlmClient,
  LlmMessage,
  LlmStreamParams,
  LlmStreamEvent,
} from "./adapters/llm";

export type {
  ToolDefinition,
  InlineToolDefinition,
  WebhookToolDefinition,
  OAuthToolDefinition,
  McpToolDefinition,
} from "./tools/types";
export {
  InMemoryToolRegistry,
} from "./tools/registry";
export type {
  ToolRegistry,
  ToolExecutor,
  ToolExecutionContext,
  RegisteredTool,
  CredentialResolver,
  ResolvedCredential,
} from "./tools/registry";
export {
  createReminderDefinition,
} from "./tools/builtin/create-reminder";
export type {
  CreateReminderInput,
  CreateReminderResult,
} from "./tools/builtin/create-reminder";
export {
  gmailSendDefinition,
} from "./tools/builtin/gmail-send";
export type {
  GmailSendInput,
  GmailSendResult,
} from "./tools/builtin/gmail-send";
export {
  gmailCreateDraftDefinition,
} from "./tools/builtin/gmail-create-draft";
export type {
  GmailCreateDraftInput,
  GmailCreateDraftResult,
} from "./tools/builtin/gmail-create-draft";
export {
  gmailListMessagesDefinition,
} from "./tools/builtin/gmail-list-messages";
export type {
  GmailListMessagesInput,
  GmailListMessage,
  GmailListMessagesResult,
} from "./tools/builtin/gmail-list-messages";
export {
  emailSendDefinition,
} from "./tools/builtin/email-send";
export type {
  EmailSendInput,
  EmailSendResult,
} from "./tools/builtin/email-send";
export {
  sheetsAppendRowDefinition,
} from "./tools/builtin/sheets-append-row";
export type {
  SheetsAppendRowInput,
  SheetsAppendRowResult,
} from "./tools/builtin/sheets-append-row";
export {
  calendarCreateEventDefinition,
} from "./tools/builtin/calendar-create-event";
export type {
  CalendarCreateEventInput,
  CalendarCreateEventResult,
} from "./tools/builtin/calendar-create-event";
export {
  twilioSendSmsDefinition,
} from "./tools/builtin/twilio-send-sms";
export type {
  TwilioSendSmsInput,
  TwilioSendSmsResult,
} from "./tools/builtin/twilio-send-sms";
export {
  twilioSendWhatsappDefinition,
} from "./tools/builtin/twilio-send-whatsapp";
export type {
  TwilioSendWhatsappInput,
  TwilioSendWhatsappResult,
} from "./tools/builtin/twilio-send-whatsapp";
export {
  telegramSendMessageDefinition,
} from "./tools/builtin/telegram-send-message";
export type {
  TelegramSendMessageInput,
  TelegramSendMessageResult,
} from "./tools/builtin/telegram-send-message";
export {
  discordSendMessageDefinition,
} from "./tools/builtin/discord-send-message";
export type {
  DiscordSendMessageInput,
  DiscordSendMessageResult,
} from "./tools/builtin/discord-send-message";
export {
  fetchUrlDefinition,
} from "./tools/builtin/fetch-url";
export type {
  FetchUrlInput,
  FetchUrlResult,
} from "./tools/builtin/fetch-url";
export {
  queryCsvDefinition,
} from "./tools/builtin/query-csv";
export type {
  QueryCsvInput,
  QueryCsvResult,
} from "./tools/builtin/query-csv";
export {
  codeExecuteDefinition,
} from "./tools/builtin/code-execute";
export type {
  CodeExecuteInput,
  CodeExecuteResult,
} from "./tools/builtin/code-execute";
export {
  invokeAgentDefinition,
} from "./tools/builtin/invoke-agent";
export type {
  InvokeAgentInput,
  InvokeAgentResult,
} from "./tools/builtin/invoke-agent";
export {
  a2aInvokeDefinition,
} from "./tools/builtin/a2a-invoke";
export type {
  A2aInvokeInput,
  A2aInvokeResult,
} from "./tools/builtin/a2a-invoke";
export {
  a2aDiscoverDefinition,
} from "./tools/builtin/a2a-discover";
export type {
  A2aDiscoverInput,
  A2aDiscoverResult,
  A2aDiscoverMatch,
} from "./tools/builtin/a2a-discover";
export {
  readsUntrustedContent,
  isSideEffecting,
  sideEffectGateDecision,
  resolveSideEffectGate,
  channelKeyForTool,
  channelLabel,
  detectCompositionConflicts,
  resolveCompositionPolicy,
  buildConductorDirective,
} from "./tools/side-effect-gate";
export type {
  SideEffectGate,
  GateDecision,
  CompositionMode,
  CompositionWorker,
  CompositionConflict,
} from "./tools/side-effect-gate";
export {
  listAgentsDefinition,
} from "./tools/builtin/list-agents";
export type {
  ListAgentsInput,
  ListAgentsResult,
  AgentSummary,
} from "./tools/builtin/list-agents";
export {
  createAgentDefinition,
} from "./tools/builtin/create-agent";
export type {
  CreateAgentInput,
  CreateAgentResult,
} from "./tools/builtin/create-agent";
export {
  updateAgentDefinition,
} from "./tools/builtin/update-agent";
export type {
  UpdateAgentInput,
  UpdateAgentResult,
} from "./tools/builtin/update-agent";
export {
  memorySaveDefinition,
  memoryRecallDefinition,
  memoryForgetDefinition,
  memoryReflectDefinition,
} from "./tools/builtin/memory";
export {
  webResearchDefinition,
} from "./tools/builtin/web-research";
export type {
  WebResearchInput,
  WebResearchResult,
} from "./tools/builtin/web-research";
export {
  webBrowseDefinition,
} from "./tools/builtin/web-browse";
export type {
  WebBrowseInput,
  WebBrowseResult,
} from "./tools/builtin/web-browse";
export {
  askUserDefinition,
} from "./tools/builtin/ask-user";
export type {
  AskUserInput,
  AskUserResult,
} from "./tools/builtin/ask-user";
export {
  imageGenerateDefinition,
} from "./tools/builtin/image-generate";
export type {
  ImageGenerateInput,
  ImageGenerateResult,
} from "./tools/builtin/image-generate";
export {
  shellExecuteDefinition,
} from "./tools/builtin/shell-execute";
export type {
  ShellExecuteInput,
  ShellExecuteResult,
} from "./tools/builtin/shell-execute";
export {
  fetchJsonDefinition,
} from "./tools/builtin/fetch-json";
export type {
  FetchJsonInput,
  FetchJsonResult,
} from "./tools/builtin/fetch-json";

// Phase 28: quickstart helpers — the 10-line hello-agent in the
// README compiles because these wrap the engine with sensible
// in-memory defaults.
export {
  quickRun,
  createInMemoryAdapters,
  InMemoryPersistenceAdapter,
  InMemoryTracingAdapter,
} from "./quickstart";
export type { QuickRunOptions } from "./quickstart";

// Phase 30: plugin API. Lets external npm packages ship coherent
// tool + adapter bundles a consumer wires with one import.
export {
  definePlugin,
} from "./plugins";
export type {
  AgentMugPlugin,
  PluginTool,
  PluginAdapters,
} from "./plugins";
// First-party core-tools bundle — portable executors (no host infra, no
// credentials) for fetch_url / web.fetch_json / query_csv, so the CLI,
// desktop, and any npm consumer get working compute tools via one call
// instead of dead-ending at "Unknown tool".
export {
  createCoreToolsPlugin,
  registerCoreToolsFor,
} from "./tools/core-plugin";
export { FetchUrlExecutor } from "./tools/builtin-executors/fetch-url-executor";
export { FetchJsonExecutor } from "./tools/builtin-executors/fetch-json-executor";
export { QueryCsvExecutor } from "./tools/builtin-executors/query-csv-executor";
// Portable webhook tool execution (the silent-drop bug fix lives in the engine).
export {
  WebhookExecutor,
  webhookToolDefinition,
  registerWebhookTools,
} from "./tools/builtin-executors/webhook-executor";
// Verified Self-Skilling — PORTABLE save_skill/use_skill. The agent learns +
// replays skills off-cloud, persisting into its own .agent file via the
// serializer. Persistence is a pluggable AgentFileStore (host wires file IO).
export {
  saveSkillDefinition,
  useSkillDefinition,
} from "./tools/builtin/skills";
export type {
  SaveSkillInput,
  SaveSkillResult,
  UseSkillInput,
  UseSkillResult,
} from "./tools/builtin/skills";
export {
  InMemoryAgentFileStore,
  SaveSkillExecutor,
  UseSkillExecutor,
  createLlmSkillVerifier,
  registerSelfSkillingSkills,
  normalizeSkillName,
  MAX_SKILL_RECIPE_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_TRIGGER_CHARS,
  MAX_SKILLS_PER_AGENT,
} from "./tools/self-skilling";
export type {
  AgentFileStore,
  SkillVerifier,
  SkillVerification,
  SkillCheck,
} from "./tools/self-skilling";
// Agent Brain — PORTABLE brain_remember/brain_lookup. Structured knowledge
// pages persist into the agent's .agent file (owner-private), recalled on
// demand. Reuses AgentFileStore; no LLM needed.
export {
  brainRememberDefinition,
  brainLookupDefinition,
} from "./tools/builtin/brain";
export type {
  BrainRememberInput,
  BrainRememberResult,
  BrainLookupInput,
  BrainLookupResult,
} from "./tools/builtin/brain";
export {
  BrainRememberExecutor,
  BrainLookupExecutor,
  registerAgentBrainTools,
  buildBrainIndex,
  normalizeBrainSlug,
  MAX_BRAIN_PAGE_CONTENT_CHARS,
  MAX_BRAIN_TITLE_CHARS,
  MAX_BRAIN_SUMMARY_CHARS,
  MAX_BRAIN_LINKS,
  MAX_BRAIN_SOURCES,
  MAX_BRAIN_PAGES_IN_INDEX,
} from "./tools/agent-brain";
// Portable Manager — PORTABLE list_agents/create_agent/update_agent/
// invoke_agent over a FOLDER of .agent files. Lets a Conductor discover,
// spawn, repair, and dispatch a fleet on desktop/CLI with no server. Host
// wires an AgentFolderStore (+ a SubAgentRunner for invoke_agent).
export {
  InMemoryAgentFolderStore,
  PortableListAgentsExecutor,
  PortableCreateAgentExecutor,
  PortableUpdateAgentExecutor,
  PortableInvokeAgentExecutor,
  registerPortableManagerTools,
} from "./tools/portable-manager";
export type {
  AgentFolderStore,
  StoredAgent,
  SubAgentRunner,
} from "./tools/portable-manager";
export type {
  MemorySaveInput,
  MemorySaveResult,
  MemoryRecallInput,
  MemoryRecallResult,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryReflectInput,
  MemoryReflectResult,
} from "./tools/builtin/memory";
export {
  slackSendMessageDefinition,
} from "./tools/builtin/slack-send-message";
export type {
  SlackSendMessageInput,
  SlackSendMessageResult,
} from "./tools/builtin/slack-send-message";
export {
  githubCreateIssueDefinition,
} from "./tools/builtin/github-create-issue";
export type {
  GithubCreateIssueInput,
  GithubCreateIssueResult,
} from "./tools/builtin/github-create-issue";

export type {
  AgentInput,
  TextInput,
  AudioInput,
  ImageInput,
} from "./inputs/types";

export type {
  TriggerDefinition,
  ManualTrigger,
  WebhookTrigger,
  ScheduleTrigger,
  ApiTrigger,
} from "./triggers/types";

// Phase C — connectivity contract + the per-host trigger plan.
export {
  CLOUD_CAPABILITIES,
  DESKTOP_CAPABILITIES,
  CLI_CAPABILITIES,
  getScheduleTriggers,
  unsupportedTriggers,
} from "./triggers/plan";
export type { HostCapabilities, UnsupportedTrigger } from "./triggers/plan";

export {
  AGENT_FILE_SCHEMA_V1,
  parseAgentFile,
  buildAgentFile,
  serializeAgentFile,
  suggestedFilename,
  normalizeTools,
  checkArtifactCompatibility,
  getRequiredCredentials,
  substituteParameters,
  extractReferencedParameters,
  acceptedInputsFor,
  modelIsVisionCapable,
  deriveConnectivityFromTools,
} from "./format/agent-file";
export type {
  AgentFileV1,
  BuildAgentFileInput,
  ToolReference,
  BuiltinToolReference,
  McpToolReference,
  WebhookToolReference,
  NangoToolReference,
  AgentOutputSpec,
  CredentialRequirement,
  AgentParameter,
  ArtifactBindingCandidate,
  ArtifactCompatibility,
  AgentCaveat,
  ConnectivityContract,
} from "./format/agent-file";
