# Module 05 — Human-in-the-Loop Approvals

Status: **COMPLETED**

The module's single claim: **an inference job can be parked in the database for a
human to decide on, and approving it resumes the job exactly once — while a link
for one tenant reveals and decides nothing for another, even to a caller holding
that link and a valid signature for it.**

Everything runs in `apps/api-gateway`. The gateway already owned the authenticated
edge that creates a job; a human-in-the-loop gate breaks the assumption that a job
starts inside the request that created it. The row is written during a request that
finishes immediately, and the queue entry has to appear minutes or hours later, in
a different request, triggered by a click.

## Requirements, and what was actually done

| Spec task                                                      | Outcome                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unique `approvalToken` generation for execution tasks          | Done. 32 CSPRNG bytes, `base64url`, 43 characters, stored only as a SHA-256 hash. See [The link is a capability](#the-link-is-a-capability). |
| Secure public webhook endpoint `/api/v1/approvals/:token`      | Done, at `/v1/approvals/:token`. See [Route prefix](#deviations-from-the-spec-text-and-why).                                                 |
| Resume BullMQ paused tasks on approval/rejection               | Done. Approval enqueues; rejection cancels. See [Approving is the enqueue](#approving-is-the-enqueue).                                       |
| Integration tests verifying workflow state changes on triggers | Done. 12 tests against real Postgres and real Redis, plus 6 database-level checks in `pnpm db:verify`.                                       |

### Deviations from the spec text, and why

**The route is `/v1`, not `/api/v1`.** `AUTOMATION_PROMPT.md` names
`/api/v1/approvals/:token`. This repository already mounts every route under
`API_GATEWAY_GLOBAL_PREFIX`, which defaults to `v1`, so the honest path is
`/v1/approvals/:token`. Changing the prefix would have moved every existing route —
`/v1/auth/*`, `/v1/conversations/*` — and broken any client written against them, to
satisfy a path that appears in one line of a task list. The prefix is a single
environment variable, so aligning it later is a configuration change rather than a
code change.

**Jobs are not "paused"; they are never enqueued.** The spec says "resume BullMQ
paused tasks". There is no BullMQ job to pause, because creating an approval must
not hold a worker slot for as long as a human takes to decide — which is the
entire point of the feature. The `inference_jobs` row lands as `AWAITING_APPROVAL`
with no queue entry at all, and approving _is_ the enqueue. There is nothing to
resume because nothing was ever submitted. A job that was enqueued and then paused
would keep its place in a shared worker's concurrency budget for minutes or hours.

**Both endpoints are one route, not a webhook.** The spec says "webhook endpoint",
which normally implies a machine-to-machine POST with a shared secret. This is the
opposite: an unauthenticated GET for a person to read, and an unauthenticated POST
whose only credential is a signed grant in the page. A shared webhook secret would
need to reach the approver's browser, which is exactly where secrets must not go.
The security model is a bearer capability plus an HMAC, not a shared secret — see
[Why a signature and not a webhook secret](#why-a-signature-and-not-a-webhook-secret).

## The shape of an approval

```
POST /v1/approvals                 (authenticated, TENANT_DEVELOPER_ROLES)
  └─ ApprovalService.create ─┬─ inference_jobs     AWAITING_APPROVAL
                            ├─ approval_requests  PENDING
                            └─ audit_logs         APPROVAL_REQUESTED
                            ✗ nothing enqueued

GET  /v1/approvals/:token         (public — a person opening a link)
  └─ ApprovalService.getView ─── mints BOTH grants, signed for the page

POST /v1/approvals/:token/decide  (public — the click)
  └─ ApprovalService.decide
       1. verify signature            no database work yet
       2. transaction 1: claim decision, cancel or mark APPROVED
       3. QueueProducer.enqueue       outside every transaction   ← resume
       4. transaction 2: dispatchedAt, job → QUEUED
```

Two rows, or neither. `create` writes both in one transaction: a job with no approval
row is an orphan nothing can ever resume, and an approval row with no job is a link
that approves nothing. Neither state is reachable.

## The link is a capability

`approval_requests.token_hash` holds `SHA-256(token)` in a `CHAR(64)` column. The
token itself exists only in the approver's URL, the `create` response, and the
rendered page.

- 32 bytes from `randomBytes`. `Math.random` would make every token guessable by an
  attacker who has seen a few thousand of them.
- `base64url` rather than hex: the same entropy in two thirds the characters, and
  safe as a URL path segment without escaping — which matters because the token _is_
  a path segment.
- 43 characters, asserted rather than assumed. The controller rejects anything of a
  different length with a 404 before touching the database, so a public endpoint
  cannot be used to make Postgres hash arbitrary-length input on every request.

Resolution is **by hash, with no tenant in the predicate**:

```ts
SELECT * FROM approval_requests WHERE token_hash = $1
```

That is deliberate. The tenant comes from the transaction's pinned GUC and RLS, not
from the query. It means there is no code path anywhere that compares a token to a
tenant — the thing that would leak is the _row_, and RLS never returns it.

## Why a signature and not a webhook secret

Both grants are minted server-side when the page is rendered, because a browser
cannot compute an HMAC and there is no client-side secret to give it. Each grant is
bound to one action:

```
v1 = HMAC-SHA256(secret, `${token}.${timestampSeconds}.${action}`)
```

The action is inside the MAC. That is the whole reason the format is not just
`v1=<mac of token>`: both buttons exist on the same rendered page at the same
moment, so without the action binding a grant captured from **Approve** would
authorise a **Reject**. The timestamp is inside it too, so a captured grant expires
(`APPROVAL_SIGNATURE_TOLERANCE_SECONDS`, default 15 minutes) rather than being
replayable forever.

Verification runs before any database work, and every failure is one opaque 401
except `timestamp_out_of_range`, which gets its own code because it has an
actionable remedy: reload the page for a fresh grant. Naming the other failing
check would tell a caller how to work around it.

The signing secret is separate from both JWT secrets. A signature minted for an
approval link must not be presentable anywhere a JWT is accepted, and a shared key
would make that structural impossibility into a coincidence.

`GET` is token-gated but **not** signature-gated, and that asymmetry is
intentional: the signature stops the _decision_ being tampered with, and a read-only
view has nothing to tamper with. Requiring one would only make the link unusable in
a browser.

## Approving is the enqueue

The interesting ordering problem is that a decision must be durable before the job
becomes runnable, and a job must not become runnable before its decision is
durable.

```
enqueue-then-commit   the worker could start calling a provider before the
                      decision is durable, and a rollback would leave a job
                      running that nobody approved

commit-then-enqueue   a crash between the two leaves an approved request that
                      nothing will run. Recoverable, because the retry is
                      idempotent.

So: commit, enqueue, commit.
```

Two independent gates make the middle step safe to repeat:

1. **The claim** — `updateMany({ status: PENDING })`. Exactly one caller can move the
   row out of `PENDING`, because Postgres decides that atomically. The loser re-reads
   the row rather than reporting what it intended, so two devices clicking at once
   produce one `recorded` and one `already_decided`.
2. **The job id** — the BullMQ `jobId` _is_ the `inference_jobs.id`, and BullMQ
   ignores an `add` whose id already exists. So re-dispatching after a crash is a
   no-op without a distributed lock, and the same value cannot drift from the row
   the worker reads (`job.data.id`).

`dispatch_attempts` counts attempts, not successes, so an operator reading a row
that needed a retry can see it. What must not double is the job.

A Redis failure during dispatch throws `ApprovalDispatchFailedError` — a 503, not a
500 — with the decision **already committed** and `dispatched_at` still null. That
is deliberate: the caller is told the resume did not happen and retries, and the
retry finds the decision durable and the job not enqueued. Swallowing the failure
would lose the job silently; rolling the decision back would lose the human's
answer.

Rejection cancels rather than merely declining: `inference_jobs.status` becomes
`CANCELED` with `completed_at` set, guarded on a non-terminal status so a cancel
that arrives for a finished job is a no-op instead of an error. A job left at
`AWAITING_APPROVAL` after a refusal would be picked up by any future
approval-shaped repair and re-run what a human just refused.

## Where the payload snapshot earns its keep

`approval_requests.payload` holds the `InferenceJobPayload` as it stood when the
approval was created — model, provider, strategy, messages, options, cost cap.

A link approved next week runs the request that was actually made. Re-deriving the
payload from the live model catalogue at click time would silently run a different
job under the same approval: the catalogue is edited, the tenant's provider key is
swapped, a model is deprecated, and the human's "yes" is applied to something they
never saw.

`strategy: null` is snapshotted as `BALANCED` rather than resolved at creation,
because a null strategy means "use the tenant's default at run time". Freezing
today's default into a link that may be approved next week would decide the routing
question on the tenant's behalf, weeks early.

## Expiry

`expires_at` defaults to `APPROVAL_TTL_SECONDS` (24 hours) and is enforced **on
click**, not by a sweeper.

An expiry that is _detected_ must still be _recorded_: the row moves to `EXPIRED` in
the same transaction, and raising an exception instead would roll that write back —
leaving a dead link looking live forever. Because it is recorded, a retry gets the
same `410 APPROVAL_EXPIRED` rather than a `200` with `EXPIRED` in the body, which
would leave a retrying client unable to tell a finished decision from a live one
and would invite it to keep retrying a link that will never work.

An expired row is never resumed. `status: PENDING` is part of the claim predicate, so
`EXPIRED` is terminal by construction.

## Threat model

| Attacker has…                                  | Blocked by                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Another tenant's token, and no signature       | RLS. The lookup runs in a transaction pinned to the caller's tenant and returns no row.             |
| Another tenant's token, **and** a valid grant  | The same RLS check. Signature validity is per-token, so it cannot be what stops this.               |
| A grant from **Approve**, used to **Reject**   | The action is inside the MAC.                                                                       |
| A grant captured weeks ago                     | The timestamp is inside the MAC and verified against a tolerance window.                            |
| A malformed or 10 MB token                     | Shape assertion before any database work; the HMAC is only computed for tokens this service minted. |
| A link that is not one of ours                 | 43 `base64url` characters, then a hash lookup that misses. Identical to a wrong-tenant token.       |
| The `APPROVED` grant, replayed a million times | The second claim matches zero rows; nothing is enqueued twice.                                      |

Two properties are worth stating as design, not as luck:

- **Unknown and wrong-tenant tokens are indistinguishable.** Both are
  `ApprovalNotFoundError`, both take the same path, and neither names which. A
  response that distinguishes them is a tenant-enumeration oracle.
- **The tenant is not in the URL.** It comes from the resolved request tenant, so a
  link cannot be edited to point at another tenant. Editing it changes the token,
  which hashes to nothing.

## Testing

Two tiers, split by what each can actually decide.

**Unit tests** (`pnpm test`, `src/approvals/*.test.ts`) — 64 service tests against a
stateful in-memory database and queue, 15 token tests, 37 controller tests including
route metadata. They answer _decisions_: which transaction ran, in what order,
whether an enqueue was attempted. They cannot answer whether RLS hid a row or
whether BullMQ deduplicated an id.

**Integration tests** (`pnpm test:integration`, `test/approval-resume.integration.test.ts`)
— 12 tests running the production `ApprovalService` against real Postgres behind the
real non-owner role, and real Redis on the production key prefix. They answer the
two claims above. Needs `docker compose up -d postgres redis` and `pnpm db:setup`.

`TEST_REDIS_URL` is deliberately not `REDIS_URL`: the suite deletes the keys it
creates. Tenants are random UUIDs per test, so cleanup `SCAN`s on
`orbitoz:{<uuid>}:queue:*` and `UNLINK`s — never `KEYS`, never a wildcard.

**Database checks** (`pnpm db:verify`) — sections `[4g]` and `[3b]` prove, in SQL,
that another tenant's token resolves to _no row at all_ rather than a row that is
later rejected, that a cross-tenant `UPDATE` changes nothing, and that the atomic
claim matches one row then zero.

The `worker-service` `minWorkers` option was removed from both integration configs
while writing this: Vitest 5 dropped it, and it was being silently ignored.

## Known limitations

- **No expiry sweeper.** A link that expires and is never opened stays `PENDING`
  forever, and its job stays `AWAITING_APPROVAL` forever. Nothing is resumed and
  nothing is cancelled, so the rows are inert but they accumulate and they make
  `AWAITING_APPROVAL` counts wrong for anyone reading them as a queue depth. A
  sweeper needs a partial index to be affordable:
  `CREATE INDEX ON approval_requests (expires_at) WHERE status = 'PENDING';`
  It is not written, so no index is claimed either.
- **No approver identity.** The decision records `decision_ip`, `decision_user_agent`
  and `decision_trace_id`, and `actor_id` is `null` — the approver is whoever held
  the link. A deployment that needs named approvers needs an authenticated variant
  of the click, which changes the threat model above.
- **No notification.** Nothing emails the approver or reminds them. The link has to
  be fetched from the `create` response.
- **A rejected job is cancelled, not archived.** `CANCELED` is terminal, so a later
  approval on the same link cannot revive it — correct for safety, and it does mean
  "I rejected this by accident" needs a new approval request.
- **No per-tenant approval limits.** Any developer-role member can park as many jobs
  as they like, each holding a row and a token. Fine at this scale; a quota belongs
  beside the other tenant limits.
- **`dispatchAttempts` is unbounded.** A job whose dispatch permanently fails will
  be retried by whoever is clicking, and the counter grows. There is no circuit
  breaker on repeated `ApprovalDispatchFailedError`.

## Where the docs are

- [docs/modules/api-gateway.md](modules/api-gateway.md) — the gateway's routes and
  middleware, of which this module adds two public ones.
- [docs/modules/worker-service.md](modules/worker-service.md) — the consumer these
  resumed jobs land on, and the `awaiting_approval` guard.
- [docs/MODULE_04_AI_ORCHESTRATION.md](MODULE_04_AI_ORCHESTRATION.md) — what runs
  once the job is resumed.
- [docs/MODULE_03_BULLMQ_WORKER.md](MODULE_03_BULLMQ_WORKER.md) — the queue layer
  and the keyspace the producer now writes to.
- Source: `apps/api-gateway/src/approvals`, `apps/api-gateway/src/queues`.
