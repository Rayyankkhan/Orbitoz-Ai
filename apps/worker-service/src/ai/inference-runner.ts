/**
 * Orchestrates one `ai-inference` job: route, call with failover, parse, persist.
 *
 * This is the seam where the pure `@orbitoz/ai-engine` meets tenancy, secrets and
 * persistence. The engine knows nothing of any of those — it takes an already
 * tenant-scoped candidate list and a `clientFor` function — which is what keeps it
 * testable without infrastructure and keeps the tenant derivation in exactly one
 * place (the job envelope, via `WorkerDatabase`).
 *
 * The transaction shape is the load-bearing decision. Load, then *close the
 * transaction*, call the provider, then open a fresh transaction to write. Holding
 * the transaction across the provider call would pin a pooled connection for up to
 * the provider timeout (30s) while the transaction itself is capped at 10s, so
 * every slow provider would fail with a transaction, not a provider, error.
 */
import { Logger } from '@nestjs/common';
import {
  AI_ERROR_CODE,
  AiProviderError,
  createProviderClient,
  createFetchTransport,
  DEFAULT_RATE_LIMITS,
  executeWithFailover,
  isImplemented,
  parseStructuredOutput,
  RateLimiterRegistry,
  routeModels,
  type AgentAttempt,
  type BackoffOptions,
  type ChatMessage,
  type JsonSchema,
  type ProviderClient,
  type ProviderCredentials,
  type RoutableModel,
  type Sleeper,
} from '@orbitoz/ai-engine';
import { INFERENCE_JOB, type AiProvider, type InferenceJobPayload } from '@orbitoz/shared-types';
import type { SecretStore } from './credentials.js';
import type { CatalogueEntry, InferenceStore } from './inference-store.js';
import { asAiProvider } from './inference-store.js';

export interface InferenceRunInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly jobName: string;
  /** BullMQ's count of *previous* attempts on this delivery. */
  readonly attemptsMade: number;
  readonly maxAttempts: number;
  readonly payload: InferenceJobPayload;
}

export interface InferenceRunnerOptions {
  readonly store: InferenceStore;
  readonly secrets: SecretStore;
  readonly clientFactory?: (
    provider: AiProvider,
    credentials: ProviderCredentials,
    options: { readonly transport: ReturnType<typeof createFetchTransport> },
  ) => ProviderClient;
  readonly transport?: ReturnType<typeof createFetchTransport>;
  readonly rateLimiter?: RateLimiterRegistry;
  readonly backoff?: BackoffOptions;
  readonly sleep?: Sleeper;
  readonly now?: () => number;
  /**
   * Whether BullMQ will retry this failure.
   *
   * Injected because the retry policy lives with the worker (`isRetryable`), and
   * the store needs the answer to decide between the terminal `FAILED` status and
   * the re-runnable `QUEUED` one. Defaulting to the retry budget alone would mark
   * a non-retryable failure `QUEUED` while BullMQ sends it straight to the DLQ —
   * a job the database thinks is waiting and nothing will ever pick up.
   */
  readonly shouldRetry?: (error: unknown, attemptsMade: number, maxAttempts: number) => boolean;
}

const key = (provider: string, model: string): string => `${provider}:${model}`;

export class InferenceRunner {
  private readonly logger = new Logger(InferenceRunner.name);
  private readonly store: InferenceStore;
  private readonly secrets: SecretStore;
  private readonly transport: ReturnType<typeof createFetchTransport>;
  private readonly clientFactory: NonNullable<InferenceRunnerOptions['clientFactory']>;
  private readonly rateLimiter: RateLimiterRegistry;
  private readonly backoff: BackoffOptions | undefined;
  private readonly sleep: Sleeper | undefined;
  private readonly now: () => number;
  private readonly shouldRetry: NonNullable<InferenceRunnerOptions['shouldRetry']>;

  constructor(options: InferenceRunnerOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.transport = options.transport ?? createFetchTransport();
    this.clientFactory = options.clientFactory ?? createProviderClient;
    this.rateLimiter = options.rateLimiter ?? new RateLimiterRegistry(DEFAULT_RATE_LIMITS);
    this.backoff = options.backoff;
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
    this.shouldRetry =
      options.shouldRetry ??
      ((_error, attemptsMade, maxAttempts) => attemptsMade + 1 < maxAttempts);
  }

  async run(input: InferenceRunInput): Promise<void> {
    // A cancellation is not a routed request: it must not consume a provider call
    // or a retry, and it must be idempotent whether or not the job had started.
    if (input.jobName === INFERENCE_JOB.Cancel) {
      await this.store.markCanceled(input.tenantId, input.jobId);
      this.logger.log(`Inference ${input.jobId} canceled before any provider call`);
      return;
    }

    const start = await this.store.startJob(input.tenantId, input.jobId);
    if (start.kind === 'missing') {
      this.logger.warn(`Inference ${input.jobId} has no row for this tenant; skipping.`);
      return;
    }
    if (start.kind === 'terminal') {
      // At-least-once delivery means a duplicate of a finished job is ordinary.
      this.logger.log(`Inference ${input.jobId} is already ${start.status}; skipping.`);
      return;
    }
    if (start.kind === 'awaiting_approval') {
      // Logged at warn, not debug: reaching this means a job was enqueued while
      // its human gate was still closed. That is never expected, and spending
      // nothing here is the point — see `PrismaInferenceStore.startJob`.
      this.logger.warn(
        `Inference ${input.jobId} is awaiting approval; refusing to call any provider.`,
      );
      return;
    }

    const startedAt = this.now();
    const attempts: AgentAttempt[] = [];
    let lastProvider = 'unknown';
    let lastModel = input.payload.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsdMicros = 0;

    try {
      const inputs = await this.store.loadRoutingInputs(input.tenantId);
      const entryByKey = new Map(
        inputs.catalogue.map((entry) => [key(entry.model.provider, entry.model.modelId), entry]),
      );

      const messages = toChatMessages(input.payload.messages);
      const responseSchema = toJsonSchema(input.payload.options.responseSchema);

      const routing = routeModels(
        {
          requestedModel: input.payload.model,
          requestedProvider: input.payload.provider,
          strategy: input.payload.strategy,
          messages,
          requiresStructuredOutput: responseSchema !== null,
          fanout: input.payload.fanout,
          entitlements: inputs.entitlements,
        },
        inputs.catalogue.map((entry) => entry.model),
      );

      const clients = await this.resolveClients(routing.candidates, entryByKey);
      const candidates = routing.candidates.filter((candidate) =>
        clients.has(key(candidate.provider, candidate.modelId)),
      );
      if (candidates.length === 0) {
        throw new AiProviderError({
          code: AI_ERROR_CODE.ModelUnavailable,
          message:
            'No routable candidate could be called: every candidate is either unimplemented or ' +
            'missing a resolvable credential. Configure a provider credential or enable another model.',
        });
      }

      const outcome = await executeWithFailover({
        messages,
        candidates,
        clientFor: (candidate) => {
          const client = clients.get(key(candidate.provider, candidate.modelId));
          if (client === undefined) {
            throw new Error(
              `No client was resolved for ${candidate.provider}/${candidate.modelId}.`,
            );
          }
          return client;
        },
        temperature: input.payload.options.temperature,
        maxTokens: input.payload.options.maxTokens,
        topP: input.payload.options.topP,
        stopSequences: input.payload.options.stopSequences,
        responseSchema,
        maxCostUsd: input.payload.maxCostUsd,
        ...(this.backoff === undefined ? {} : { backoff: this.backoff }),
        ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
        // Captured per attempt, not at the end: this array is what gets persisted
        // even when the whole request later fails.
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      const primary = outcome.result;
      lastProvider = primary.provider;
      lastModel = primary.model;
      inputTokens = primary.inputTokens;
      outputTokens = primary.outputTokens;
      costUsdMicros = primary.costUsdMicros;

      const structured = await this.parseStructured({
        text: primary.text,
        schema: responseSchema,
        provider: primary.provider,
        model: primary.model,
        candidates,
        clients,
        attempts,
        payload: input.payload,
        onUsage: (usage) => {
          // A repair is a real provider call and is billed like one.
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          costUsdMicros += usage.costUsdMicros;
        },
      });

      await this.store.finishSuccess(input.tenantId, input.jobId, {
        provider: primary.provider,
        model: primary.model,
        content: primary.text,
        finishReason: primary.finishReason,
        structured,
        latencyMs: this.now() - startedAt,
        attempts,
        usage: {
          model: primary.model,
          provider: primary.provider,
          strategy: input.payload.strategy,
          inputTokens,
          outputTokens,
          costUsdMicros,
          latencyMs: this.now() - startedAt,
          success: true,
          errorCode: null,
        },
      });

      this.logger.log(
        `Inference ${input.jobId} succeeded on ${primary.provider}/${primary.model} ` +
          `(${attempts.length} attempt(s), ${costUsdMicros} micro-USD)`,
      );
    } catch (error) {
      const failure = toFailure(error);
      // `FAILED` is terminal and would make the BullMQ retry a no-op, because
      // `startJob` refuses to restart a terminal job. Only a delivery that BullMQ
      // will not retry may write a terminal status; the rest go back to QUEUED.
      const terminal = !this.shouldRetry(error, input.attemptsMade, input.maxAttempts);

      try {
        await this.store.finishFailure(input.tenantId, input.jobId, {
          errorCode: failure.code,
          errorMessage: failure.message,
          latencyMs: this.now() - startedAt,
          attempts,
          terminal,
          usage: {
            model: lastModel,
            provider: lastProvider,
            strategy: input.payload.strategy,
            inputTokens,
            outputTokens,
            costUsdMicros,
            latencyMs: this.now() - startedAt,
            success: false,
            errorCode: failure.code,
          },
        });
      } catch (persistError) {
        // The original failure is the one worth retrying for; a failure to record
        // it must not replace it, or the tenant sees a database error instead of
        // the provider problem.
        this.logger.error(
          `Failed to persist the failure of inference ${input.jobId}: ` +
            `${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }

      this.logger.warn(
        `Inference ${input.jobId} failed on ${lastProvider}/${lastModel} after ` +
          `${attempts.length} attempt(s): ${failure.code} — ${failure.message}`,
      );
      throw error;
    }
  }

  /**
   * Resolves a client per candidate, dropping candidates that cannot be called.
   *
   * A candidate is dropped, not fatal, when its provider has no client
   * implementation or its credential will not resolve. That is the point of a
   * candidate list: one provider's missing key must not fail a job another
   * provider can serve.
   */
  private async resolveClients(
    candidates: readonly RoutableModel[],
    entryByKey: ReadonlyMap<string, CatalogueEntry>,
  ): Promise<Map<string, ProviderClient>> {
    const clients = new Map<string, ProviderClient>();

    for (const candidate of candidates) {
      const provider = asAiProvider(candidate.provider);
      if (!isImplemented(provider)) {
        this.logger.warn(
          `Skipping ${candidate.provider}/${candidate.modelId}: no client implementation.`,
        );
        continue;
      }

      try {
        const credentials = await this.secrets.resolve(
          entryByKey.get(key(candidate.provider, candidate.modelId))?.credentialRef ?? null,
          provider,
        );
        const inner = this.clientFactory(provider, credentials, { transport: this.transport });
        clients.set(
          key(candidate.provider, candidate.modelId),
          this.withRateLimit(provider, candidate.modelId, inner),
        );
      } catch (error) {
        this.logger.warn(
          `Skipping ${candidate.provider}/${candidate.modelId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return clients;
  }

  /**
   * Wraps a client so each call first takes a local rate-limit token.
   *
   * The limiter throws a `RateLimited` `AiProviderError`, which the engine's retry
   * layer already knows how to honour — so the throttle and the provider's own
   * 429s are handled by one policy rather than two.
   */
  private withRateLimit(
    provider: AiProvider,
    model: string,
    client: ProviderClient,
  ): ProviderClient {
    return {
      provider: client.provider,
      complete: async (request) => {
        this.rateLimiter.acquireOrThrow(provider, model);
        return client.complete(request);
      },
    };
  }

  /** Parses structured output, running a billed repair turn when needed. */
  private async parseStructured(args: {
    readonly text: string;
    readonly schema: JsonSchema | null;
    readonly provider: string;
    readonly model: string;
    readonly candidates: readonly RoutableModel[];
    readonly clients: ReadonlyMap<string, ProviderClient>;
    readonly attempts: AgentAttempt[];
    readonly payload: InferenceJobPayload;
    readonly onUsage: (usage: {
      inputTokens: number;
      outputTokens: number;
      costUsdMicros: number;
    }) => void;
  }): Promise<unknown> {
    const schema = args.schema;
    if (schema === null) return null;

    const winner = args.candidates.find(
      (candidate) => candidate.provider === args.provider && candidate.modelId === args.model,
    );
    const winnerClient = args.clients.get(key(args.provider, args.model));

    if (winner === undefined || winnerClient === undefined) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.StructuredOutputInvalid,
        message: `Structured output was requested but the winning model ${args.provider}/${args.model} has no resolved client to repair with.`,
      });
    }

    const parsed = await parseStructuredOutput(args.text, schema, {
      provider: args.provider,
      model: args.model,
      repair: async (messages) => {
        const repairOutcome = await executeWithFailover({
          messages,
          candidates: [winner],
          clientFor: () => winnerClient,
          responseSchema: schema,
          maxCostUsd: args.payload.maxCostUsd,
          ...(this.backoff === undefined ? {} : { backoff: this.backoff }),
          ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
          onAttempt: (attempt) => {
            args.attempts.push(attempt);
          },
        });
        const result = repairOutcome.result;
        args.onUsage({
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsdMicros: result.costUsdMicros,
        });
        return {
          text: result.text,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsdMicros: result.costUsdMicros,
        };
      },
    });

    return parsed.value;
  }
}

/** Maps the envelope's messages onto the engine's chat vocabulary. */
export function toChatMessages(
  messages: readonly InferenceJobPayload['messages'][number][],
): ChatMessage[] {
  return messages.map((message) => ({
    // The engine has no tool-calling surface, and a `tool` message is a user-turn
    // observation in every other respect. Re-labelling it is lossy about the
    // mechanism but faithful about the content, and a dropped turn would silently
    // change the prompt.
    role: message.role === 'tool' ? 'user' : message.role,
    content: message.content,
  }));
}

/**
 * Validates and narrows the envelope's free-form schema.
 *
 * The payload crosses a queue boundary as untyped JSON, so this is a trust
 * boundary: a `responseSchema` that is not an object schema would otherwise reach
 * the validator and produce a confusing internal error instead of a clear
 * invalid-request one.
 */
export function toJsonSchema(value: Readonly<Record<string, unknown>> | null): JsonSchema | null {
  if (value === null) return null;

  if (value.type !== 'object') {
    throw new AiProviderError({
      code: AI_ERROR_CODE.InvalidRequest,
      message: 'responseSchema must describe an object (its "type" must be "object").',
      failoverable: false,
    });
  }
  const properties = value.properties;
  if (typeof properties !== 'object' || properties === null) {
    throw new AiProviderError({
      code: AI_ERROR_CODE.InvalidRequest,
      message: 'responseSchema must declare a "properties" object.',
      failoverable: false,
    });
  }

  return value as unknown as JsonSchema;
}

interface Failure {
  readonly code: string;
  readonly message: string;
}

function toFailure(error: unknown): Failure {
  if (error instanceof AiProviderError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: AI_ERROR_CODE.NetworkError,
    message: error instanceof Error ? error.message : String(error),
  };
}
