/**
 * Test-only transport helpers.
 *
 * Not part of the package's public surface and excluded from the build via
 * `tsconfig.json`. Lives in `src/` rather than a sibling `test/` directory so the
 * relative imports stay short and the lint project (which includes `src/**`) can
 * type them.
 *
 * The point of every helper here is the same: substitute the network, not the
 * module. A `vi.mock('node:fetch')` leaks between files and makes it impossible
 * for two tests to want different responses; a transport passed to the client
 * under test is per-test by construction.
 */
import type { Transport, TransportRequest, TransportResponse } from '../transport.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderClient,
} from '../providers/contracts.js';
import type { AiProvider } from '@orbitoz/shared-types';

export interface RecordedRequest {
  readonly url: string;
  readonly init: TransportRequest;
  /** The parsed JSON body, for assertions on payload transformations. */
  readonly body: unknown;
}

export interface FakeTransport {
  readonly transport: Transport;
  /** Every request the client made, in order. */
  readonly requests: RecordedRequest[];
}

/** A transport that replies with a fixed set of responses, recording requests. */
export function fakeTransport(
  responses: readonly (Partial<TransportResponse> & { readonly body: string })[],
): FakeTransport {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const transport: Transport = (url, init) => {
    requests.push({ url, init, body: parseBody(init.body) });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response === undefined) {
      return Promise.reject(new Error('fakeTransport was given no responses.'));
    }
    const headers = response.headers;
    return Promise.resolve({
      status: response.status ?? 200,
      // An arrow wrapper rather than passing `headers.get` through: a detached
      // method call loses its receiver.
      headers: { get: (name: string) => (headers === undefined ? null : headers.get(name)) },
      body: response.body,
      latencyMs: response.latencyMs ?? 1,
    });
  };

  return { transport, requests };
}

/** A one-response transport convenience. */
export function respondingWith(
  response: Partial<TransportResponse> & { body: string },
): FakeTransport {
  return fakeTransport([response]);
}

function parseBody(body: string | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A provider client that returns scripted outcomes and records its requests. */
export class ScriptedClient implements ProviderClient {
  readonly calls: CompletionRequest[] = [];

  constructor(
    readonly provider: AiProvider,
    private readonly script: readonly (CompletionResponse | Error)[],
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);
    const outcome = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    if (outcome === undefined) throw new Error('ScriptedClient has no scripted outcome.');
    // A tiny real await, so the engine's async ordering is exercised rather than
    // short-circuited by a synchronous return.
    await Promise.resolve();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

/** A successful completion with sensible defaults. */
export function completion(overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: 'hello',
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 12,
    requestId: 'req-1',
    truncated: false,
    ...overrides,
  };
}
