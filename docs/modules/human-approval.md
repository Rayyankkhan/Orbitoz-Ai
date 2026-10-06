# Human-in-the-loop approvals

The approval module inside `apps/api-gateway`: a job can be parked pending a
human's decision, and approving it resumes the job exactly once.

For the module's design rationale, spec mapping, threat model and known
limitations, read [docs/MODULE_05_HUMAN_APPROVAL.md](../MODULE_05_HUMAN_APPROVAL.md).
This page is the maintainer's view: the routes, the files, and the things that will
bite you.

## Routes

| Method | Path                          | Auth                     | Purpose                                      |
| ------ | ----------------------------- | ------------------------ | -------------------------------------------- |
| `POST` | `/v1/approvals`               | `TENANT_DEVELOPER_ROLES` | Park a job and mint its link.                |
| `GET`  | `/v1/approvals/:token`        | public (`@Public()`)     | Render the page. Mints both decision grants. |
| `POST` | `/v1/approvals/:token/decide` | public (`@Public()`)     | Record the decision; enqueue if approved.    |

The two public routes carry `@Public()` explicitly. `JwtAuthGuard` **denies by
default** and opts out only on that decorator, so forgetting it does not fail a
build or a startup — it 401s a real person following a link from an email.
`approval.controller.test.ts` asserts the route metadata by reflecting on the same
keys the guard reads, because a unit test on the guard's own logic would still pass
with the decorator missing.

Creating an approval requires `Developer`, not `Admin`: gating a job is part of
developing the workflow that runs it, and an admin-only rule would let a tenant
owner stop a workflow they are not responsible for.

## Reading the code

The order below is the order the decisions happen in, which is also the order worth
reading them in.

```
src/approvals/
  approval-token.service.ts        mint a token, hash one
  approval-signature.service.ts    HMAC grants, tolerance window, version policy
  approval.errors.ts               the four errors, and the status each maps to
  approval.service.ts              create / getView / decide — the state machine
  approval.controller.ts           three routes, validation, response shapes
  approval.module.ts               providers, including QueueProducer
src/queues/
  queue-producer.ts                the gateway's Redis side; created for this module
```

`approval.service.ts` opens with a comment explaining why the enqueue sits between
two transactions. Read it before changing the ordering — the current order is not
an accident and both alternatives are worse in ways that are not obvious until
afterwards.

## Things that will bite you

**The token is never stored.** `approval_requests.token_hash` holds SHA-256 of the
token. A test or a debugging session that needs the token must read it from the
`create` response; there is nothing in the database to recover it from.

**Resolution is by hash, with no `tenantId` in the predicate.** That is on purpose —
the tenant comes from RLS. If you add a `tenantId` to the `where` because it "looks
safer", you get a cross-tenant comparison back, which is the oracle the design is
built to avoid. `ApprovalNotFoundError` is the only answer for both a missing token
and another tenant's.

**`status: PENDING` is part of the claim predicate.** It is what makes `EXPIRED`,
`REJECTED` and `APPROVED` terminal without a separate check, and it is what makes a
replay match zero rows. Adding a status means deciding what it does to that
predicate.

**`jobId === inference_jobs.id`, always.** The worker reads `job.data.id` as the row
to run, and the same value is the BullMQ dedup key. Introducing a second identifier
means the worker and the dedup key can disagree, and the crash-window retry stops
being a no-op.

**Redispatching is normal.** `dispatched_at` is written in a _second_ transaction,
so a crash in between leaves a row that says "not dispatched" while the job is
already on the queue. `decide` re-attempts the enqueue on a replay and relies on
BullMQ to deduplicate. Do not "fix" the replay path by skipping the enqueue when
`dispatched_at` is null — that reintroduces the lost job.

**Rejection cancels the job.** `inference_jobs.status` becomes `CANCELED` with
`completed_at` set, guarded on non-terminal. A job left at `AWAITING_APPROVAL`
after a refusal could be resumed by any future repair.

**Already-expired means 410, always.** Including on the second and third click. The
alternative — a first 410 and then a 200 carrying `EXPIRED` — leaves a retrying
client unable to distinguish a finished decision from a live one.

**`dispatch_attempts` counts attempts, not successes.** A crash-window retry
increments it. An integration test asserting `1` after a simulated crash is
asserting the wrong thing; `queuedJobs().length === 1` is the assertion that matters.

## Worker side

`inference-store.ts` `startJob` returns `{ kind: 'awaiting_approval' }` for a job in
that state, and `inference-runner.ts` logs a warning and returns **without touching
a provider**. That is the second line of defence: the gateway should never enqueue
an unapproved job, and if it somehow does, the job is refused rather than run. A
cancel takes precedence over the approval check, because a job cancelled while
awaiting approval is a job that must not run.

## Testing

| Tier                     | Command                 | Needs                        |
| ------------------------ | ----------------------- | ---------------------------- |
| Unit                     | `pnpm test`             | nothing                      |
| Integration              | `pnpm test:integration` | Postgres + Redis             |
| Database isolation proof | `pnpm db:verify`        | Postgres, migrations applied |

The integration suite (`test/approval-resume.integration.test.ts`) runs the real
`ApprovalService` against a real non-owner Postgres role and real Redis. It has to
be the **production** queue prefix: `QueueProducer` derives its prefix from
`tenantQueuePrefix(tenantId)` and nothing else, because that function is the
contract with the worker's subscription. Injecting a run suffix would mean adding a
test-only parameter to production code and would hide the exact disagreement the
test exists to catch. Isolation comes from random tenant UUIDs instead, and cleanup
`UNLINK`s `orbitoz:{<uuid>}:queue:*` — never a wildcard.

Tenant provisioning uses the **owner** connection, and that is not a workaround:
`rls_tenants_insert` permits an insert only when no tenant is in scope (signup), and
there is deliberately no delete policy, because closing an account is a
platform-admin operation. `test/support/approval-fixture.ts` keeps the owner client
separate from the application client so "provision as an operator" is visibly not
the same capability as "act as a tenant".

## Scripts

| Command                 | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm test`             | Unit tests, no infrastructure.                                                           |
| `pnpm test:integration` | Approval resume against real infra.                                                      |
| `pnpm typecheck:test`   | Typechecks `src/**/*.test.ts` + `test/`. Runs automatically as part of `pnpm typecheck`. |
| `pnpm test:coverage`    | Unit tests with coverage.                                                                |

`tsconfig.json` excludes `*.test.ts` so tests stay out of `dist/`, which leaves them
outside every TypeScript project — so `tsconfig.eslint.json` covers them for
type-aware linting, and `typecheck` chains `typecheck:test` so `pnpm check` really
is a whole-repo typecheck. Without that second part nothing typechecks the test
files and they rot silently; the integration suite transpiles without checking types
at all, so a type error there would otherwise reach runtime.
