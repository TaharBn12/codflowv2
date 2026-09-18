import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createAuth, type AuthEnv } from "@/lib/auth/server";

export const prerender = false;

const ALL: APIRoute = async (ctx) => {
  // Request.cf carries IP/geo metadata only on the Workers runtime.
  const req = ctx.request as Request & { cf?: unknown };
  const auth = createAuth(env as unknown as AuthEnv, { cf: req.cf });
  try {
    return await auth.handler(ctx.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[auth] unhandled request error", error);
    return new Response(message, { status: 500 });
  }
};

export const GET = ALL;
export const POST = ALL;
