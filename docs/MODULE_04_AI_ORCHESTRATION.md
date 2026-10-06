# Module 04 — AI Agent Orchestration

Status: **COMPLETED**

The module's single claim: **a prompt is answered by whichever eligible provider
can serve it, and a provider failing degrades to the next candidate instead of to
a lost job — without the worker ever having to know which provider answered.**

The provider-agnostic half lives in `packages/ai-engine`. The tenant-aware half —
tenancy, credentials, persistence — lives in `apps/worker-service/src/ai`. The
split is the design: the engine takes an already tenant-scoped candidate list and
a `clientFor` function, so it holds no database, no Redis, no secrets, and no
tenant context. That is what makes the routing and failover logic testable
without any infrastructure at all.

## Requirements, and what was actually done

| Spec task                                                         | Outcome                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrate OpenAI API / LangChain in `apps/worker-service`         | **Done, without LangChain.** Direct OpenAI-compatible and Anthropic clients, behind one `ProviderClient` interface. See [Why not LangChain](#why-not-langchain).                          |
| Structured JSON output parsers for content and workflow decisions | Done. `parsers/content.ts` and `parsers/decision.ts` in `@orbitoz/ai-engine`, plus a general schema validator and one-shot repair in `engine/structured.ts`.                              |
| Handle rate-limiting errors gracefully with fallback              | Done, at two levels: per-provider retry honours `Retry-After`; when the quota is spent, the engine fails over to the next candidate. A local token bucket throttles before a 429 is sent. |
| Vitest tests mocking AI responses and verifying transformations   | Done. 176 engine unit tests (scripted transport, no network) and 39 new worker unit tests (fake store, secrets and clients).                                                              |

### Deviations from the spec text, and why

**Why not LangChain.** The task names it, and it was not used. It is a large
dependency whose value is orchestrating chains and managing a provider zoo; this
module needs exactly two provider dialects, one strict structured-output contract,
and a failover policy with cost accounting. LangChain would add an abstraction
between the code and the token counts at the precise place the billing code
reads them, making cost attribution harder rather than easier. The `ProviderClient`
interface is small enough to read in one screen and has one implementation per
dialect, which is the property that matters here.

**`responseSchema` travels as `Readonly<Record<string, unknown>>`.** It crosses a
queue boundary as JSON and is validated at the trust boundary (`toJsonSchema`)
before it reaches the engine, rather than being trusted as a `JsonSchema` because
the type said so. A schema that is not an object schema fails the job with
`INVALID_REQUEST` before any provider is called.

**One repair attempt, never a loop.** A model that cannot produce valid JSON after
one increasingly specific correction will not produce it after four. A repair loop
spends money on every iteration while making the failure harder to diagnose.
Truncated output is refused outright rather than repaired: a re-prompt that
includes a document cut off at `max_tokens` reproduces the same cut-off, so the
error names `max_tokens` as the fix instead of billing a wasted call.

## The shape of one job

```
inference.processor  ──▶ InferenceRunner ──▶ routeModels        (ai-engine)
   (BullMQ)                  │             ──▶ executeWithFailover (ai-engine)
                             │             ──▶ parseStructuredOutput (ai-engine)
                             ├──▶ SecretStore          (env / secrets manager)
                             └──▶ InferenceStore       (Prisma, tenant-scoped)
```

`InferenceRunner.run` is the only place the three concerns meet. A normal job is:

1. **Start** — inside one short transaction, read the job, refuse to restart a
   terminal one, mark it `RUNNING`.
2. **Load routing inputs** — inside a second short transaction, read the tenant's
   plan, the model catalogue joined with its per-tenant overrides, the credential
   reference for each model, and the observed success rate from `provider_attempts`.
3. **Route** — `routeModels` filters by entitlement, capability, context window
   and deprecation, then orders by strategy.
4. **Resolve clients** — credentials are resolved and clients built for the
   candidates that have both. A candidate missing a credential is _dropped_, not
   fatal: one provider's missing key must not fail a job another can serve.
5. **Call with failover** — `executeWithFailover` retries each provider on a
   transient error and moves to the next on a fatal one, recording every attempt.
6. **Parse** — if structured output was requested, extract, validate, and repair
   once; the repair is billed as part of the request.
7. **Finish** — inside a third short transaction, write the job, its attempts and
   a usage record.

### Why the transaction stops for the provider call

A Postgres interactive transaction is capped at 10s and holds a pooled connection.
A provider call can take 30s. Holding the transaction across the call would fail
every slow provider with a _transaction_ timeout, attributing a provider problem
to the database. So the job's life is split into three short transactions and the
long part runs between them — which is why `InferenceStore` exists as a port
instead of the runner reaching for `db.withTenant` directly.

### Retry, failover, and BullMQ retries are three different things

- **Backoff** (engine, `backoff.ts`) — how long before retrying the _same_
  provider. Full jitter, and `Retry-After` wins over the formula.
- **Failover** (engine, `executor.ts`) — whether a _different_ provider will do
  better. A timeout fails over; a malformed request does not, because every
  provider would reject it and failing over just pays twice for the same answer.
- **BullMQ retries** (worker) — whether the _job_ gets another delivery after every
  candidate is exhausted.

The third interacts with the database in a way that is easy to get wrong. `FAILED`
is terminal and `startJob` refuses to restart a terminal job, so a runner that
wrote `FAILED` on every attempt would silently disable BullMQ's retry. The runner
asks the worker's own `isRetryable` predicate whether this delivery will be retried;
only a delivery BullMQ will _not_ retry writes `FAILED`. An intermediate failure is
written `QUEUED`, keeping the error visible while leaving the job runnable.

## Structured output

```
text ──▶ extractJson ──▶ validateAgainstSchema ──▶ (on failure) one repair turn
```

Two failures are distinguished because they need different fixes:

| Failure                   | Cause                     | Response                  |
| ------------------------- | ------------------------- | ------------------------- |
| no JSON document found    | prose around the document | one repair turn           |
| JSON that does not parse  | truncated at `max_tokens` | refuse, name `max_tokens` |
| JSON that violates schema | wrong shape               | one repair turn           |

The domain parsers build on the same machinery: `parseContentGeneration` requires
a non-empty title and body and normalises tags; `parseWorkflowDecision` constrains
the decision to `PROCEED | REVISE | REJECT | ESCALATE` and clamps confidence to
`0..1`. Both return typed values so callers never hand-validate a loose `unknown`.

## Credentials

`tenant_providers.credential_ref` is a reference (`env:OPENAI_API_KEY`, or a
secrets-manager path), never a key. The `SecretStore` interface is the seam;
`EnvSecretStore` is the development implementation and reads the reference or the
provider-conventional variable. An unsupported scheme (`vault:`, `aws-sm:`) is a
hard error rather than a silent fallback to the environment, because reading the
wrong key would be attributed to the provider rather than to the missing store.

## Known limitations

- **Three catalogue providers are not implemented.** `isImplemented` covers
  `OPENAI`, `AZURE_OPENAI`, `MISTRAL`, `GOOGLE` and `LOCAL` (OpenAI-compatible)
  and `ANTHROPIC`. `COHERE`, `BEDROCK` and `VERTEX_AI` need their own dialects
  and fail construction loudly rather than speaking the wrong protocol.
  Candidates from an unimplemented provider are skipped during client resolution.
- **The shipped credential store is single-tenant by construction.** The
  environment has one value per variable and there is one key per tenant; a real
  deployment must inject a secrets-manager-backed `SecretStore`. This is a
  constructor argument, not a code change — but it is not done.
- **The local rate limiter is per worker process, not global.** Like the BullMQ
  limiter in Module 03, it throttles before a request leaves a replica; the
  provider's own 429 is still the authority across replicas.
- ~~**The queue producer is still deferred.**~~ Closed by Module 05: the gateway
  now enqueues `ai-inference` jobs, and does so only when a human approves a gated
  job. Carried forward from Module 03.
- **Failed structured output still records its token cost.** A response that was
  generated and then failed schema validation consumed tokens; the usage record
  stores the real cost rather than zero, so the tenant is billed for the attempt.

## Where the docs are

- [docs/modules/worker-service.md](modules/worker-service.md) — the maintainer's
  view of the worker, including this integration.
- [docs/MODULE_03_BULLMQ_WORKER.md](MODULE_03_BULLMQ_WORKER.md) — the queue layer
  this module plugs into.
- Engine source: `packages/ai-engine/src`; integration source:
  `apps/worker-service/src/ai`.
