/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-06-17
 * 用途：SKHPS 新後端 Cloudflare Worker 最小骨架。提供 /api/health 與 /api/action ping。
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SKHPS_CACHE: KVNamespace;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-SKHPS-Client"
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleAction(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const action = String(body.action || "");

  if (!action) {
    return json({
      ok: false,
      error: "MISSING_ACTION"
    }, 400);
  }

  if (action === "ping") {
    let kvOk = false;

    try {
      await env.SKHPS_CACHE.put("health:ping", new Date().toISOString());
      const value = await env.SKHPS_CACHE.get("health:ping");
      kvOk = !!value;
    } catch {
      kvOk = false;
    }

    return json({
      ok: true,
      action: "ping",
      source: "skhps-backend",
      env: body.env || null,
      kvOk,
      hasSupabaseUrl: !!env.SUPABASE_URL,
      hasSupabaseServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY
    });
  }

  return json({
    ok: false,
    error: "UNKNOWN_ACTION",
    action
  }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "skhps-backend",
        version: "0.1.0",
        kvBinding: !!env.SKHPS_CACHE,
        hasSupabaseUrl: !!env.SUPABASE_URL,
        hasSupabaseServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY
      });
    }

    if (url.pathname === "/api/action" && request.method === "POST") {
      return handleAction(request, env);
    }

    return json({
      ok: false,
      error: "NOT_FOUND",
      path: url.pathname
    }, 404);
  }
};
