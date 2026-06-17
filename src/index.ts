/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-06-17
 * 用途：SKHPS 新後端 Cloudflare Worker。提供 health、ping、listExternalProjects。
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SKHPS_CACHE: KVNamespace;
}

type AppEnvironmentRow = {
  app_id: string;
  env: string;
  href: string | null;
  enabled: boolean;
  placement: string;
  sort_order: number;
  maintenance: boolean;
  metadata?: Record<string, unknown>;
};

type AppRow = {
  app_id: string;
  title: string;
  description: string | null;
  group_key: string | null;
  default_href: string | null;
  active: boolean;
};

type AppCardRow = {
  app_id: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  icon: string | null;
  badge: string | null;
  metadata?: Record<string, unknown>;
};

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

function getSupabaseHeaders(env: Env): HeadersInit {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

async function supabaseGet<T>(env: Env, path: string): Promise<T> {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/v1/${path.replace(/^\/+/, "")}`;

  const response = await fetch(url, {
    method: "GET",
    headers: getSupabaseHeaders(env)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SUPABASE_GET_FAILED ${response.status} ${text}`);
  }

  return await response.json() as T;
}

function normalizeEnv(input: unknown): "local" | "dev" | "prod" {
  const value = String(input || "prod").toLowerCase();
  if (value === "local" || value === "dev" || value === "prod") return value;
  return "prod";
}

async function listExternalProjects(env: Env, appEnv: "local" | "dev" | "prod") {
  const cacheKey = `external-apps:${appEnv}:v1`;

  try {
    const cached = await env.SKHPS_CACHE.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        ...parsed,
        source: "skhps-backend-kv"
      };
    }
  } catch {
    // cache 失敗不擋主流程
  }

  const environments = await supabaseGet<AppEnvironmentRow[]>(
    env,
    `app_environments?env=eq.${encodeURIComponent(appEnv)}&enabled=eq.true&placement=neq.hidden&order=sort_order.asc`
  );

  const apps = await supabaseGet<AppRow[]>(
    env,
    "apps?active=eq.true"
  );

  const cards = await supabaseGet<AppCardRow[]>(
    env,
    "app_cards"
  );

  const appMap = new Map(apps.map((row) => [row.app_id, row]));
  const cardMap = new Map(cards.map((row) => [row.app_id, row]));

  const items = environments
    .map((row) => {
      const app = appMap.get(row.app_id);
      const card = cardMap.get(row.app_id);

      if (!app) return null;

      const title = card?.title || app.title;
      const description = card?.description || app.description || "";

      return {
        appId: row.app_id,
        app_id: row.app_id,

        title,
        name: title,
        appName: title,

        subtitle: card?.subtitle || "",
        description,

        group: app.group_key || "frontend",
        groupKey: app.group_key || "frontend",

        href: row.href || app.default_href || "",
        url: row.href || app.default_href || "",

        env: row.env,
        enabled: row.enabled,
        active: app.active,
        placement: row.placement,
        sortOrder: row.sort_order,
        sort_order: row.sort_order,
        maintenance: row.maintenance,

        icon: card?.icon || "",
        badge: card?.badge || "",

        metadata: {
          app: app,
          environment: row.metadata || {},
          card: card?.metadata || {}
        }
      };
    })
    .filter(Boolean);

  const payload = {
    ok: true,
    action: "listExternalProjects",
    source: "skhps-backend-supabase",
    env: appEnv,
    count: items.length,
    cachedAt: new Date().toISOString(),
    items
  };

  try {
    await env.SKHPS_CACHE.put(cacheKey, JSON.stringify(payload), {
      expirationTtl: 60
    });
  } catch {
    // cache 寫入失敗不擋 response
  }

  return payload;
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

  if (action === "listExternalProjects") {
    try {
      const appEnv = normalizeEnv(body.env || body.payload?.env);
      const result = await listExternalProjects(env, appEnv);
      return json(result);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
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
