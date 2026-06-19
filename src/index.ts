/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-06-19 00:42 UTC+8
 * 用途：SKHPS 新後端 Cloudflare Worker。
 *
 * 目前提供：
 * - GET  /api/health
 * - POST /api/action
 *   - ping
 *   - listExternalProjects
 *   - listExternalProjectsForLauncher
 *   - registerExternalApp
 *   - updateExternalProjectActivation / updateExternalAppSettings / setExternalAppActive
 *   - getQuickLoginStaff（讀 Supabase 共用人員主檔 StaffMaster）
 * - POST /api/upload-file
 *
 * 原則：
 * - /api/upload-file 是背景 backend 行為。
 * - 不屬於 loading gate。
 * - 不要把 uploadFile 加進 loadingTasks。
 * - Supabase key 只存在 Cloudflare / .dev.vars，不進前端、不進 config.json。
 * - ExternalProject registry 不使用 KV / cache，每次讀取都直接查 Supabase。
 */


export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  SUPABASE_STORAGE_BUCKET?: string;
  SUPABASE_UPLOAD_TABLE?: string;
  SUPABASE_STAFF_TABLE?: string;
  SUPABASE_EXTERNAL_PROJECT_TABLE?: string;
  MAX_FILE_SIZE_BYTES?: string;
}

type AppEnvName = "local-dev" | "dev" | "prod";

type ExternalProjectRegistryRow = {
  registry_key: string;
  project_id: string;
  root_app_id: string | null;
  page_id: string | null;
  env: string;
  title: string;
  description: string | null;
  href: string;
  display_position: string | null;
  group_name: string | null;
  sort_order: number | null;
  enabled: boolean;
  show_on_home: boolean | null;
  show_on_backend: boolean | null;
  show_in_launcher: boolean | null;
  registry_role: string | null;
  registry_reason: string | null;
  default_position: string | null;
  version: string | null;
  version_raw: string | null;
  manifest_url: string | null;
  register_external_app: boolean | null;
  backend_required: boolean | null;
  features_css_runtime: boolean | null;
  features_header: boolean | null;
  features_footer: boolean | null;
  features_runtime_panel: boolean | null;
  features_backend_client: boolean | null;
  last_report_at: string | null;
  report_count: number | null;
  source: string | null;
  created_at: string | null;
  updated_at: string | null;
  notes: string | null;
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
const DEFAULT_EXTERNAL_PROJECT_TABLE = "ExternalProject";
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


async function supabasePatch<T>(
  env: Env,
  table: string,
  query: string,
  patch: Record<string, unknown>
): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
  const safeTable = table.replace(/^\/+/, "");
  const safeQuery = query.replace(/^\?+/, "");

  const response = await fetch(`${baseUrl}/rest/v1/${safeTable}?${safeQuery}`, {
    method: "PATCH",
    headers: {
      ...getSupabaseHeaders(env),
      "Prefer": "return=representation"
    },
    body: JSON.stringify(patch)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SUPABASE_PATCH_FAILED ${response.status} ${text}`);
  }

  try {
    return text ? JSON.parse(text) as T : ([] as T);
  } catch {
    return [{ raw: text }] as T;
  }
}

async function supabaseUpsert<T>(
  env: Env,
  table: string,
  records: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string
): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
  const safeTable = table.replace(/^\/+/, "");
  const path = `${safeTable}?on_conflict=${encodeURIComponent(onConflict)}`;

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(env),
      "Prefer": "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(records)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SUPABASE_UPSERT_FAILED ${response.status} ${text}`);
  }

  try {
    return text ? JSON.parse(text) as T : ([] as T);
  } catch {
    return [{ raw: text }] as T;
  }
}

function normalizeVersionValue(value: unknown): string {
  if (value === undefined || value === null) return "";

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return String(
      objectValue.version ||
      objectValue.appVersion ||
      objectValue.buildVersion ||
      objectValue.buildTime ||
      ""
    ).trim();
  }

  const text = String(value || "").trim();
  return text === "[object Object]" ? "" : text;
}

function normalizePlacement(input: unknown): "frontend" | "backend" | "hidden" {
  const value = String(input || "").trim().toLowerCase();

  if (input === "前台" || value === "front" || value === "frontend") return "frontend";
  if (input === "後台" || value === "back" || value === "backend" || value === "admin") return "backend";
  return "hidden";
}

function placementLabel(input: unknown): "" | "前台" | "後台" {
  const placement = normalizePlacement(input);
  if (placement === "frontend") return "前台";
  if (placement === "backend") return "後台";
  return "";
}

function booleanFromUnknown(input: unknown): boolean {
  if (input === true || input === 1) return true;
  const text = String(input || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "y" || text === "on" || text === "啟用" || text === "是";
}

function numberFromUnknown(input: unknown, fallback: number): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function normalizeRegistryPayload(body: any): Record<string, unknown> {
  const payload = body && body.payload && typeof body.payload === "object" ? body.payload : body || {};
  return payload as Record<string, unknown>;
}

function normalizeExternalAppRegisterPayload(input: Record<string, unknown>): {
  appId: string;
  rootAppId: string;
  env: AppEnvName;
  title: string;
  href: string;
  group: string;
  version: string;
  description: string;
  pageId: string;
  pageTitle: string;
  pageHref: string;
  showInLauncher: boolean;
  registryRole: string;
  registryReason: string;
  defaultPosition: string;
} {
  const config = input.config && typeof input.config === "object" ? input.config as Record<string, unknown> : input;
  const appId = firstText(config.appId, config.id, input.appId, input.rootAppId, input.projectId, input.id);
  const rootAppId = firstText(input.rootAppId, config.rootAppId, appId);
  const envName = normalizeEnv(firstText(config.env, input.env, input.runtime, input.requestedRuntime));
  const title = firstText(config.title, config.name, input.title, appId);
  const href = firstText(config.href, config.url, input.href, input.url, input.pageUrl);
  const group = firstText(config.group, config.category, input.group, input.category);
  const version = normalizeVersionValue(config.version || input.version);
  const description = firstText(config.description, input.description);
  const pageId = firstText(input.pageId, config.pageId, appId);
  const pageTitle = firstText(input.pageTitle, config.pageTitle, title);
  const pageHref = firstText(input.pageHref, config.pageHref, href);
  const registryFromInput = input.registry && typeof input.registry === "object" && !Array.isArray(input.registry)
    ? input.registry as Record<string, unknown>
    : {};
  const registryFromConfig = config.registry && typeof config.registry === "object" && !Array.isArray(config.registry)
    ? config.registry as Record<string, unknown>
    : {};
  const registry = {
    ...registryFromConfig,
    ...registryFromInput
  };
  const rawShowInLauncher =
    registry.showInLauncher ??
    input.showInLauncher ??
    input.show_in_launcher ??
    input.launcherVisible ??
    input.visibleInLauncher;
  const showInLauncher = rawShowInLauncher === undefined || rawShowInLauncher === null || String(rawShowInLauncher).trim() === ""
    ? input.registerExternalApp === false ? false : true
    : booleanFromUnknown(rawShowInLauncher);
  const registryRole = firstText(registry.role, registry.registryRole, input.registryRole, input.registry_role, input.role);
  const registryReason = firstText(registry.reason, registry.registryReason, registry.hiddenReason, input.registryReason, input.registry_reason, input.reason);
  const defaultPosition = firstText(registry.defaultPosition, registry.defaultDisplayPosition, registry.displayPosition, registry.position, input.defaultPosition, input.default_position);

  return {
    appId,
    rootAppId,
    env: envName,
    title,
    href,
    group,
    version,
    description,
    pageId,
    pageTitle,
    pageHref,
    showInLauncher,
    registryRole,
    registryReason,
    defaultPosition
  };
}

function normalizeEnv(input: unknown): AppEnvName {
  const value = String(input || "prod").trim().toLowerCase();

  if (value === "local-dev" || value === "local" || value === "localhost") {
    return "local-dev";
  }

  if (value === "dev") return "dev";
  if (value === "prod" || value === "production") return "prod";

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

function getExternalProjectTable(_env?: Env): string {
  /*
   * 固定使用 Supabase 目前實際建立的單表名稱：ExternalProject。
   * 不再讀 SUPABASE_EXTERNAL_PROJECT_TABLE，避免 Cloudflare secret / 舊環境變數
   * 把 table name 蓋回 external_project_registry，造成 PGRST205 404。
   */
  return DEFAULT_EXTERNAL_PROJECT_TABLE;
}

function makeRegistryKey(projectId: unknown, appEnv: unknown): string {
  return `${String(projectId || "").trim()}__${normalizeEnv(appEnv)}`;
}

function projectIdFromRegisterPayload(payload: ReturnType<typeof normalizeExternalAppRegisterPayload>): string {
  const rootAppId = firstText(payload.rootAppId, payload.appId);
  const pageId = firstText(payload.pageId, rootAppId);

  if (pageId && pageId !== rootAppId) {
    return pageId;
  }

  return rootAppId;
}

function rootAppIdFromRegisterPayload(payload: ReturnType<typeof normalizeExternalAppRegisterPayload>): string {
  return firstText(payload.rootAppId, payload.appId, payload.pageId);
}

function pageIdFromRegisterPayload(payload: ReturnType<typeof normalizeExternalAppRegisterPayload>, projectId: string): string {
  return firstText(payload.pageId, projectId);
}

function inferManifestUrl(href: string): string {
  if (!href) return "";

  try {
    const url = new URL(href);
    const path = url.pathname || "/";

    if (path.toLowerCase().endsWith(".html")) {
      url.pathname = path.replace(/\/[^/]*$/, "/app.json");
    } else if (path.endsWith("/")) {
      url.pathname = path + "app.json";
    } else {
      url.pathname = path + "/app.json";
    }

    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const base = String(href || "").split("?")[0].split("#")[0];
    if (base.toLowerCase().endsWith(".html")) {
      return base.replace(/\/[^/]*$/, "/app.json");
    }
    return base.replace(/\/+$/, "") + "/app.json";
  }
}

function normalizeRegistryRow(row: ExternalProjectRegistryRow): Record<string, unknown> {
  const projectId = firstText(row.project_id, row.registry_key && String(row.registry_key).split("__")[0]);
  const rootAppId = firstText(row.root_app_id, projectId);
  const pageId = firstText(row.page_id, projectId);
  const displayPosition = placementLabel(row.display_position);
  const enabled = booleanFromUnknown(row.enabled);
  const sortOrder = numberFromUnknown(row.sort_order, 9999);
  const reportCount = numberFromUnknown(row.report_count, 0);
  const groupName = firstText(row.group_name, "院內系統");
  const version = normalizeVersionValue(row.version);
  const versionRaw = firstText(row.version_raw);

  return {
    registryKey: row.registry_key,
    registry_key: row.registry_key,

    projectId,
    project_id: projectId,
    appId: projectId,
    app_id: projectId,
    rootAppId,
    root_app_id: rootAppId,
    pageId,
    page_id: pageId,

    title: firstText(row.title, projectId),
    name: firstText(row.title, projectId),
    appName: firstText(row.title, projectId),
    description: firstText(row.description),
    href: firstText(row.href),
    url: firstText(row.href),
    env: normalizeEnv(row.env),

    enabled,
    active: enabled,
    displayPosition,
    "顯示位置": displayPosition,
    placement: normalizePlacement(row.display_position),
    location: normalizePlacement(row.display_position),
    group: groupName,
    groupKey: groupName,
    group_key: groupName,
    groupName,
    group_name: groupName,

    sortOrder,
    sort_order: sortOrder,
    order: sortOrder,
    sort: sortOrder,

    showOnHome: booleanFromUnknown(row.show_on_home),
    show_on_home: booleanFromUnknown(row.show_on_home),
    showOnBackend: booleanFromUnknown(row.show_on_backend),
    show_on_backend: booleanFromUnknown(row.show_on_backend),
    showInLauncher: row.show_in_launcher === null || row.show_in_launcher === undefined ? true : booleanFromUnknown(row.show_in_launcher),
    show_in_launcher: row.show_in_launcher === null || row.show_in_launcher === undefined ? true : booleanFromUnknown(row.show_in_launcher),
    registryRole: firstText(row.registry_role),
    registry_role: firstText(row.registry_role),
    registryReason: firstText(row.registry_reason),
    registry_reason: firstText(row.registry_reason),
    defaultPosition: placementLabel(row.default_position),
    default_position: normalizePlacement(row.default_position),

    version,
    versionRaw,
    version_raw: versionRaw,
    manifestUrl: firstText(row.manifest_url),
    manifest_url: firstText(row.manifest_url),
    registerExternalApp: booleanFromUnknown(row.register_external_app),
    register_external_app: booleanFromUnknown(row.register_external_app),
    backendRequired: booleanFromUnknown(row.backend_required),
    backend_required: booleanFromUnknown(row.backend_required),

    lastReportAt: firstText(row.last_report_at),
    lastSeenAt: firstText(row.last_report_at),
    last_report_at: firstText(row.last_report_at),
    reportCount,
    registerCount: reportCount,
    report_count: reportCount,

    source: firstText(row.source, "supabase"),
    createdAt: firstText(row.created_at),
    created_at: firstText(row.created_at),
    updatedAt: firstText(row.updated_at),
    updated_at: firstText(row.updated_at),
    notes: firstText(row.notes),

    metadata: {
      registryTable: DEFAULT_EXTERNAL_PROJECT_TABLE,
      versionRaw,
      features: {
        cssRuntime: booleanFromUnknown(row.features_css_runtime),
        header: booleanFromUnknown(row.features_header),
        footer: booleanFromUnknown(row.features_footer),
        runtimePanel: booleanFromUnknown(row.features_runtime_panel),
        backendClient: booleanFromUnknown(row.features_backend_client)
      },
      source: firstText(row.source, "supabase"),
      registry: {
        showInLauncher: row.show_in_launcher === null || row.show_in_launcher === undefined ? true : booleanFromUnknown(row.show_in_launcher),
        role: firstText(row.registry_role),
        reason: firstText(row.registry_reason),
        defaultPosition: normalizePlacement(row.default_position)
      }
    }
  };
}

async function deleteRegistryCache(env: Env, appEnv: AppEnvName): Promise<void> {
  /*
   * ExternalProject registry 不使用 KV / cache。
   * 保留此函式是為了讓 register/update 流程維持最小修改；這裡故意 no-op。
   */
  void env;
  void appEnv;
}

async function listExternalProjects(
  env: Env,
  appEnv: AppEnvName,
  options: { activeOnly?: boolean; bypassCache?: boolean } = {}
) {
  /*
   * 重要：ExternalProject registry 是管理資料，不使用 KV / cache。
   * 首頁與後台都必須讀 Supabase 當下最新資料；後台停用項目也不能被快取吃掉。
   */
  const activeOnly = options.activeOnly !== false;
  void options.bypassCache;

  const table = getExternalProjectTable(env);
  let path = `${encodeURIComponent(table)}?env=eq.${encodeURIComponent(appEnv)}&select=*&order=sort_order.asc.nullslast,title.asc`;

  if (activeOnly) {
    path += "&enabled=eq.true&display_position=neq.hidden";
  }

  const rows = await supabaseGet<ExternalProjectRegistryRow[]>(env, path);
  const items = rows.map(normalizeRegistryRow);

  return {
    ok: true,
    action: "listExternalProjects",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase ExternalProject / Cloudflare Worker",
    registryTable: table,
    env: appEnv,
    count: items.length,
    fetchedAt: new Date().toISOString(),
    items,
    apps: items,
    projects: items
  };
}

async function registerExternalApp(env: Env, body: any) {
  const payload = normalizeExternalAppRegisterPayload(normalizeRegistryPayload(body));
  const rootAppId = rootAppIdFromRegisterPayload(payload);
  const projectId = projectIdFromRegisterPayload(payload);
  const pageId = pageIdFromRegisterPayload(payload, projectId);
  const appEnv = normalizeEnv(payload.env);
  const registryKey = makeRegistryKey(projectId, appEnv);
  const table = getExternalProjectTable(env);

  if (!projectId) {
    return {
      ok: false,
      action: "registerExternalApp",
      source: "skhps-backend-supabase",
      error: "MISSING_PROJECT_ID",
      message: "缺少 project_id / appId"
    };
  }

  const href = firstText(
    pageId && pageId !== rootAppId ? payload.pageHref : "",
    payload.href
  );

  if (!href) {
    return {
      ok: false,
      action: "registerExternalApp",
      source: "skhps-backend-supabase",
      error: "MISSING_HREF",
      message: "缺少入口網址"
    };
  }

  const existingRows = await supabaseGet<ExternalProjectRegistryRow[]>(
    env,
    `${encodeURIComponent(table)}?registry_key=eq.${encodeURIComponent(registryKey)}&select=*`
  );

  const existing = existingRows[0] || null;
  const now = new Date().toISOString();
  const version = normalizeVersionValue(payload.version);
  const title = firstText(
    pageId && pageId !== rootAppId ? payload.pageTitle : "",
    payload.title,
    existing && existing.title,
    projectId
  );
  const showInLauncher = payload.showInLauncher;
  const defaultPosition = normalizePlacement(payload.defaultPosition);
  const initialDisplayPosition = showInLauncher
    ? (defaultPosition === "hidden" ? existing && existing.display_position ? normalizePlacement(existing.display_position) : "hidden" : defaultPosition)
    : "hidden";

  const record: Record<string, unknown> = {
    registry_key: registryKey,
    project_id: projectId,
    root_app_id: rootAppId || projectId,
    page_id: pageId || projectId,
    env: appEnv,
    title,
    description: firstText(payload.description, existing && existing.description),
    href,
    display_position: existing ? normalizePlacement(existing.display_position) : initialDisplayPosition,
    group_name: firstText(existing && existing.group_name, payload.group, "院內系統"),
    sort_order: existing ? numberFromUnknown(existing.sort_order, 9999) : 9999,
    enabled: existing ? booleanFromUnknown(existing.enabled) : false,
    show_on_home: existing ? booleanFromUnknown(existing.enabled) && normalizePlacement(existing.display_position) === "frontend" : false,
    show_on_backend: existing ? booleanFromUnknown(existing.enabled) && normalizePlacement(existing.display_position) === "backend" : false,
    show_in_launcher: showInLauncher,
    registry_role: payload.registryRole || existing && existing.registry_role || "",
    registry_reason: payload.registryReason || existing && existing.registry_reason || "",
    default_position: defaultPosition,
    version: version || existing && existing.version || "",
    version_raw: version ? "" : firstText(existing && existing.version_raw),
    manifest_url: firstText(existing && existing.manifest_url, inferManifestUrl(href)),
    register_external_app: true,
    backend_required: existing ? booleanFromUnknown(existing.backend_required) : false,
    features_css_runtime: existing ? booleanFromUnknown(existing.features_css_runtime) : true,
    features_header: existing ? booleanFromUnknown(existing.features_header) : true,
    features_footer: existing ? booleanFromUnknown(existing.features_footer) : true,
    features_runtime_panel: existing ? booleanFromUnknown(existing.features_runtime_panel) : true,
    features_backend_client: existing ? booleanFromUnknown(existing.features_backend_client) : false,
    last_report_at: now,
    report_count: existing ? numberFromUnknown(existing.report_count, 0) + 1 : 1,
    source: "registerExternalApp",
    created_at: existing && existing.created_at ? existing.created_at : now,
    updated_at: now,
    notes: existing && existing.notes ? existing.notes : ""
  };

  const updated = await supabaseUpsert<ExternalProjectRegistryRow[]>(
    env,
    table,
    record,
    "registry_key"
  );

  await deleteRegistryCache(env, appEnv);

  const normalized = normalizeRegistryRow((Array.isArray(updated) && updated[0] ? updated[0] : record) as ExternalProjectRegistryRow);

  return {
    ok: true,
    action: "registerExternalApp",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase ExternalProject / Cloudflare Worker",
    status: existing ? "updated" : "created",
    registryTable: table,
    registryKey,
    appId: projectId,
    projectId,
    rootAppId,
    pageId,
    env: appEnv,
    active: normalized.enabled,
    enabled: normalized.enabled,
    data: normalized,
    message: existing
      ? "外部專案已存在，已更新 Supabase 報到資訊，啟用狀態維持不變"
      : "外部專案第一次報到，已建立為未啟用"
  };
}

async function updateExternalProjectActivation(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const projectId = firstText(payload.projectId, payload.appId, payload.app_id, payload["專案ID"]);
  const appEnv = normalizeEnv(firstText(payload.env, payload["環境"]));
  const registryKey = firstText(payload.registryKey, payload.registry_key, makeRegistryKey(projectId, appEnv));
  const table = getExternalProjectTable(env);

  if (!projectId && !registryKey) {
    return {
      ok: false,
      action: "updateExternalProjectActivation",
      source: "skhps-backend-supabase",
      error: "MISSING_PROJECT_ID",
      message: "缺少 projectId / registryKey"
    };
  }

  const existing = await supabaseGet<ExternalProjectRegistryRow[]>(
    env,
    `${encodeURIComponent(table)}?registry_key=eq.${encodeURIComponent(registryKey)}&select=*`
  );

  if (!existing.length) {
    return {
      ok: false,
      action: "updateExternalProjectActivation",
      source: "skhps-backend-supabase",
      error: "PROJECT_NOT_FOUND",
      message: `找不到外部專案：${projectId || registryKey} / ${appEnv}`,
      projectId,
      registryKey,
      env: appEnv
    };
  }

  const row = existing[0];
  const patch: Record<string, unknown> = {};
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, "enabled") ||
    Object.prototype.hasOwnProperty.call(payload, "active") ||
    Object.prototype.hasOwnProperty.call(payload, "啟用");
  const hasDisplayPosition = Object.prototype.hasOwnProperty.call(payload, "displayPosition") ||
    Object.prototype.hasOwnProperty.call(payload, "position") ||
    Object.prototype.hasOwnProperty.call(payload, "placement") ||
    Object.prototype.hasOwnProperty.call(payload, "display_position") ||
    Object.prototype.hasOwnProperty.call(payload, "顯示位置");
  const hasSort = Object.prototype.hasOwnProperty.call(payload, "sort") ||
    Object.prototype.hasOwnProperty.call(payload, "order") ||
    Object.prototype.hasOwnProperty.call(payload, "sortOrder") ||
    Object.prototype.hasOwnProperty.call(payload, "sort_order") ||
    Object.prototype.hasOwnProperty.call(payload, "排序");

  if (hasEnabled) {
    patch.enabled = booleanFromUnknown(
      Object.prototype.hasOwnProperty.call(payload, "enabled") ? payload.enabled :
        Object.prototype.hasOwnProperty.call(payload, "active") ? payload.active :
          payload["啟用"]
    );
  }

  if (hasDisplayPosition) {
    const requestedPosition = firstText(
      payload.displayPosition,
      payload.position,
      payload.placement,
      payload.display_position,
      payload["顯示位置"]
    );

    /*
     * 停用不是刪除。
     * 停用時如果沒有顯示位置，就保留 Supabase 既有 display_position，避免變 hidden 後像被丟進垃圾桶。
     */
    if (requestedPosition) {
      patch.display_position = normalizePlacement(requestedPosition);
    } else if (!(hasEnabled && patch.enabled === false)) {
      patch.display_position = "hidden";
    }
  }

  if (hasSort) {
    patch.sort_order = numberFromUnknown(payload.sort || payload.order || payload.sortOrder || payload.sort_order || payload["排序"], row.sort_order || 9999);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "group") || Object.prototype.hasOwnProperty.call(payload, "groupName") || Object.prototype.hasOwnProperty.call(payload, "group_name")) {
    patch.group_name = firstText(payload.group, payload.groupName, payload.group_name, row.group_name);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    patch.title = firstText(payload.title, row.title);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "href")) {
    patch.href = firstText(payload.href, row.href);
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, "showInLauncher") ||
    Object.prototype.hasOwnProperty.call(payload, "show_in_launcher") ||
    Object.prototype.hasOwnProperty.call(payload, "顯示於啟動器")
  ) {
    patch.show_in_launcher = booleanFromUnknown(
      Object.prototype.hasOwnProperty.call(payload, "showInLauncher") ? payload.showInLauncher :
        Object.prototype.hasOwnProperty.call(payload, "show_in_launcher") ? payload.show_in_launcher :
          payload["顯示於啟動器"]
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, "registryRole") ||
    Object.prototype.hasOwnProperty.call(payload, "registry_role") ||
    Object.prototype.hasOwnProperty.call(payload, "role") ||
    Object.prototype.hasOwnProperty.call(payload, "Registry角色")
  ) {
    patch.registry_role = firstText(payload.registryRole, payload.registry_role, payload.role, payload["Registry角色"]);
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, "registryReason") ||
    Object.prototype.hasOwnProperty.call(payload, "registry_reason") ||
    Object.prototype.hasOwnProperty.call(payload, "reason") ||
    Object.prototype.hasOwnProperty.call(payload, "隱藏原因")
  ) {
    patch.registry_reason = firstText(payload.registryReason, payload.registry_reason, payload.reason, payload["隱藏原因"]);
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, "defaultPosition") ||
    Object.prototype.hasOwnProperty.call(payload, "default_position") ||
    Object.prototype.hasOwnProperty.call(payload, "預設位置") ||
    Object.prototype.hasOwnProperty.call(payload, "預設顯示位置")
  ) {
    patch.default_position = normalizePlacement(firstText(payload.defaultPosition, payload.default_position, payload["預設位置"], payload["預設顯示位置"]));
  }

  if (!Object.keys(patch).length) {
    return {
      ok: false,
      action: "updateExternalProjectActivation",
      source: "skhps-backend-supabase",
      error: "NO_UPDATABLE_FIELDS",
      message: "沒有可更新的欄位"
    };
  }

  const nextEnabled = Object.prototype.hasOwnProperty.call(patch, "enabled") ? booleanFromUnknown(patch.enabled) : booleanFromUnknown(row.enabled);
  const nextPosition = Object.prototype.hasOwnProperty.call(patch, "display_position") ? normalizePlacement(patch.display_position) : normalizePlacement(row.display_position);

  const nextShowInLauncher = Object.prototype.hasOwnProperty.call(patch, "show_in_launcher") ? booleanFromUnknown(patch.show_in_launcher) :
    row.show_in_launcher === null || row.show_in_launcher === undefined ? true : booleanFromUnknown(row.show_in_launcher);

  patch.show_on_home = nextShowInLauncher && nextEnabled && nextPosition === "frontend";
  patch.show_on_backend = nextShowInLauncher && nextEnabled && nextPosition === "backend";
  patch.updated_at = new Date().toISOString();
  patch.source = "backend-project-launcher";

  const updated = await supabasePatch<ExternalProjectRegistryRow[]>(
    env,
    table,
    `registry_key=eq.${encodeURIComponent(registryKey)}`,
    patch
  );

  await deleteRegistryCache(env, appEnv);

  const next = updated[0] || {
    ...row,
    ...patch
  } as ExternalProjectRegistryRow;
  const normalized = normalizeRegistryRow(next);

  return {
    ok: true,
    action: "updateExternalProjectActivation",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase ExternalProject / Cloudflare Worker",
    registryTable: table,
    registryKey,
    appId: normalized.appId,
    projectId: normalized.projectId,
    rootAppId: normalized.rootAppId,
    pageId: normalized.pageId,
    env: appEnv,
    active: normalized.enabled,
    enabled: normalized.enabled,
    displayPosition: normalized.displayPosition,
    order: normalized.sortOrder,
    sort: normalized.sortOrder,
    data: {
      ...normalized,
      updatedFields: Object.keys(patch)
    },
    message: "已更新 Supabase ExternalProject 設定"
  };
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

async function getQuickLoginStaff(env: Env, appEnv: AppEnvName) {
  const tableName = getStaffTable(env);
  /* StaffMaster 也不從 KV 回傳；保留 appEnv 只作診斷。 */
  void appEnv;

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

    return json({
      ok: true,
      action: "ping",
      source: "skhps-backend",
      env: body.env || null,
      hasSupabaseUrl: !!env.SUPABASE_URL,
      hasSupabaseServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY
    });
  }

  if (action === "listExternalProjects" || action === "listExternalApps" || action === "listExternalProjectsForLauncher") {
    try {
      const payload = normalizeRegistryPayload(body);
      const appEnv = normalizeEnv(body.env || payload.env);
      const isLauncherAction = action === "listExternalProjectsForLauncher";
      const includeDisabled =
        isLauncherAction ||
        booleanFromUnknown(payload.includeDisabled) ||
        booleanFromUnknown(payload.includeInactive) ||
        booleanFromUnknown(payload.launcherMode) ||
        String(payload.activeOnly || "").trim().toLowerCase() === "false";
      const result = await listExternalProjects(env, appEnv, {
        activeOnly: includeDisabled ? false : true,
        bypassCache: isLauncherAction || booleanFromUnknown(payload.forceFresh)
      });
      return json({
        ...result,
        action
      });
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "registerExternalApp") {
    try {
      const result = await registerExternalApp(env, body);
      return json(result.ok === false ? result : {
        ...result,
        action
      }, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (
    action === "updateExternalProjectActivation" ||
    action === "updateExternalAppSettings" ||
    action === "setExternalAppActive"
  ) {
    try {
      const result = await updateExternalProjectActivation(env, body);
      return json(result.ok === false ? {
        ...result,
        action
      } : {
        ...result,
        action
      }, result.ok === false ? 400 : 200);
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