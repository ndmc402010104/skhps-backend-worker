/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-06-18
 * 用途：SKHPS 新後端 Cloudflare Worker。
 *
 * 目前提供：
 * - GET  /api/health
 * - POST /api/action
 *   - ping
 *   - listExternalProjects
 *   - getQuickLoginStaff（讀 Supabase 共用人員主檔 StaffMaster）
 * - POST /api/upload-file
 *
 * 原則：
 * - /api/upload-file 是背景 backend 行為。
 * - 不屬於 loading gate。
 * - 不要把 uploadFile 加進 loadingTasks。
 * - Supabase key 只存在 Cloudflare / .dev.vars，不進前端、不進 config.json。
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  SUPABASE_STORAGE_BUCKET?: string;
  SUPABASE_UPLOAD_TABLE?: string;
  SUPABASE_STAFF_TABLE?: string;
  MAX_FILE_SIZE_BYTES?: string;

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

type StaffMasterRow = Record<string, unknown>;

type UploadRecord = {
  app_id: string;
  env: string;
  bucket: string;
  object_path: string;
  original_name: string | null;
  content_type: string | null;
  size_bytes: number;
  source: string;
  status: string;
  meta: Record<string, unknown>;
};

/*
 * 不直接用 File / FormDataEntryValue 型別，避免目前 tsconfig / worker types 報錯。
 * 實際 Cloudflare Worker 裡 formData().get("file") 會拿到類 File/Blob 物件。
 */
type WorkerUploadFile = Blob & {
  name?: string;
  size: number;
  type?: string;
};

const DEFAULT_UPLOAD_BUCKET = "skhps-uploads";
const DEFAULT_UPLOAD_TABLE = "skhps_file_uploads";
const DEFAULT_STAFF_TABLE = "StaffMaster";
const DEFAULT_MAX_FILE_SIZE_BYTES = 6 * 1024 * 1024;

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-SKHPS-Client,X-SKHPS-App-Id,X-SKHPS-Env"
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

function getSupabaseBaseUrl(env: Env): string {
  if (!env.SUPABASE_URL) {
    throw new Error("MISSING_SUPABASE_URL");
  }

  return env.SUPABASE_URL.replace(/\/+$/, "");
}

function getSupabaseHeaders(env: Env): HeadersInit {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

async function supabaseGet<T>(env: Env, path: string): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
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

async function supabasePost<T>(
  env: Env,
  table: string,
  record: Record<string, unknown>
): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
  const safeTable = table.replace(/^\/+/, "");

  const response = await fetch(`${baseUrl}/rest/v1/${safeTable}`, {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(env),
      "Prefer": "return=representation"
    },
    body: JSON.stringify(record)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SUPABASE_POST_FAILED ${response.status} ${text}`);
  }

  try {
    return text ? JSON.parse(text) as T : ([] as T);
  } catch {
    return [{ raw: text }] as T;
  }
}

function normalizeEnv(input: unknown): "local" | "dev" | "prod" {
  const value = String(input || "prod").toLowerCase();
  if (value === "local" || value === "dev" || value === "prod") return value;
  return "prod";
}

function sanitizeSegment(input: unknown, fallback = "unknown"): string {
  const value = String(input || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/\.+$/, "")
    .slice(0, 120);

  return value || fallback;
}

function getSafeStorageFileName(file: WorkerUploadFile): string {
  const originalName = getUploadFileName(file);
  const dotIndex = originalName.lastIndexOf(".");
  const rawBase = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  const rawExt = dotIndex > 0 ? originalName.slice(dotIndex + 1) : "";

  const safeBase = sanitizeSegment(rawBase, "upload");
  const safeExt = sanitizeSegment(rawExt, "");

  if (safeExt) {
    return safeBase + "." + safeExt;
  }

  return safeBase;
}

function encodeObjectPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseMeta(input: unknown): Record<string, unknown> {
  if (!input) return {};

  try {
    const parsed = JSON.parse(String(input));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function isUploadedFile(value: unknown): value is WorkerUploadFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<WorkerUploadFile>;

  return (
    typeof candidate.arrayBuffer === "function" &&
    typeof candidate.size === "number"
  );
}

function getUploadBucket(env: Env, form: FormData): string {
  return String(
    form.get("bucket") ||
    env.SUPABASE_STORAGE_BUCKET ||
    DEFAULT_UPLOAD_BUCKET
  );
}

function getUploadTable(env: Env): string {
  return String(env.SUPABASE_UPLOAD_TABLE || DEFAULT_UPLOAD_TABLE);
}

function getMaxFileSize(env: Env): number {
  const value = Number(env.MAX_FILE_SIZE_BYTES || DEFAULT_MAX_FILE_SIZE_BYTES);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_FILE_SIZE_BYTES;
  return value;
}

function getUploadFileName(file: WorkerUploadFile): string {
  return String(file.name || "upload.bin");
}

function getUploadFileType(file: WorkerUploadFile): string {
  return String(file.type || "application/octet-stream");
}

function makeObjectPath(input: {
  appId: string;
  envName: string;
  file: WorkerUploadFile;
  requestedPath: string;
}): string {
  if (input.requestedPath) {
    return String(input.requestedPath)
      .replace(/^\/+/, "")
      .replace(/\.\./g, "_");
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  const safeAppId = sanitizeSegment(input.appId, "unknown-app");
  const safeEnv = sanitizeSegment(input.envName, "unknown");
  const safeName = getSafeStorageFileName(input.file);
  const randomId = crypto.randomUUID();

  return `${safeAppId}/${safeEnv}/${yyyy}/${mm}/${dd}/${randomId}-${safeName}`;
}

async function uploadToSupabaseStorage(input: {
  env: Env;
  bucket: string;
  objectPath: string;
  file: WorkerUploadFile;
}): Promise<unknown> {
  const baseUrl = getSupabaseBaseUrl(input.env);

  const url =
    `${baseUrl}/storage/v1/object/` +
    `${encodeURIComponent(input.bucket)}/` +
    `${encodeObjectPath(input.objectPath)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": input.env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${input.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": getUploadFileType(input.file),
      "x-upsert": "false"
    },
    body: input.file
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SUPABASE_STORAGE_UPLOAD_FAILED ${response.status} ${text}`);
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
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



function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstValue(row: StaffMasterRow, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
  }

  return null;
}

function stringValue(row: StaffMasterRow, keys: string[], fallback = ""): string {
  const value = firstValue(row, keys);
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function numberValue(row: StaffMasterRow, keys: string[], fallback = 999): number {
  const value = firstValue(row, keys);
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function booleanValue(row: StaffMasterRow, keys: string[], fallback = true): boolean {
  const value = firstValue(row, keys);

  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const text = String(value).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y", "是", "啟用", "允許"].includes(text)) return true;
  if (["false", "f", "0", "no", "n", "否", "停用", "不允許"].includes(text)) return false;

  return fallback;
}

function rowMetadata(row: StaffMasterRow): Record<string, unknown> {
  const raw = row.metadata || row.Metadata || row["metadata"];
  if (isPlainObject(raw)) return raw;
  return {};
}

function metadataString(row: StaffMasterRow, metadata: Record<string, unknown>, keys: string[], fallback = ""): string {
  const direct = stringValue(row, keys, "");
  if (direct) return direct;

  for (const key of keys) {
    const value = metadata[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return fallback;
}

function metadataBoolean(row: StaffMasterRow, metadata: Record<string, unknown>, keys: string[], fallback = true): boolean {
  const direct = firstValue(row, keys);
  if (direct !== undefined && direct !== null && String(direct).trim() !== "") {
    return booleanValue(row, keys, fallback);
  }

  for (const key of keys) {
    const value = metadata[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      const text = String(value).trim().toLowerCase();
      if (["true", "t", "1", "yes", "y", "是", "啟用", "允許"].includes(text)) return true;
      if (["false", "f", "0", "no", "n", "否", "停用", "不允許"].includes(text)) return false;
    }
  }

  return fallback;
}

function toQuickLoginPerson(row: StaffMasterRow, tableName: string) {
  const metadata = rowMetadata(row);

  const name = stringValue(row, ["姓名", "display_name", "name", "Name"]);
  const emp = stringValue(row, ["員工編號", "staff_code", "emp", "employee_id", "staff_id"]);
  const role = metadataString(row, metadata, ["職級", "role", "title"], "");
  const group = metadataString(row, metadata, ["分組", "group_key", "group"], "");
  const note = metadataString(row, metadata, ["備註", "note"], "");
  const sortOrder = numberValue(row, ["排序", "sort_order", "sortOrder"], 999);
  const updatedAt = stringValue(row, ["更新時間", "updated_at", "updatedAt"], "");

  const active = booleanValue(row, ["啟用", "active", "enabled"], true);
  const allowQuickLogin = metadataBoolean(row, metadata, ["允許快速登入", "allow_quick_login", "allowQuickLogin"], true);

  return {
    id: emp,
    name,
    emp,
    role,
    title: role,
    group,
    sortOrder,
    sort_order: sortOrder,
    active,
    enabled: active,
    allowQuickLogin,
    allow_quick_login: allowQuickLogin,
    note,
    updatedAt,
    metadata: {
      ...metadata,
      staffTable: tableName,
      group_key: group,
      note
    },
    source: "supabase"
  };
}

function getStaffTable(env: Env): string {
  return String(env.SUPABASE_STAFF_TABLE || DEFAULT_STAFF_TABLE).trim() || DEFAULT_STAFF_TABLE;
}

async function getQuickLoginStaff(env: Env, appEnv: "local" | "dev" | "prod") {
  const tableName = getStaffTable(env);
  const cacheKey = `quick-login-staff:${tableName}:${appEnv}:v2`;

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

  const rows = await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?select=*`
  );

  const staffList = rows
    .map((row) => toQuickLoginPerson(row, tableName))
    .filter((person) => person.active && person.allowQuickLogin && person.name && person.emp)
    .sort((a, b) => {
      const orderDiff = Number(a.sortOrder || 999) - Number(b.sortOrder || 999);
      if (orderDiff !== 0) return orderDiff;
      return String(a.emp || "").localeCompare(String(b.emp || ""));
    });

  const payload = {
    ok: true,
    action: "getQuickLoginStaff",
    source: "skhps-backend-supabase",
    env: appEnv,
    staffTable: tableName,
    count: staffList.length,
    cachedAt: new Date().toISOString(),
    staffList,
    extraList: []
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

async function handleUploadFile(request: Request, env: Env): Promise<Response> {
  const contentType =
    request.headers.get("Content-Type") ||
    request.headers.get("content-type") ||
    "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({
      ok: false,
      action: "uploadFile",
      error: "CONTENT_TYPE_NOT_ALLOWED",
      message: "uploadFile requires multipart/form-data"
    }, 415);
  }

  const form = await request.formData();

  const maybeFile = form.get("file");

  if (!isUploadedFile(maybeFile)) {
    return json({
      ok: false,
      action: "uploadFile",
      error: "FILE_REQUIRED",
      message: "Missing form field: file"
    }, 400);
  }

  const file = maybeFile;
  const maxSize = getMaxFileSize(env);

  if (file.size > maxSize) {
    return json({
      ok: false,
      action: "uploadFile",
      error: "FILE_TOO_LARGE",
      sizeBytes: file.size,
      maxSizeBytes: maxSize
    }, 413);
  }

  const appId = String(
    form.get("appId") ||
    request.headers.get("X-SKHPS-App-Id") ||
    "unknown-app"
  );

  const envName = String(
    form.get("env") ||
    request.headers.get("X-SKHPS-Env") ||
    "unknown"
  );

  const bucket = getUploadBucket(env, form);
  const table = getUploadTable(env);
  const requestedPath = String(form.get("path") || "");
  const meta = parseMeta(form.get("meta"));

  const objectPath = makeObjectPath({
    appId,
    envName,
    file,
    requestedPath
  });

  const storageResult = await uploadToSupabaseStorage({
    env,
    bucket,
    objectPath,
    file
  });

  const record: UploadRecord = {
    app_id: appId,
    env: envName,
    bucket,
    object_path: objectPath,
    original_name: getUploadFileName(file),
    content_type: getUploadFileType(file),
    size_bytes: file.size || 0,
    source: "cloudflare-worker",
    status: "uploaded",
    meta: {
      ...meta,
      storageResult
    }
  };

  const inserted = await supabasePost<UploadRecord[]>(env, table, record);

  return json({
    ok: true,
    action: "uploadFile",
    source: "skhps-backend-supabase-storage",
    bucket,
    path: objectPath,
    file: {
      name: getUploadFileName(file),
      type: getUploadFileType(file),
      size: file.size
    },
    record: Array.isArray(inserted) ? inserted[0] : inserted
  });
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

  if (action === "getQuickLoginStaff") {
    try {
      const appEnv = normalizeEnv(body.env || body.payload?.env);
      const result = await getQuickLoginStaff(env, appEnv);
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

  if (action === "uploadFile") {
    return json({
      ok: false,
      action,
      error: "UPLOAD_FILE_REQUIRES_MULTIPART",
      message: "Use POST /api/upload-file with multipart/form-data. Do not send files through /api/action JSON."
    }, 400);
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
        version: "0.1.2-hidden-upload-staff-race",
        kvBinding: !!env.SKHPS_CACHE,
        hasSupabaseUrl: !!env.SUPABASE_URL,
        hasSupabaseServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
        upload: {
          route: "/api/upload-file",
          bucket: env.SUPABASE_STORAGE_BUCKET || DEFAULT_UPLOAD_BUCKET,
          table: env.SUPABASE_UPLOAD_TABLE || DEFAULT_UPLOAD_TABLE,
          maxFileSizeBytes: getMaxFileSize(env),
          affectsGate: false
        }
      });
    }

    if (url.pathname === "/api/action" && request.method === "POST") {
      return handleAction(request, env);
    }

    if (url.pathname === "/api/upload-file" && request.method === "POST") {
      try {
        return await handleUploadFile(request, env);
      } catch (error) {
        return json({
          ok: false,
          action: "uploadFile",
          source: "skhps-backend",
          error: error instanceof Error ? error.message : String(error)
        }, 500);
      }
    }

    return json({
      ok: false,
      error: "NOT_FOUND",
      path: url.pathname
    }, 404);
  }
};