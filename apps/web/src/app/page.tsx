import { headers } from 'next/headers';

/**
 * The landing page reads the tenant from the Host header on the server, which is
 * the same rule the API gateway uses. Keeping one definition of "which tenant is
 * this request for" means the two cannot disagree.
 *
 * `headers()` is async in Next 15+, so awaiting it is required rather than
 * stylistic. Next 16 does not infer the return type of a Server Component, hence
 * the explicit annotation.
 */
export default async function HomePage(): Promise<React.JSX.Element> {
  const headerList = await headers();
  const host = headerList.get('host') ?? '';
  const subdomain = host.split('.')[0] ?? '';

  return (
    <main className="mx-auto max-w-2xl p-12">
      <h1 className="text-3xl font-semibold">Orbitoz AI</h1>
      <p className="mt-4 text-neutral-600">
        Tenant: <code className="font-mono">{subdomain || '(none)'}</code>
      </p>
      <p className="mt-1 text-sm text-neutral-500">
        Resolved from host <code className="font-mono">{host || '(none)'}</code>
      </p>
    </main>
  );
}
