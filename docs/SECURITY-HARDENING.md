# Security Hardening

What this repository does to keep a CodFlow deployment safe, and what is
deliberately left to the operator. Every claim below is enforced by code,
config, or CI in this repo — nothing here is aspirational.

Run the checks yourself:

```sh
npm audit --audit-level=high     # dependency gate (also runs in CI)
npm test --workspace codflow-server
npm test --workspace codflow-client-astro
cd cod-astro/theme01 && npm test && npx astro check
```

---

## 1. Dependencies

- The root `package.json` carries one `overrides` block for the whole
  monorepo. It pins patched versions of transitive packages that published
  advisories: `proxy-addr`, `@modelcontextprotocol/sdk`, `body-parser`,
  `brace-expansion`, `deepmerge-ts`, `devalue`'s consumers, `happy-dom`,
  `http-cache-semantics`, `source-map-js`, `svgo`, `sharp`, `undici`,
  `esbuild`, `vite`, `zod`, plus `astro` and `@astrojs/check`.
- npm ignores `overrides` inside workspace members, which is why the block
  lives at the root.
- `vitest` / `@vitest/ui` / `@vitest/coverage-v8` / `@vitest/mocker` are
  held at `^5.0.5`; 5.0.0–5.0.4 carry the manual-mock code-injection and
  `server.fs.deny` advisories.
- `cod-server` uses `zod ^4.6.7` (the 4.6.6 fix for the oversized-collection
  memory advisory).
- CI runs `npm audit --audit-level=high` as its own job, so a high or critical
  advisory fails the build instead of landing silently.
- `.github/dependabot.yml` keeps the weekly bot PRs flowing per workspace.

## 2. Response headers

| Surface | Where | Headers |
| :--- | :--- | :--- |
| cod-server API | `src/middleware/security-headers.ts` | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Permitted-Cross-Domain-Policies: none`, `Permissions-Policy`, HSTS over HTTPS in non-development, and a `default-src 'none'` CSP on JSON responses |
| Dashboard (prerendered pages) | `cod-client-astro/public/_headers` | full CSP (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`), `nosniff`, `DENY`, `strict-origin-when-cross-origin`, HSTS, permissions policy |
| Dashboard (Worker routes: `/api/auth/*`, `/mcp/oauth/login`, `/reset-password/*`) | `cod-client-astro/src/lib/security-headers.ts` | the same set, applied in code because `_headers` only covers static assets |
| Storefront | `cod-astro/theme01/public/_headers` | `nosniff`, `SAMEORIGIN`, referrer policy, HSTS, permissions policy |

The API's HTML surfaces (OpenAPI reference, MCP consent page) intentionally do
not receive the JSON CSP — a document-wide `default-src 'none'` would break
them; they are protected by the frame and sniffing headers instead.

## 3. CORS

`cod-server/src/middleware/cors.ts` fails closed:

- A request from an origin that is not listed in `ALLOWED_ORIGINS` receives
  **no** `Access-Control-Allow-Origin` header, so the browser refuses to expose
  the response to the calling script.
- `*` is honoured only when it is explicitly configured **and** the environment
  is not `production`; a production deployment with no `ALLOWED_ORIGINS` emits
  no CORS headers at all rather than echoing the caller.
- Every response carries `Vary: Origin`.

## 4. Authentication and authorization

- Dashboard sessions are Better Auth cookies (`Secure`, `SameSite=Lax`,
  `codflow.` prefix) backed by D1; the API accepts the short-lived Ed25519 JWT
  issued by the `jwt()` plugin and verifies signature, `exp`, `iss`, and `aud`
  offline against the auth server's JWKS.
- API keys are compared only against the database; they are never embedded in
  JWT payloads (the plugin's `definePayload` whitelists id/email/role) and are
  stripped from every list/detail user response (`sanitize()` in
  `cod-shared/queries/users.ts`). The raw key is returned once, on create or
  rotate.
- Store keys are stored as SHA-256 hashes (`store_api_keys.key_hash`), never in
  clear text.
- RBAC scopes are resolved server-side per request; `admin` is the only role
  that receives `*`, and the MCP consent screen can never grant a scope the
  user does not hold.
- Better Auth rate limits are enabled (100 requests/minute, with
  `/request-password-reset` at 3/hour and magic links at 5/hour), self-service
  sign-up is disabled, and privileged fields (`role`, `status`, `apiKey`) are
  `input: false`, so `/update-user` cannot self-promote.
- Storefront OTP tokens are HMAC-signed and compared in constant time; the MCP
  login ticket uses an HMAC with a constant-time comparison and a single-use
  nonce; the MCP consent form uses a double-submit `__Host-` CSRF cookie.
- Carrier webhooks verify signatures with constant-time comparison
  (`yalidine-verify.ts`, Svix for ZR Express).

## 5. Residual risks (accepted, documented)

- `users.api_key` is stored in clear text because `X-API-Key` authentication is
  a direct lookup. It is account-scoped in D1, never listed, and never leaves
  the server except at creation/rotation.
- The Better Auth JWKS private key is stored unencrypted in D1
  (`disablePrivateKeyEncryption`) so a Worker-secret rotation cannot break
  `get-session`; the trade-off is that D1 access equals signing-key access.
- The storefront ships no CSP: merchant-installed pixels and custom domains
  make a template-level policy unsafe to guess. Operators who control their
  tags can add one in `cod-astro/theme01/public/_headers`.
- `cod-client-astro/scripts/security-probe.mjs` asserts the deployed surface
  (headers, closed registration, consent page, rate limits, auth wall, scope
  wall). Run it against every deployment; it is not part of CI because it needs
  a live dashboard and a real account.
