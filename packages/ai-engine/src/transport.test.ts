/**
 * The fetch transport wrapper.
 *
 * Two behaviours are load-bearing: a non-2xx status is returned normally (so the
 * provider can classify it), while a genuine transport failure is wrapped into a
 * `TransportNetworkError` so callers never have to know undici exists.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFetchTransport, isAbortError, TransportNetworkError } from './transport.js';

const INIT = {
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: '{}',
  signal: new AbortController().signal,
};

function fetchStub(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('createFetchTransport', () => {
  it('returns the status and body text of a non-2xx response', async () => {
    const fetchImpl = fetchStub(() =>
      Promise.resolve(new Response('nope', { status: 429, headers: { 'retry-after': '2' } })),
    );
    const result = await createFetchTransport(fetchImpl)('https://api.test/v1/chat', INIT);

    expect(result.status).toBe(429);
    expect(result.body).toBe('nope');
    expect(result.headers.get('retry-after')).toBe('2');
  });

  it('records a non-negative latency', async () => {
    const fetchImpl = fetchStub(() => Promise.resolve(new Response('{}', { status: 200 })));
    const result = await createFetchTransport(fetchImpl)('https://api.test', INIT);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps a thrown fetch error in TransportNetworkError', async () => {
    const fetchImpl = fetchStub(() => Promise.reject(new Error('ECONNRESET')));
    const transport = createFetchTransport(fetchImpl);

    await expect(transport('https://api.test', INIT)).rejects.toBeInstanceOf(TransportNetworkError);
  });

  it('passes the signal through so a cancellation propagates', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = fetchStub((_url, init) => {
      if (init.signal?.aborted === true)
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return Promise.resolve(new Response('{}'));
    });
    const transport = createFetchTransport(fetchImpl);

    await expect(
      transport('https://api.test', { ...INIT, signal: controller.signal }),
    ).rejects.toBeInstanceOf(TransportNetworkError);
  });
});

describe('isAbortError', () => {
  it('recognises AbortError and TimeoutError', () => {
    expect(isAbortError(Object.assign(new Error(), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(Object.assign(new Error(), { name: 'TimeoutError' }))).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
    expect(isAbortError('nope')).toBe(false);
  });
});
