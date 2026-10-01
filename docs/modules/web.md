# `apps/web`

Next.js App Router front end.

## Tenant resolution

Server components read the `Host` header and derive the subdomain:

```tsx
export default async function HomePage(): Promise<React.JSX.Element> {
  const headerList = await headers();
  const host = headerList.get('host') ?? '';
  const subdomain = host.split('.')[0] ?? '';
  // ...
}
```

Same rule as the API gateway, on purpose. Two implementations of "which tenant is
this request for" would eventually disagree, and the disagreement would look like
a routing bug rather than a tenancy bug.

`headers()` is async in Next 15+, so it must be awaited. Next 16 does not infer a
Server Component's return type, hence the explicit `Promise<React.JSX.Element>`.

The subdomain alone is not enough to act on. It identifies the tenant for display;
the gateway is still the authority, and it re-resolves and re-checks.

## Local development

Subdomains of `localhost` resolve to `127.0.0.1` on most systems. The seeded
tenant is at `https://acme.localhost:3000`. If yours does not resolve, add
`127.0.0.1 acme.localhost` to `/etc/hosts`.

Mailpit runs on port 8025 for catching outbound mail locally.

## Scripts

| Command      | Purpose                    |
| ------------ | -------------------------- |
| `pnpm dev`   | Dev server on :3000        |
| `pnpm build` | Production build           |
| `pnpm start` | Serve the production build |
| `pnpm lint`  | ESLint                     |

`tsconfig.json` extends `@orbitoz/config/tsconfig/nextjs.json`. `@orbitoz/config`
must be a declared dependency even though nothing is imported at runtime —
TypeScript's `extends` resolves through the package's exports map, and pnpm's
strict `node_modules` will not find it otherwise.
