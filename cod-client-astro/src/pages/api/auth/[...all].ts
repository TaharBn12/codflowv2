import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createAuth, type AuthEnv } from "@/lib/auth/server";

export const prerender = false;

const ALL: APIRoute = async (ctx) => {
  // Request.cf carries IP/geo metadata only on the Workers runtime.
  const req = ctx.request as Request & { cf?: unknown };
  const authEnv = env as unknown as AuthEnv;
  const auth = createAuth(authEnv, { cf: req.cf });
  const response = await auth.handler(ctx.request);

  // Enrich the native Better Auth session response without customSession
  // (which is unreliable on Workers). This keeps navigation truthful while
  // cod-server still performs the authoritative scope check on every request.
  if (ctx.url.pathname.endsWith("/get-session") && response.ok) {
    const body = await response.clone().json() as { user?: { id?: string; role?: string } } | null;
    if (body?.user?.id) {
      const result = await authEnv.DB.prepare("SELECT scope FROM user_scopes WHERE user_id = ?")
        .bind(body.user.id).all<{ scope: string }>();
      const scopes = body.user.role === "admin" ? ["*"] : result.results.map((row) => row.scope);
      return new Response(JSON.stringify({ ...body, scopes }), {
        status: response.status,
        headers: response.headers,
      });
    }
  }
  return response;
};

export const GET = ALL;
export const POST = ALL;
