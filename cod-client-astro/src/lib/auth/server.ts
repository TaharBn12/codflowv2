import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { jwt } from "better-auth/plugins";
import { getDb } from "../../../../cod-shared/db/client";
import { getStore } from "../../../../cod-shared/queries/stores";
import { renderPasswordResetEmail } from "../../../../cod-shared/lib/email-templates";
import { sendTransactionalEmail } from "../../../../cod-shared/lib/transactional-email";

export interface AuthEnv {
  DB: D1Database;
  RATE_LIMIT_KV: KVNamespace;
  PUBLIC_APP_URL: string;
  PUBLIC_API_URL: string;
  PUBLIC_TRUSTED_ORIGINS?: string;
  BETTER_AUTH_SECRET: string;
  /**
   * HMAC secret (>= 32 bytes) shared with cod-server for the MCP OAuth login
   * tickets minted after a successful sign-in. Optional: when missing or too
   * short, the MCP authorize relay fails closed.
   */
  MCP_LOGIN_TICKET_SECRET?: string;
}

interface AuthCloudflareContext {
  /** Incoming-request metadata (Request.cf) for IP/geo resolution.
   *  NOTE: withCloudflare@0.3.1 has no ctx/waitUntil option — background
   *  task survival lands when the package gains it (backlog). */
  cf?: {
    country?: string;
    city?: string;
    latitude?: string;
    longitude?: string;
    [key: string]: unknown;
  };
}

// One instance per request — never a module singleton. Two Drizzle wrappers
// around the same D1 binding contend on SQLite's write lock (documented
// better-auth-on-Workers failure mode).
export function createAuth(env: AuthEnv, cloudflare?: AuthCloudflareContext) {
  const db = getDb(env.DB);

  const kv = env.RATE_LIMIT_KV;
  const secondaryStorage = {    get: (key: string) => kv.get(key),
    getAndDelete: async (key: string) => {
      const value = await kv.get(key);
      await kv.delete(key);
      return value;
    },
    set: (key: string, value: string, ttl?: number) =>
      kv.put(key, value, ttl ? { expirationTtl: Math.max(60, Math.ceil(ttl)) } : undefined),
    delete: (key: string) => kv.delete(key),
    increment: async (key: string, ttl?: number): Promise<number> => {
      const previous = await kv.get(key);
      const next = (previous ? Number.parseInt(previous, 10) : 0) + 1;
      await kv.put(
        key,
        String(next),
        previous ? undefined : { expirationTtl: Math.max(60, Math.ceil(ttl ?? 60)) }
      );
      return next;
    },
  };

  return betterAuth({
    ...withCloudflare(
      {
        cf: cloudflare?.cf,
        autoDetectIpAddress: false,
        geolocationTracking: false,
        d1: {
          db,
          options: {
            usePlural: true,
            transaction: false,
          },
        },
      },
      {
        baseURL: env.PUBLIC_APP_URL,
        secret: env.BETTER_AUTH_SECRET,
        secondaryStorage,
        trustedOrigins: [
          ...(import.meta.env.DEV ? ["http://localhost:4321"] : []),
          ...(env.PUBLIC_TRUSTED_ORIGINS ?? "")
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean),
        ],
        disabledPaths: ["/token"],
        session: {
          storeSessionInDatabase: true,
          // Do not combine Better Auth's signed cookie cache with customSession.
          // Upstream joins/decodes the two Set-Cookie values incorrectly on
          // Workers, so sign-in succeeds but get-session returns 500 and the UI
          // immediately redirects back to /sign-in. D1 is the source of truth.
        },
        advanced: {
          // Version the cookie namespace so browsers ignore malformed legacy
          // `better-auth.session_data` cookies left by the old configuration.
          cookiePrefix: "codflow",
          defaultCookieAttributes: {
            secure: true,
            sameSite: "lax",
            path: "/",
          },
          ipAddress: {
            ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
          },
        },
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
          customRules: {
            "/request-password-reset": { window: 3600, max: 3 },
            "/sign-in/magic-link": { window: 3600, max: 5 },
          },
        },
        emailAndPassword: {
          enabled: true,
          autoSignIn: true,
          // No self-service registration: accounts are provisioned by an admin.
          disableSignUp: true,
          /**
           * Password-reset email via the shared Sendili send path.
           *
           * Security contract: this callback runs only for users that exist,
           * while better-auth answers unknown emails with the same generic
           * "check your email" response — so the callback must never throw
           * or change observable behavior (no enumeration). Every failure is
           * caught here, logged with its stable code, and swallowed.
           * Residual risk (accepted): the provider round-trip adds latency
           * only for existing emails — a timing side channel mitigated by the
           * 3/hour rate limit on /request-password-reset.
           */
          sendResetPassword: async ({ user, url, token }) => {
            try {
              const store = await getStore(db);
              const language = (user as { language?: string }).language === "ar" ? "ar" : "en";
              const email = renderPasswordResetEmail({
                storeName: store?.name ?? "CodFlow",
                userName: user.name,
                resetUrl: url,
                language,
              });
              const outcome = await sendTransactionalEmail(db, {
                to: user.email,
                subject: email.subject,
                html: email.html,
                text: email.text,
                idempotencyKey: `reset-${user.id}-${token.slice(0, 12)}`,
              });
              if (!outcome.sent && outcome.error) {
                console.error("[auth] password-reset email failed:", outcome.error);
              }
            } catch (err) {
              console.error("[auth] password-reset email error:", err);
            }
          },
        },
        user: {
          additionalFields: {
            /**
             * Privileged fields are `input: false` — better-auth's
             * session-authenticated /update-user must never accept them, or
             * any staff member could self-promote (`{role:"admin"}` was
             * accepted before this). Admin-side changes go through
             * cod-server's PATCH /api/users/:id, which writes D1 directly.
             */
            role:     { type: "string", defaultValue: "staff",  required: false, input: false },
            status:   { type: "string", defaultValue: "active", required: false, input: false },
            apiKey:   { type: "string", required: false, input: false },
            /** Email language preference — the one field users may self-edit. */
            language: { type: "string", defaultValue: "en", required: false },
          },
        },
        plugins: [
          // Keep get-session on Better Auth's native response path. The
          // customSession plugin currently throws on Cloudflare Workers after
          // a successful sign-in, producing the dashboard redirect loop. Admin
          // authorization remains server-enforced; staff scopes are loaded by
          // protected API endpoints rather than embedded in this response.
          jwt({
            jwks: {
              // GitHub recovery deployments cannot read an existing Worker
              // secret back from Cloudflare. Keeping the JWK unencrypted
              // prevents a secret rotation from making get-session return 500;
              // D1 and Worker access remain account-protected.
              disablePrivateKeyEncryption: true,
            },
            jwt: {
              // Tokens are issued FOR the API resource, matching cod-server's
              // sessionAuth audience check (docs: "Modify Issuer, Audience…").
              audience: env.PUBLIC_API_URL,
              // Default payload embeds the ENTIRE user row — including the
              // plaintext apiKey additionalField. Whitelist instead.
              definePayload: ({ user }) => ({
                id: user.id,
                email: user.email,
                role: (user as { role?: string }).role ?? "staff",
              }),
            },
          }),
        ],
      }
    ),
  });
}

