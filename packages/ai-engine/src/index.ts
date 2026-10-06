/**
 * `@orbitoz/ai-engine` — provider-agnostic AI orchestration.
 *
 * Public surface is deliberately small: a caller should be able to
 *
 * 1. resolve candidate models (`routeModels`),
 * 2. run one request across them with retry and failover (`executeWithFailover`),
 * 3. get typed structured output (`parseStructuredOutput`),
 * 4. compose those into a DAG (`WorkflowEngine`),
 *
 * and never learn which provider answered.
 *
 * Everything here is pure and injectable: no database, no Redis, no network, no
 * tenant context. Tenancy is the caller's to establish — this package takes a
 * `RoutableModel[]` that the caller already scoped, and the separation is what
 * makes the engine testable without any infrastructure at all.
 */

// Errors
export {
  AI_ERROR_CODE,
  AiProviderError,
  codeForStatus,
  parseRetryAfter,
  type AiErrorCode,
  type ProviderErrorOptions,
} from './errors.js';

// Shared agent vocabulary
export type { AgentAttempt, AgentResult } from './agent-types.js';

// Transport
export {
  createFetchTransport,
  isAbortError,
  TransportNetworkError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

// Prompt templating
export {
  PromptTemplateError,
  referencedPaths,
  renderPrompt,
  renderPromptMap,
  resolvePath,
  type PromptOptions,
  type TemplateScope,
} from './prompt.js';

// Structured output
export {
  extractJson,
  parseJson,
  validateAgainstSchema,
  type JsonSchema,
  type JsonSchemaProperty,
  type SchemaViolation,
} from './structured.js';

// Domain parsers: content generation and workflow decisions
export {
  CONTENT_GENERATION_SCHEMA,
  isWorkflowDecision,
  parseContentGeneration,
  parseWorkflowDecision,
  WORKFLOW_DECISION_SCHEMA,
  WORKFLOW_DECISIONS,
  type GeneratedContent,
  type ParsedContentGeneration,
  type ParsedWorkflowDecision,
  type WorkflowDecision,
  type WorkflowDecisionKind,
} from './parsers/index.js';

// Providers
export {
  AnthropicClient,
  createProviderClient,
  defaultBaseUrl,
  extractErrorMessage,
  IMPLEMENTED_PROVIDERS,
  isImplemented,
  OpenAiCompatibleClient,
  userMessage,
  estimateTokens,
  supportsStructuredOutput,
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_TIMEOUT_MS,
  type ChatMessage,
  type ClientFactoryOptions,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ProviderClient,
  type ProviderClientOptions,
  type ProviderCredentials,
  type RoutingOutcome,
} from './providers/index.js';

// Retry and backoff
export {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  withRetry,
  type BackoffOptions,
  type Sleeper,
} from './backoff.js';

// Cost
export {
  computeCostUsdMicros,
  exceedsCostCeiling,
  usdToMicros,
  type ModelPricing,
} from './cost.js';

// Routing
export {
  routeModels,
  type RouteResult,
  type RoutableModel,
  type RoutingRequest,
} from './routing.js';

// Engine: failover, rate limiting, structured repair
export {
  executeWithFailover,
  toProviderError,
  type EngineOutcome,
  type EngineRequest,
} from './engine/executor.js';
export {
  DEFAULT_RATE_LIMITS,
  RateLimiterRegistry,
  TokenBucket,
  type RateLimitOptions,
} from './engine/rate-limit.js';
export {
  buildRepairPrompt,
  formatViolations,
  parseStructuredOutput,
  schemaInstructions,
  StructuredOutputError,
  tryParse,
  MAX_QUOTED_TEXT,
  type ParseOptions,
  type RepairAttempt,
  type RepairOptions,
  type StructuredParseResult,
} from './engine/structured.js';

// Workflow
export {
  validateWorkflow,
  WorkflowDefinitionError,
  type AgentNode,
  type BranchNode,
  type OutputNode,
  type TransformNode,
  type WorkflowData,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowProblem,
} from './workflow/definition.js';
export {
  evaluateBranch,
  WorkflowEngine,
  type AgentExecutionContext,
  type NodeResult,
  type WorkflowEngineOptions,
  type WorkflowRunResult,
  type WorkflowScope,
} from './workflow/executor.js';
