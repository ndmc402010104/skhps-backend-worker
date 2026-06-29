/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-06-29 23:19 UTC+8
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
 *   - recordQuickLoginNewStaff（記錄萬用登入未出現在 StaffMaster 的測試帳密）
 *   - listStaffMaster / upsertStaffMaster / updateStaffMasterStatus / reorderStaffMaster（StaffMaster 管理）
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

  QR_SIGNIN_MEETING_TABLE?: string;
  QR_SIGNIN_RECORD_TABLE?: string;
  QR_SIGNIN_AUDIT_TABLE?: string;
  QR_SIGNIN_MEETING_SUMMARY_VIEW?: string;
  QR_SIGNIN_CALENDAR_ID?: string;
  QR_SIGNIN_CALENDAR_ICS_URL?: string;
  QR_SIGNIN_APPS_SCRIPT_URL?: string;
  QR_SIGNIN_CALENDAR_LOOKBACK_DAYS?: string;
  QR_SIGNIN_CALENDAR_LOOKAHEAD_DAYS?: string;
  QR_SIGNIN_RUNNING_BEFORE_MIN?: string;
  QR_SIGNIN_RUNNING_AFTER_MIN?: string;
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
const DEFAULT_QUICK_LOGIN_NEW_STAFF_TABLE = "NewStaff";
const DEFAULT_EXTERNAL_PROJECT_TABLE = "ExternalProject";
const DEFAULT_QR_SIGNIN_MEETING_TABLE = "QrSigninMeeting";
const DEFAULT_QR_SIGNIN_RECORD_TABLE = "QrSigninRecord";
const DEFAULT_QR_SIGNIN_AUDIT_TABLE = "QrSigninRecordAudit";
const DEFAULT_QR_SIGNIN_MEETING_SUMMARY_VIEW = "QrSigninMeetingSummary";
const DEFAULT_QR_SIGNIN_CALENDAR_ID = "c25b1d017823114707a1edf8d8491894b063fe07b48e1d9fdc627c6b03b8a76b@group.calendar.google.com";
const DEFAULT_QR_SIGNIN_RUNNING_BEFORE_MIN = 30;
const DEFAULT_QR_SIGNIN_RUNNING_AFTER_MIN = 10;
const DEFAULT_QR_SIGNIN_LOOKBACK_DAYS = 45;
const DEFAULT_QR_SIGNIN_LOOKAHEAD_DAYS = 45;
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
  const password = stringValue(row, ["密碼", "password", "Password", "PassWord"], "");
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
    password,
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

function getQuickLoginNewStaffTable(): string {
  return DEFAULT_QUICK_LOGIN_NEW_STAFF_TABLE;
}

async function getLatestNewStaffPasswordByEmp(env: Env): Promise<Record<string, string>> {
  const tableName = getQuickLoginNewStaffTable();
  const rows = await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?select=${encodeURIComponent("員工編號,密碼,新增時間")}&order=${encodeURIComponent("新增時間")}.desc.nullslast`
  );
  const latestByEmp: Record<string, string> = {};

  for (const row of rows) {
    const emp = stringValue(row, ["員工編號", "emp", "employee_id"], "");
    const password = stringValue(row, ["密碼", "password", "Password", "PassWord"], "");
    if (emp && password && !latestByEmp[emp]) {
      latestByEmp[emp] = password;
    }
  }

  return latestByEmp;
}

async function getQuickLoginStaff(env: Env, appEnv: AppEnvName) {
  const tableName = getStaffTable(env);
  const newStaffTableName = getQuickLoginNewStaffTable();
  /* StaffMaster 也不從 KV 回傳；保留 appEnv 只作診斷。 */
  void appEnv;

  const rows = await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?select=*`
  );
  let passwordFallbackByEmp: Record<string, string> = {};
  let passwordFallbackError = "";

  try {
    passwordFallbackByEmp = await getLatestNewStaffPasswordByEmp(env);
  } catch (error) {
    passwordFallbackError = error instanceof Error ? error.message : String(error);
  }

  const staffList = rows
    .map((row) => toQuickLoginPerson(row, tableName))
    .map((person) => {
      if (person.password || !person.emp) return person;

      const fallbackPassword = passwordFallbackByEmp[String(person.emp)] || "";
      if (!fallbackPassword) return person;

      return {
        ...person,
        password: fallbackPassword,
        metadata: {
          ...(person.metadata || {}),
          passwordSource: "NewStaff",
          passwordSourceTable: newStaffTableName
        }
      };
    })
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
    passwordFallbackTable: newStaffTableName,
    passwordFallbackCount: Object.keys(passwordFallbackByEmp).length,
    passwordFallbackError,
    count: staffList.length,
    cachedAt: new Date().toISOString(),
    staffList,
    extraList: []
  };


  return payload;
}

async function findQuickLoginNewStaffRowsByEmpAndPassword(env: Env, emp: string, password: string): Promise<StaffMasterRow[]> {
  const tableName = getQuickLoginNewStaffTable();
  const empColumn = encodeURIComponent("員工編號");
  const passwordColumn = encodeURIComponent("密碼");

  return await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?${empColumn}=eq.${encodeURIComponent(emp)}&${passwordColumn}=eq.${encodeURIComponent(password)}&select=*`
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTaipeiTimestampKey(date = new Date(), offsetSeconds = 0): string {
  const taipei = new Date(date.getTime() + (8 * 60 * 60 + offsetSeconds) * 1000);
  return [
    taipei.getUTCFullYear(),
    pad2(taipei.getUTCMonth() + 1),
    pad2(taipei.getUTCDate()),
    pad2(taipei.getUTCHours()),
    pad2(taipei.getUTCMinutes()),
    pad2(taipei.getUTCSeconds())
  ].join("");
}

function buildQuickLoginNewStaffRecord(emp: string, password: string, offsetSeconds = 0): Record<string, unknown> {
  return {
    "新增時間": formatTaipeiTimestampKey(new Date(), offsetSeconds),
    "員工編號": emp,
    "密碼": password
  };
}

async function recordQuickLoginNewStaff(env: Env, body: any) {
  const payload = isPlainObject(body.payload) ? body.payload : body;
  const tableName = getQuickLoginNewStaffTable();
  const emp = firstText(payload.emp, payload.account, payload.employeeId, payload.employee_id, payload["員工編號"]);
  const password = firstText(payload.password, payload.PassWord, payload["密碼"]);

  if (!emp) {
    return {
      ok: false,
      action: "recordQuickLoginNewStaff",
      source: "skhps-backend-supabase",
      error: "MISSING_EMP",
      message: "員工編號必填"
    };
  }

  const existingRows = await findQuickLoginNewStaffRowsByEmpAndPassword(env, emp, password);

  if (existingRows.length) {
    return {
      ok: true,
      action: "recordQuickLoginNewStaff",
      source: "skhps-backend-supabase",
      sourceLabel: "Supabase / NewStaff",
      table: tableName,
      emp,
      mode: "skipped-existing",
      count: 0
    };
  }

  let inserted: StaffMasterRow[] = [];
  let insertedAt = "";

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const record = buildQuickLoginNewStaffRecord(emp, password, attempt);
    insertedAt = String(record["新增時間"] || "");

    try {
      inserted = await supabasePost<StaffMasterRow[]>(
        env,
        tableName,
        record
      );
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 5 && message.indexOf("NewStaff_pkey") >= 0) {
        continue;
      }
      throw error;
    }
  }

  return {
    ok: true,
    action: "recordQuickLoginNewStaff",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase / NewStaff",
    table: tableName,
    emp,
    insertedAt,
    mode: "inserted",
    count: Array.isArray(inserted) ? inserted.length : 0
  };
}

function staffMasterPayload(body: any): Record<string, unknown> {
  const payload = body && body.payload && typeof body.payload === "object" ? body.payload : body || {};
  return payload as Record<string, unknown>;
}

function normalizeStaffGroup(input: unknown): string {
  const value = String(input || "").trim();

  if (!value) return "";
  if (value === "VS/F" || value.toLowerCase() === "vs/f" || value.toLowerCase() === "vs-f") return "VS/F";
  if (value === "R/NP" || value.toLowerCase() === "r/np" || value.toLowerCase() === "r-np") return "R/NP";
  if (value === "行政人員" || value.indexOf("行政") >= 0) return "行政人員";

  return value;
}

function normalizeStaffRole(input: unknown): string {
  const value = String(input || "").trim();
  const upper = value.toUpperCase();

  if (value === "F" || upper === "FELLOW") return "Fellow";
  if (upper === "VS") return "VS";
  if (upper === "NP") return "NP";
  if (/^R[1-6]$/.test(upper)) return upper;
  if (/^PGY[12]$/.test(upper)) return upper;

  return value;
}

function staffPatchFromPayload(payload: Record<string, unknown>, options: { partial?: boolean } = {}): Record<string, unknown> {
  const partial = Boolean(options.partial);
  const patch: Record<string, unknown> = {};
  const now = new Date().toISOString();

  const hasName = Object.prototype.hasOwnProperty.call(payload, "name") || Object.prototype.hasOwnProperty.call(payload, "姓名");
  const hasEmp = Object.prototype.hasOwnProperty.call(payload, "emp") || Object.prototype.hasOwnProperty.call(payload, "employeeId") || Object.prototype.hasOwnProperty.call(payload, "employee_id") || Object.prototype.hasOwnProperty.call(payload, "員工編號");
  const hasRole = Object.prototype.hasOwnProperty.call(payload, "role") || Object.prototype.hasOwnProperty.call(payload, "title") || Object.prototype.hasOwnProperty.call(payload, "職級");
  const hasGroup = Object.prototype.hasOwnProperty.call(payload, "group") || Object.prototype.hasOwnProperty.call(payload, "groupKey") || Object.prototype.hasOwnProperty.call(payload, "group_key") || Object.prototype.hasOwnProperty.call(payload, "分組");
  const hasSort = Object.prototype.hasOwnProperty.call(payload, "sortOrder") || Object.prototype.hasOwnProperty.call(payload, "sort_order") || Object.prototype.hasOwnProperty.call(payload, "排序");
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, "enabled") || Object.prototype.hasOwnProperty.call(payload, "active") || Object.prototype.hasOwnProperty.call(payload, "啟用");
  const hasAllowQuickLogin = Object.prototype.hasOwnProperty.call(payload, "allowQuickLogin") || Object.prototype.hasOwnProperty.call(payload, "allow_quick_login") || Object.prototype.hasOwnProperty.call(payload, "允許快速登入");
  const hasNote = Object.prototype.hasOwnProperty.call(payload, "note") || Object.prototype.hasOwnProperty.call(payload, "備註");

  if (!partial || hasEnabled) {
    patch["啟用"] = hasEnabled
      ? booleanFromUnknown(Object.prototype.hasOwnProperty.call(payload, "enabled") ? payload.enabled : Object.prototype.hasOwnProperty.call(payload, "active") ? payload.active : payload["啟用"])
      : true;
  }

  if (!partial || hasName) {
    patch["姓名"] = firstText(payload.name, payload["姓名"]);
  }

  if (!partial || hasEmp) {
    patch["員工編號"] = firstText(payload.emp, payload.employeeId, payload.employee_id, payload["員工編號"]);
  }

  if (!partial || hasRole) {
    patch["職級"] = normalizeStaffRole(firstText(payload.role, payload.title, payload["職級"]));
  }

  if (!partial || hasGroup) {
    patch["分組"] = normalizeStaffGroup(firstText(payload.group, payload.groupKey, payload.group_key, payload["分組"]));
  }

  if (!partial || hasSort) {
    patch["排序"] = numberFromUnknown(
      Object.prototype.hasOwnProperty.call(payload, "sortOrder") ? payload.sortOrder :
        Object.prototype.hasOwnProperty.call(payload, "sort_order") ? payload.sort_order :
          payload["排序"],
      999
    );
  }

  if (!partial || hasAllowQuickLogin) {
    patch["允許快速登入"] = hasAllowQuickLogin
      ? booleanFromUnknown(Object.prototype.hasOwnProperty.call(payload, "allowQuickLogin") ? payload.allowQuickLogin : Object.prototype.hasOwnProperty.call(payload, "allow_quick_login") ? payload.allow_quick_login : payload["允許快速登入"])
      : true;
  }

  if (!partial || hasNote) {
    patch["備註"] = firstText(payload.note, payload["備註"]);
  }

  patch["更新時間"] = now;

  Object.keys(patch).forEach((key) => {
    if (patch[key] === undefined || patch[key] === null) {
      delete patch[key];
    }
  });

  return patch;
}

function normalizeStaffMasterAdminRow(row: StaffMasterRow, tableName: string): Record<string, unknown> {
  const person = toQuickLoginPerson(row, tableName);
  return {
    ...person,
    raw: row,
    source: "supabase",
    sourceLabel: "Supabase / StaffMaster"
  };
}

function staffEmpFromPayload(payload: Record<string, unknown>): string {
  return firstText(payload.emp, payload.employeeId, payload.employee_id, payload.staffId, payload.staff_id, payload["員工編號"]);
}

async function findStaffMasterRowsByEmp(env: Env, emp: string): Promise<StaffMasterRow[]> {
  const tableName = getStaffTable(env);
  const empColumn = encodeURIComponent("員工編號");

  return await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?${empColumn}=eq.${encodeURIComponent(emp)}&select=*`
  );
}

async function listStaffMaster(env: Env, body: any) {
  const payload = staffMasterPayload(body);
  const appEnv = normalizeEnv(body.env || payload.env);
  const tableName = getStaffTable(env);

  const rows = await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?select=*`
  );

  const items = rows
    .map((row) => normalizeStaffMasterAdminRow(row, tableName))
    .sort((a, b) => {
      const orderDiff = numberFromUnknown(a.sortOrder, 9999) - numberFromUnknown(b.sortOrder, 9999);
      if (orderDiff !== 0) return orderDiff;
      return String(a.emp || "").localeCompare(String(b.emp || ""));
    });

  return {
    ok: true,
    action: "listStaffMaster",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase / StaffMaster",
    env: appEnv,
    staffTable: tableName,
    count: items.length,
    fetchedAt: new Date().toISOString(),
    items,
    staffList: items,
    rows: items
  };
}

async function upsertStaffMaster(env: Env, body: any) {
  const payload = staffMasterPayload(body);
  const appEnv = normalizeEnv(body.env || payload.env);
  const tableName = getStaffTable(env);
  const record = staffPatchFromPayload(payload);
  const emp = staffEmpFromPayload(record);

  if (!firstText(record["姓名"])) {
    return {
      ok: false,
      action: "upsertStaffMaster",
      source: "skhps-backend-supabase",
      error: "MISSING_NAME",
      message: "姓名必填"
    };
  }

  if (!emp) {
    return {
      ok: false,
      action: "upsertStaffMaster",
      source: "skhps-backend-supabase",
      error: "MISSING_EMP",
      message: "員工編號必填"
    };
  }

  const existingRows = await findStaffMasterRowsByEmp(env, emp);
  const empColumn = encodeURIComponent("員工編號");
  let updated: StaffMasterRow[];

  if (existingRows.length) {
    updated = await supabasePatch<StaffMasterRow[]>(
      env,
      tableName,
      `${empColumn}=eq.${encodeURIComponent(emp)}`,
      record
    );
  } else {
    updated = await supabasePost<StaffMasterRow[]>(
      env,
      tableName,
      record
    );
  }

  const row = Array.isArray(updated) && updated[0] ? updated[0] : record;

  return {
    ok: true,
    action: "upsertStaffMaster",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase / StaffMaster",
    env: appEnv,
    staffTable: tableName,
    status: existingRows.length ? "updated" : "created",
    emp,
    data: normalizeStaffMasterAdminRow(row, tableName)
  };
}

async function updateStaffMasterStatus(env: Env, body: any) {
  const payload = staffMasterPayload(body);
  const appEnv = normalizeEnv(body.env || payload.env);
  const tableName = getStaffTable(env);
  const emp = staffEmpFromPayload(payload);

  if (!emp) {
    return {
      ok: false,
      action: "updateStaffMasterStatus",
      source: "skhps-backend-supabase",
      error: "MISSING_EMP",
      message: "員工編號必填"
    };
  }

  const patch = staffPatchFromPayload(payload, { partial: true });
  delete patch["姓名"];
  delete patch["員工編號"];
  delete patch["職級"];
  delete patch["分組"];
  delete patch["排序"];
  delete patch["備註"];

  if (!Object.prototype.hasOwnProperty.call(patch, "啟用") && !Object.prototype.hasOwnProperty.call(patch, "允許快速登入")) {
    return {
      ok: false,
      action: "updateStaffMasterStatus",
      source: "skhps-backend-supabase",
      error: "NO_STATUS_FIELD",
      message: "沒有可更新的狀態欄位"
    };
  }

  const empColumn = encodeURIComponent("員工編號");
  const updated = await supabasePatch<StaffMasterRow[]>(
    env,
    tableName,
    `${empColumn}=eq.${encodeURIComponent(emp)}`,
    patch
  );

  if (!updated.length) {
    return {
      ok: false,
      action: "updateStaffMasterStatus",
      source: "skhps-backend-supabase",
      error: "STAFF_NOT_FOUND",
      message: `找不到人員：${emp}`
    };
  }

  return {
    ok: true,
    action: "updateStaffMasterStatus",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase / StaffMaster",
    env: appEnv,
    staffTable: tableName,
    emp,
    data: normalizeStaffMasterAdminRow(updated[0], tableName)
  };
}

async function reorderStaffMaster(env: Env, body: any) {
  const payload = staffMasterPayload(body);
  const appEnv = normalizeEnv(body.env || payload.env);
  const tableName = getStaffTable(env);
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : [];

  if (!items.length) {
    return {
      ok: false,
      action: "reorderStaffMaster",
      source: "skhps-backend-supabase",
      error: "EMPTY_ITEMS",
      message: "沒有排序資料"
    };
  }

  const empColumn = encodeURIComponent("員工編號");
  const updated: Record<string, unknown>[] = [];

  for (const item of items) {
    const emp = staffEmpFromPayload(item);
    const sortOrder = numberFromUnknown(item.sortOrder || item.sort_order || item["排序"], 999);
    if (!emp) continue;

    const result = await supabasePatch<StaffMasterRow[]>(
      env,
      tableName,
      `${empColumn}=eq.${encodeURIComponent(emp)}`,
      {
        "排序": sortOrder,
        "更新時間": new Date().toISOString()
      }
    );

    if (result[0]) {
      updated.push(normalizeStaffMasterAdminRow(result[0], tableName));
    }
  }

  return {
    ok: true,
    action: "reorderStaffMaster",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase / StaffMaster",
    env: appEnv,
    staffTable: tableName,
    count: updated.length,
    items: updated
  };
}




type QrSigninMeetingRow = {
  id: string;
  app_id: string;
  env: string;
  source: string;
  source_id: string | null;
  calendar_id: string | null;
  title: string;
  meeting_date: string | null;
  time_label: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  open_before_minutes: number;
  close_after_minutes: number;
  enabled: boolean;
  status: string;
  created_by: string | null;
  updated_by: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type QrSigninRecordRow = {
  id: string;
  meeting_id: string;
  app_id: string;
  env: string;
  name: string;
  employee_id: string | null;
  role: string | null;
  staff_source: string;
  signed_at: string | null;
  submitted_at: string;
  status: string;
  reason: string | null;
  source: string;
  duplicate_of: string | null;
  client_request_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type QrSigninSummaryRow = {
  id: string;
  app_id: string;
  env: string;
  title: string;
  meeting_date: string | null;
  time_label: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  enabled: boolean;
  status: string;
  source: string;
  source_id: string | null;
  total_records: number;
  signed_count: number;
  late_count: number;
  outside_window_count: number;
  leave_count: number;
  absent_count: number;
  void_count: number;
  created_at: string;
  updated_at: string;
};

function getQrSigninMeetingTable(env: Env): string {
  return String(env.QR_SIGNIN_MEETING_TABLE || DEFAULT_QR_SIGNIN_MEETING_TABLE).trim() || DEFAULT_QR_SIGNIN_MEETING_TABLE;
}

function getQrSigninRecordTable(env: Env): string {
  return String(env.QR_SIGNIN_RECORD_TABLE || DEFAULT_QR_SIGNIN_RECORD_TABLE).trim() || DEFAULT_QR_SIGNIN_RECORD_TABLE;
}

function getQrSigninAuditTable(env: Env): string {
  return String(env.QR_SIGNIN_AUDIT_TABLE || DEFAULT_QR_SIGNIN_AUDIT_TABLE).trim() || DEFAULT_QR_SIGNIN_AUDIT_TABLE;
}

function getQrSigninSummaryView(env: Env): string {
  return String(env.QR_SIGNIN_MEETING_SUMMARY_VIEW || DEFAULT_QR_SIGNIN_MEETING_SUMMARY_VIEW).trim() || DEFAULT_QR_SIGNIN_MEETING_SUMMARY_VIEW;
}

function qrNumberFromEnv(input: unknown, fallback: number): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function getQrSigninCalendarId(env: Env): string {
  return String(env.QR_SIGNIN_CALENDAR_ID || DEFAULT_QR_SIGNIN_CALENDAR_ID).trim();
}

function getQrSigninCalendarIcsUrl(env: Env): string {
  const configured = String(env.QR_SIGNIN_CALENDAR_ICS_URL || "").trim();
  if (configured) return configured;

  const calendarId = getQrSigninCalendarId(env);
  if (!calendarId) return "";

  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
}

function getQrSigninWindowConfig(env: Env): { beforeMinutes: number; afterMinutes: number } {
  return {
    beforeMinutes: qrNumberFromEnv(env.QR_SIGNIN_RUNNING_BEFORE_MIN, DEFAULT_QR_SIGNIN_RUNNING_BEFORE_MIN),
    afterMinutes: qrNumberFromEnv(env.QR_SIGNIN_RUNNING_AFTER_MIN, DEFAULT_QR_SIGNIN_RUNNING_AFTER_MIN)
  };
}

function formatTaipeiDate(value: Date, pattern: "Y-M-D" | "M/d" | "H:mm"): string {
  if (pattern === "Y-M-D") {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(value);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: pattern === "M/d" ? "numeric" : undefined,
    day: pattern === "M/d" ? "numeric" : undefined,
    hour: pattern === "H:mm" ? "2-digit" : undefined,
    minute: pattern === "H:mm" ? "2-digit" : undefined,
    hour12: false
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";

  if (pattern === "M/d") return `${get("month")}/${get("day")}`;
  return `${get("hour")}:${get("minute")}`;
}

function unfoldIcs(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "").replace(/\r\n/g, "\n");
}

function readIcsProperty(block: string, name: string): string {
  const lines = block.split("\n");
  const upperName = name.toUpperCase();

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon).toUpperCase();
    if (left === upperName || left.startsWith(upperName + ";")) return line.slice(colon + 1).trim();
  }

  return "";
}

function decodeIcsText(value: string): string {
  return String(value || "")
    .replace(/\\n/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsDate(value: string): Date | null {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return null;

  const yyyy = match[1];
  const mm = match[2];
  const dd = match[3];
  const hh = match[4] || "00";
  const mi = match[5] || "00";
  const ss = match[6] || "00";
  const suffix = match[7] ? "Z" : "+08:00";
  const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${suffix}`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function makeQrSigninSourceId(source: string, title: string, startsAt: string, endsAt: string): string {
  return [source, title, startsAt, endsAt].map((part) => String(part || "").trim()).join("::");
}

function toQrSigninMeetingRowFromDates(input: {
  envName: AppEnvName;
  title: string;
  start: Date;
  end: Date;
  source: string;
  sourceId?: string;
  calendarId?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const windowConfig = getQrSigninWindowConfig({} as Env);
  const startsAt = input.start.toISOString();
  const endsAt = input.end.toISOString();
  const sourceId = input.sourceId || makeQrSigninSourceId(input.source, input.title, startsAt, endsAt);

  return {
    app_id: "qr-signin",
    env: input.envName,
    source: input.source,
    source_id: sourceId,
    calendar_id: input.calendarId || null,
    title: input.title,
    meeting_date: formatTaipeiDate(input.start, "Y-M-D"),
    time_label: `${formatTaipeiDate(input.start, "H:mm")}-${formatTaipeiDate(input.end, "H:mm")}`,
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: "Asia/Taipei",
    open_before_minutes: windowConfig.beforeMinutes,
    close_after_minutes: windowConfig.afterMinutes,
    enabled: true,
    status: "active",
    metadata: input.metadata || {}
  };
}

function parseQrSigninIcsRows(text: string, env: Env, payload: Record<string, unknown>): Record<string, unknown>[] {
  const now = new Date();
  const lookbackDays = qrNumberFromEnv(payload.lookbackDays, qrNumberFromEnv(env.QR_SIGNIN_CALENDAR_LOOKBACK_DAYS, DEFAULT_QR_SIGNIN_LOOKBACK_DAYS));
  const lookaheadDays = qrNumberFromEnv(payload.lookaheadDays, qrNumberFromEnv(env.QR_SIGNIN_CALENDAR_LOOKAHEAD_DAYS, DEFAULT_QR_SIGNIN_LOOKAHEAD_DAYS));
  const first = new Date(now.getTime() - lookbackDays * 86400000);
  const last = new Date(now.getTime() + lookaheadDays * 86400000);
  const envName = normalizeEnv(firstText(payload.env, payload.runtime));
  const calendarId = getQrSigninCalendarId(env);
  const blocks = unfoldIcs(text).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

  return blocks
    .map((block) => {
      const title = decodeIcsText(readIcsProperty(block, "SUMMARY"));
      const uid = decodeIcsText(readIcsProperty(block, "UID"));
      const start = parseIcsDate(readIcsProperty(block, "DTSTART"));
      const end = parseIcsDate(readIcsProperty(block, "DTEND"));
      if (!title || !start || !end) return null;
      if (start.getTime() < first.getTime() || start.getTime() > last.getTime()) return null;
      return toQrSigninMeetingRowFromDates({
        envName,
        title,
        start,
        end,
        source: "google-calendar-ics",
        sourceId: uid || undefined,
        calendarId,
        metadata: { rawSource: "ics" }
      });
    })
    .filter((item): item is Record<string, unknown> => !!item);
}

function splitQrSigninCourseInfo(rawCourse: unknown, rawDate: unknown): { meeting: string; date: string; time: string } {
  const courseText = String(rawCourse || "").trim();
  const dateText = String(rawDate || "").trim();
  let meeting = courseText;
  let meetingDate = "";
  let meetingTime = dateText;
  const courseMatch = courseText.match(/^(\d{1,2}\/\d{1,2})\s+(.+)$/);
  const dateMatch = dateText.match(/^(\d{1,2}\/\d{1,2})\s*(?:[|｜]\s*)?(.+)$/);

  if (courseMatch) {
    meetingDate = courseMatch[1];
    meeting = courseMatch[2].trim();
  }

  if (dateMatch) {
    meetingDate = dateMatch[1];
    meetingTime = dateMatch[2].trim();
  }

  return { meeting, date: meetingDate, time: meetingTime };
}

function parseLegacyMeetingDate(raw: unknown): { meetingDate: string | null; timeLabel: string; startsAt: string | null; endsAt: string | null } {
  const text = String(raw || "").trim();
  const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\s*(?:[|｜]\s*)?(.*)$/);
  const timeMatch = text.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  const now = new Date();
  const year = now.getFullYear();

  if (!dateMatch || !timeMatch) {
    return { meetingDate: null, timeLabel: text, startsAt: null, endsAt: null };
  }

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const parseTime = (value: string) => {
    const m = value.match(/^(\d{1,2}):(\d{2})$/);
    return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
  };
  const startPart = parseTime(timeMatch[1]);
  const endPart = parseTime(timeMatch[2]);
  if (!startPart || !endPart) return { meetingDate: null, timeLabel: text, startsAt: null, endsAt: null };

  const start = new Date(Date.UTC(year, month - 1, day, startPart.hour - 8, startPart.minute, 0));
  const end = new Date(Date.UTC(year, month - 1, day, endPart.hour - 8, endPart.minute, 0));
  if (end.getTime() < start.getTime()) end.setUTCDate(end.getUTCDate() + 1);

  return {
    meetingDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeLabel: `${timeMatch[1]}-${timeMatch[2]}`,
    startsAt: start.toISOString(),
    endsAt: end.toISOString()
  };
}

function toQrSigninMeetingRowFromLegacy(input: {
  envName: AppEnvName;
  course: unknown;
  date: unknown;
  source: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const info = splitQrSigninCourseInfo(input.course, input.date);
  const parsed = parseLegacyMeetingDate(info.date ? `${info.date} ${info.time}` : input.date);
  const sourceId = input.sourceId || makeQrSigninSourceId(input.source, info.meeting, parsed.startsAt || String(input.date || ""), parsed.endsAt || "");
  const windowConfig = getQrSigninWindowConfig({} as Env);

  return {
    app_id: "qr-signin",
    env: input.envName,
    source: input.source,
    source_id: sourceId,
    calendar_id: null,
    title: info.meeting || String(input.course || "").trim(),
    meeting_date: parsed.meetingDate,
    time_label: parsed.timeLabel || info.time || String(input.date || "").trim(),
    starts_at: parsed.startsAt,
    ends_at: parsed.endsAt,
    timezone: "Asia/Taipei",
    open_before_minutes: windowConfig.beforeMinutes,
    close_after_minutes: windowConfig.afterMinutes,
    enabled: true,
    status: "active",
    metadata: input.metadata || {}
  };
}

async function callQrSigninAppsScriptFallback(env: Env, action: string, payload: Record<string, unknown>): Promise<unknown | null> {
  const endpoint = String(env.QR_SIGNIN_APPS_SCRIPT_URL || "").trim();
  if (!endpoint) return null;

  const url = new URL(endpoint);
  url.searchParams.set("action", action);
  url.searchParams.set("payload", JSON.stringify(payload || {}));
  url.searchParams.set("_", String(Date.now()));

  const response = await fetch(url.toString(), { method: "GET" });
  const text = await response.text();
  if (!response.ok) throw new Error(`QR_SIGNIN_APPS_SCRIPT_FAILED ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function qrSigninMeetingDisplay(row: QrSigninMeetingRow): Record<string, unknown> {
  const start = row.starts_at ? new Date(row.starts_at) : null;
  const datePrefix = start && Number.isFinite(start.getTime()) ? formatTaipeiDate(start, "M/d") : (row.meeting_date || "");
  const course = datePrefix ? `${datePrefix} ${row.title}` : row.title;
  const now = Date.now();
  const startsAt = row.starts_at ? Date.parse(row.starts_at) : NaN;
  const endsAt = row.ends_at ? Date.parse(row.ends_at) : NaN;
  const isRunning = Number.isFinite(startsAt) && Number.isFinite(endsAt)
    ? now >= startsAt - Number(row.open_before_minutes || 0) * 60000 && now <= endsAt + Number(row.close_after_minutes || 0) * 60000
    : false;

  return {
    id: row.id,
    meetingId: row.id,
    course,
    date: row.time_label || "",
    title: row.title,
    meetingDate: row.meeting_date || "",
    timeLabel: row.time_label || "",
    startTime: row.starts_at || "",
    endTime: row.ends_at || "",
    isRunning,
    selected: isRunning,
    source: row.source,
    sourceId: row.source_id || "",
    calendarEventId: row.source_id || "",
    calendarId: row.calendar_id || "",
    status: row.status,
    enabled: row.enabled
  };
}

async function listQrSigninMeetingRows(env: Env, appEnv: AppEnvName, limit = 200): Promise<QrSigninMeetingRow[]> {
  const table = getQrSigninMeetingTable(env);
  const rows = await supabaseGet<QrSigninMeetingRow[]>(
    env,
    `${encodeURIComponent(table)}?select=*&env=eq.${encodeURIComponent(appEnv)}&enabled=eq.true&status=eq.active&order=starts_at.desc.nullslast&limit=${limit}`
  );
  return rows;
}

async function findQrSigninMeetingBySource(env: Env, row: Record<string, unknown>): Promise<QrSigninMeetingRow | null> {
  const table = getQrSigninMeetingTable(env);
  const envName = firstText(row.env);
  const source = firstText(row.source);
  const sourceId = firstText(row.source_id);
  if (!envName || !source || !sourceId) return null;

  const rows = await supabaseGet<QrSigninMeetingRow[]>(
    env,
    `${encodeURIComponent(table)}?select=*&env=eq.${encodeURIComponent(envName)}&source=eq.${encodeURIComponent(source)}&source_id=eq.${encodeURIComponent(sourceId)}&limit=1`
  );
  return rows[0] || null;
}

async function findQrSigninMeetingByIdentity(env: Env, row: Record<string, unknown>): Promise<QrSigninMeetingRow | null> {
  const table = getQrSigninMeetingTable(env);
  const envName = firstText(row.env);
  const title = firstText(row.title);
  const startsAt = firstText(row.starts_at);
  const endsAt = firstText(row.ends_at);
  if (!envName || !title || !startsAt || !endsAt) return null;

  const rows = await supabaseGet<QrSigninMeetingRow[]>(
    env,
    `${encodeURIComponent(table)}?select=*&env=eq.${encodeURIComponent(envName)}&title=eq.${encodeURIComponent(title)}&starts_at=eq.${encodeURIComponent(startsAt)}&ends_at=eq.${encodeURIComponent(endsAt)}&order=created_at.asc&limit=1`
  );
  return rows[0] || null;
}

async function saveQrSigninMeetingRows(env: Env, rows: Record<string, unknown>[]): Promise<QrSigninMeetingRow[]> {
  const table = getQrSigninMeetingTable(env);
  const saved: QrSigninMeetingRow[] = [];

  for (const row of rows) {
    const existing = await findQrSigninMeetingBySource(env, row).catch(() => null)
      || await findQrSigninMeetingByIdentity(env, row).catch(() => null);
    if (existing) {
      saved.push(existing);
      continue;
    }

    const inserted = await supabasePost<QrSigninMeetingRow[]>(env, table, row);
    if (Array.isArray(inserted) && inserted[0]) saved.push(inserted[0]);
  }

  return saved;
}

async function syncQrSigninMeetingsFromIcs(env: Env, payload: Record<string, unknown>): Promise<QrSigninMeetingRow[]> {
  const icsUrl = getQrSigninCalendarIcsUrl(env);
  if (!icsUrl) throw new Error("QR_SIGNIN_CALENDAR_ICS_URL_MISSING");

  const response = await fetch(icsUrl, { method: "GET" });
  const text = await response.text();
  if (!response.ok) throw new Error(`QR_SIGNIN_ICS_FETCH_FAILED ${response.status} ${text.slice(0, 200)}`);

  const rows = parseQrSigninIcsRows(text, env, payload);
  if (!rows.length) return [];

  const table = getQrSigninMeetingTable(env);
  return await saveQrSigninMeetingRows(env, rows);
}

async function syncQrSigninMeetingsFromAppsScript(env: Env, payload: Record<string, unknown>): Promise<QrSigninMeetingRow[]> {
  const fallback = await callQrSigninAppsScriptFallback(env, "getQrSigninMeetings", payload) as any;
  const data = fallback && fallback.data ? fallback.data : fallback;
  const meetings = data && Array.isArray(data.meetings) ? data.meetings : [];
  if (!meetings.length) return [];

  const envName = normalizeEnv(firstText(payload.env, payload.runtime));
  const rows = meetings.map((meeting: any) => toQrSigninMeetingRowFromLegacy({
    envName,
    course: meeting.course || meeting.title,
    date: meeting.date || meeting.time || meeting.timeLabel,
    source: "apps-script-calendar",
    sourceId: firstText(meeting.calendarEventId, meeting.sourceId, meeting.id, meeting.eventId, meeting.uid),
    metadata: { rawSource: "apps-script", rawMeeting: meeting }
  }));
  const table = getQrSigninMeetingTable(env);
  return await saveQrSigninMeetingRows(env, rows);
}

async function getQrSigninMeetings(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const forceSync = booleanFromUnknown(payload.forceSync) || booleanFromUnknown(payload.syncCalendar);
  let rows: QrSigninMeetingRow[] = [];
  let syncSource = "supabase";
  let syncError = "";

  try {
    rows = await listQrSigninMeetingRows(env, appEnv);
  } catch (error) {
    syncError = error instanceof Error ? error.message : String(error);
  }

  if (forceSync || rows.length === 0) {
    try {
      rows = await syncQrSigninMeetingsFromIcs(env, { ...payload, env: appEnv });
      syncSource = "google-calendar-ics";
    } catch (icsError) {
      try {
        rows = await syncQrSigninMeetingsFromAppsScript(env, { ...payload, env: appEnv });
        syncSource = "apps-script-calendar";
        syncError = icsError instanceof Error ? icsError.message : String(icsError);
      } catch (fallbackError) {
        syncError = [icsError, fallbackError].map((error) => error instanceof Error ? error.message : String(error)).filter(Boolean).join(" | ");
      }
    }

    if (!rows.length) {
      rows = await listQrSigninMeetingRows(env, appEnv).catch(() => []);
    }
  }

  const meetings = rows.map(qrSigninMeetingDisplay);

  return {
    ok: true,
    action: "getQrSigninMeetings",
    source: syncSource,
    table: getQrSigninMeetingTable(env),
    count: meetings.length,
    data: {
      ok: true,
      meetings,
      source: syncSource,
      syncError
    },
    meetings,
    diagnostics: {
      syncSource,
      syncError,
      hasAppsScriptFallback: !!env.QR_SIGNIN_APPS_SCRIPT_URL,
      calendarId: getQrSigninCalendarId(env)
    }
  };
}

async function createQrSigninMeeting(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const title = firstText(payload.title, payload.meeting, payload.course);
  const date = firstText(payload.date, payload.time, payload.timeLabel);

  if (!title || !date) {
    return { ok: false, action: "createQrSigninMeeting", error: "MISSING_MEETING_FIELD", message: "缺少會議名稱或會議時間" };
  }

  const record = toQrSigninMeetingRowFromLegacy({
    envName: appEnv,
    course: title,
    date,
    source: firstText(payload.source) || "manual",
    sourceId: firstText(payload.sourceId) || undefined,
    metadata: { rawPayload: payload }
  });

  const table = getQrSigninMeetingTable(env);
  const savedRows = await saveQrSigninMeetingRows(env, [record]);
  const saved = savedRows[0] || record as QrSigninMeetingRow;
  const meeting = qrSigninMeetingDisplay(saved);

  return {
    ok: true,
    action: "createQrSigninMeeting",
    source: "skhps-backend-supabase",
    table,
    data: { ok: true, meeting },
    meeting
  };
}

async function getQrSigninMeeting(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const meetingId = firstText(payload.meetingId, payload.id);
  if (!meetingId) return { ok: false, action: "getQrSigninMeeting", error: "MISSING_MEETING_ID" };

  const table = getQrSigninMeetingTable(env);
  const rows = await supabaseGet<QrSigninMeetingRow[]>(env, `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(meetingId)}&limit=1`);
  if (!rows.length) return { ok: false, action: "getQrSigninMeeting", error: "MEETING_NOT_FOUND", meetingId };

  const meeting = qrSigninMeetingDisplay(rows[0]);
  return { ok: true, action: "getQrSigninMeeting", source: "skhps-backend-supabase", table, data: { ok: true, meeting }, meeting };
}

function normalizeQrSigninSubmitPayload(body: any): Record<string, unknown> {
  const payload = body && body.payload && typeof body.payload === "object" ? body.payload : body || {};
  return payload as Record<string, unknown>;
}

function qrSigninFrontendStatus(row: QrSigninRecordRow): string {
  if (row.status === "signed" || row.status === "manual") return "success";
  if (row.status === "duplicate") return "duplicate";
  if (row.status === "outside_window" || row.status === "late") return "closed";
  return row.status || "failed";
}

function qrSigninReasonText(status: string): string {
  if (status === "duplicate") return "already-signed";
  if (status === "outside_window" || status === "late") return "not-in-window";
  if (status === "error") return "backend-error";
  return "";
}

function qrSigninResultFromRecord(row: QrSigninRecordRow, meeting?: QrSigninMeetingRow | null): Record<string, unknown> {
  const display = meeting ? qrSigninMeetingDisplay(meeting) : {} as Record<string, unknown>;
  const status = qrSigninFrontendStatus(row);
  const reason = row.reason || qrSigninReasonText(row.status);
  return {
    resultId: row.id,
    meetingId: row.meeting_id,
    status,
    reason,
    meeting: firstText(display.title, display.course, "會議簽到"),
    date: firstText(display.meetingDate),
    time: firstText(display.timeLabel),
    name: row.name,
    employeeId: row.employee_id || "",
    role: row.role || "",
    signedAt: row.submitted_at || row.signed_at,
    submittedAt: row.submitted_at,
    recordedSignedAt: row.signed_at || "",
    message: status === "success" ? "簽到成功" : status === "duplicate" ? "你已經簽到過，不需要重複送出" : "簽到失敗"
  };
}

async function findQrSigninMeetingRow(env: Env, meetingId: string): Promise<QrSigninMeetingRow | null> {
  const table = getQrSigninMeetingTable(env);
  const rows = await supabaseGet<QrSigninMeetingRow[]>(env, `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(meetingId)}&limit=1`);
  return rows[0] || null;
}

async function findCurrentQrSigninRecord(env: Env, input: { meetingId: string; employeeId: string; name: string }): Promise<QrSigninRecordRow | null> {
  const table = getQrSigninRecordTable(env);
  let path = `${encodeURIComponent(table)}?select=*&meeting_id=eq.${encodeURIComponent(input.meetingId)}&status=not.in.(duplicate,void,error)&order=submitted_at.asc&limit=1`;
  if (input.employeeId) {
    path += `&employee_id=eq.${encodeURIComponent(input.employeeId)}`;
  } else {
    path += `&name=eq.${encodeURIComponent(input.name)}`;
  }
  const rows = await supabaseGet<QrSigninRecordRow[]>(env, path);
  return rows[0] || null;
}

function qrSigninDuplicateResultFromRecord(row: QrSigninRecordRow, meeting?: QrSigninMeetingRow | null): Record<string, unknown> {
  const result = qrSigninResultFromRecord(row, meeting);
  return {
    ...result,
    status: "duplicate",
    reason: "already-signed",
    duplicateOf: row.id,
    message: "你已經簽到過，不需要重複送出"
  };
}

function determineQrSigninRecordStatus(meeting: QrSigninMeetingRow): { status: string; reason: string } {
  const now = Date.now();
  const startsAt = meeting.starts_at ? Date.parse(meeting.starts_at) : NaN;
  const endsAt = meeting.ends_at ? Date.parse(meeting.ends_at) : NaN;

  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    return { status: "signed", reason: "" };
  }

  const start = startsAt - Number(meeting.open_before_minutes || 0) * 60000;
  const end = endsAt + Number(meeting.close_after_minutes || 0) * 60000;

  if (now < start || now > end) {
    return { status: "outside_window", reason: "not-in-window" };
  }

  return { status: "signed", reason: "" };
}

async function insertQrSigninAudit(env: Env, input: Record<string, unknown>): Promise<void> {
  const table = getQrSigninAuditTable(env);
  await supabasePost<unknown[]>(env, table, input).catch(() => []);
}

async function submitQrSignin(env: Env, body: any) {
  const payload = normalizeQrSigninSubmitPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  let meetingId = firstText(payload.meetingId, payload.id);
  const name = firstText(payload.name);
  const employeeId = firstText(payload.employeeId, payload.emp);
  const role = firstText(payload.role);
  const signedAt = new Date().toISOString();
  const clientRequestId = firstText(payload.clientRequestId);

  if (!name || !role) {
    return { ok: false, action: "submitQrSignin", error: "MISSING_FIELD", message: "缺少姓名或職級" };
  }

  let meeting = meetingId ? await findQrSigninMeetingRow(env, meetingId) : null;

  if (!meeting) {
    const course = firstText(payload.course, payload.title, payload.meeting);
    const date = firstText(payload.date, payload.time, payload.timeLabel, payload.meetingTime);

    if (!course || !date) {
      return { ok: false, action: "submitQrSignin", error: "MISSING_FIELD", message: "缺少場次資訊" };
    }

    const record = toQrSigninMeetingRowFromLegacy({
      envName: appEnv,
      course,
      date,
      source: "signin-payload",
      sourceId: firstText(payload.sourceId) || undefined,
      metadata: { rawPayload: payload, createdBy: "submitQrSignin" }
    });
    const savedRows = await saveQrSigninMeetingRows(env, [record]);
    meeting = savedRows[0] || record as QrSigninMeetingRow;
    meetingId = meeting.id;
  }

  if (!meeting || !meeting.enabled || meeting.status !== "active") {
    return { ok: false, action: "submitQrSignin", error: "MEETING_NOT_FOUND", message: "找不到可簽到的會議場次" };
  }

  const statusInfo = determineQrSigninRecordStatus(meeting);
  const table = getQrSigninRecordTable(env);
  const existing = await findCurrentQrSigninRecord(env, { meetingId, employeeId, name });
  if (existing && (existing.status === "signed" || existing.status === "manual")) {
    await insertQrSigninAudit(env, {
      record_id: existing.id || null,
      meeting_id: meetingId,
      action: "duplicate-signin",
      actor_name: name,
      actor_employee_id: employeeId || null,
      before_data: existing,
      after_data: existing,
      metadata: {
        source: "submitQrSignin",
        rawPayload: payload,
        duplicateOf: existing.id
      }
    });
    const duplicateResult = qrSigninDuplicateResultFromRecord(existing, meeting);
    return {
      ok: true,
      action: "submitQrSignin",
      source: "skhps-backend-supabase",
      table: getQrSigninRecordTable(env),
      data: duplicateResult,
      ...duplicateResult
    };
  }

  if (existing) {
    if (statusInfo.status === "signed") {
      const patch: Record<string, unknown> = {
        role,
        signed_at: signedAt,
        status: "signed",
        reason: null,
        client_request_id: clientRequestId || null,
        metadata: {
          rawPayload: payload,
          previousStatus: existing.status,
          previousReason: existing.reason || ""
        }
      };
      const updated = await supabasePatch<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(existing.id)}`, patch);
      const saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...existing, ...patch } as QrSigninRecordRow;
      await insertQrSigninAudit(env, {
        record_id: saved.id || null,
        meeting_id: meetingId,
        action: "resolve-failed-signin",
        actor_name: name,
        actor_employee_id: employeeId || null,
        before_data: existing,
        after_data: saved,
        metadata: { source: "submitQrSignin", rawPayload: payload }
      });
      const result = qrSigninResultFromRecord(saved, meeting);
      return {
        ok: true,
        action: "submitQrSignin",
        source: "skhps-backend-supabase",
        table,
        data: result,
        ...result
      };
    }

    const patch: Record<string, unknown> = {
      role,
      signed_at: signedAt,
      status: statusInfo.status,
      reason: statusInfo.reason || null,
      client_request_id: clientRequestId || null,
      metadata: {
        rawPayload: payload,
        previousStatus: existing.status,
        previousReason: existing.reason || ""
      }
    };
    const updated = await supabasePatch<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(existing.id)}`, patch);
    const saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...existing, ...patch } as QrSigninRecordRow;
    await insertQrSigninAudit(env, {
      record_id: saved.id || null,
      meeting_id: meetingId,
      action: "repeated-failed-signin",
      actor_name: name,
      actor_employee_id: employeeId || null,
      before_data: existing,
      after_data: saved,
      metadata: {
        source: "submitQrSignin",
        rawPayload: payload,
        attemptedStatus: statusInfo.status,
        attemptedReason: statusInfo.reason || ""
      }
    });
    const failedResult = qrSigninResultFromRecord(saved, meeting);
    return {
      ok: true,
      action: "submitQrSignin",
      source: "skhps-backend-supabase",
      table,
      data: failedResult,
      ...failedResult
    };
  }

  const record: Record<string, unknown> = {
    meeting_id: meetingId,
    app_id: "qr-signin",
    env: appEnv,
    name,
    employee_id: employeeId || null,
    role,
    staff_source: "StaffMaster",
    signed_at: signedAt,
    submitted_at: signedAt,
    status: statusInfo.status,
    reason: statusInfo.reason || null,
    source: "qr",
    duplicate_of: null,
    client_request_id: clientRequestId || null,
    metadata: {
      rawPayload: payload,
      duplicateOf: ""
    }
  };

  const inserted = await supabasePost<QrSigninRecordRow[]>(env, table, record);
  const saved = Array.isArray(inserted) && inserted[0] ? inserted[0] : record as QrSigninRecordRow;
  await insertQrSigninAudit(env, {
    record_id: saved.id || null,
    meeting_id: meetingId,
    action: statusInfo.status === "signed" ? "qr-signin" : "failed-signin",
    actor_name: name,
    actor_employee_id: employeeId || null,
    after_data: saved,
    metadata: { source: "submitQrSignin" }
  });
  const result = qrSigninResultFromRecord(saved, meeting);

  return {
    ok: true,
    action: "submitQrSignin",
    source: "skhps-backend-supabase",
    table,
    data: result,
    ...result
  };
}

async function getQrSigninResult(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const resultId = firstText(payload.resultId, payload.id);
  if (!resultId) return { ok: false, action: "getQrSigninResult", error: "MISSING_RESULT_ID" };

  const table = getQrSigninRecordTable(env);
  const rows = await supabaseGet<QrSigninRecordRow[]>(env, `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(resultId)}&limit=1`);
  if (!rows.length) return { ok: false, action: "getQrSigninResult", error: "RESULT_NOT_FOUND", resultId };

  const meeting = await findQrSigninMeetingRow(env, rows[0].meeting_id).catch(() => null);
  const result = qrSigninResultFromRecord(rows[0], meeting);
  return { ok: true, action: "getQrSigninResult", source: "skhps-backend-supabase", table, data: result, ...result };
}

async function listQrSigninRecords(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const limit = Math.min(Math.max(qrNumberFromEnv(payload.limit, 100), 1), 500);
  const meetingId = firstText(payload.meetingId);
  const table = getQrSigninRecordTable(env);
  let path = `${encodeURIComponent(table)}?select=*&order=signed_at.asc.nullslast,submitted_at.asc.nullslast,created_at.asc&limit=${limit}`;
  if (meetingId) path += `&meeting_id=eq.${encodeURIComponent(meetingId)}`;
  const rows = await supabaseGet<QrSigninRecordRow[]>(env, path);

  const meetingIds = Array.from(new Set(rows.map((row) => row.meeting_id).filter(Boolean)));
  const meetings = new Map<string, QrSigninMeetingRow>();
  for (const id of meetingIds.slice(0, 30)) {
    const meeting = await findQrSigninMeetingRow(env, id).catch(() => null);
    if (meeting) meetings.set(id, meeting);
  }

  const records = rows.map((row) => qrSigninResultFromRecord(row, meetings.get(row.meeting_id) || null));
  return { ok: true, action: "listQrSigninRecords", source: "skhps-backend-supabase", table, count: records.length, records, data: records };
}

async function getQrSigninDashboard(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const summaryView = getQrSigninSummaryView(env);
  let summaries: QrSigninSummaryRow[] = [];
  summaries = await supabaseGet<QrSigninSummaryRow[]>(
    env,
    `${encodeURIComponent(summaryView)}?select=*&env=eq.${encodeURIComponent(appEnv)}&order=starts_at.desc.nullslast&limit=20`
  ).catch(() => []);
  const recordsResult = await listQrSigninRecords(env, { payload: { limit: 100 } });
  const records = Array.isArray(recordsResult.records) ? recordsResult.records as Record<string, unknown>[] : [];

  return {
    ok: true,
    action: "getQrSigninDashboard",
    source: "skhps-backend-supabase",
    data: {
      courses: summaries.map((item) => ({
        title: item.title,
        date: [item.meeting_date, item.time_label].filter(Boolean).join(" "),
        status: item.enabled && item.status === "active" ? "可簽到" : "停用",
        signed: Number(item.signed_count || 0),
        expected: "-"
      })),
      qr: {
        code: "使用 meetingId",
        window: summaries[0] ? String(summaries[0].time_label || "-") : "-",
        link: "QR URL 使用 meetingId"
      },
      records: records.map((record) => ({
        name: record.name,
        emp: record.employeeId,
        role: record.role,
        signedAt: record.signedAt,
        status: record.status
      })),
      system: {
        backend: "Cloudflare Worker",
        calendar: "Supabase / QrSigninMeeting",
        sheet: "Supabase / QrSigninRecord",
        meetingId: "enabled"
      }
    }
  };
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

  if (action === "recordQuickLoginNewStaff") {
    try {
      const result = await recordQuickLoginNewStaff(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }


  if (action === "listStaffMaster") {
    try {
      const result = await listStaffMaster(env, body);
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

  if (action === "upsertStaffMaster") {
    try {
      const result = await upsertStaffMaster(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "updateStaffMasterStatus") {
    try {
      const result = await updateStaffMasterStatus(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "reorderStaffMaster") {
    try {
      const result = await reorderStaffMaster(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }


  if (action === "getQrSigninMeetings") {
    try {
      const result = await getQrSigninMeetings(env, body);
      return json(result, result.ok === false ? 502 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }


  if (action === "getQrSigninMeeting") {
    try {
      const result = await getQrSigninMeeting(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({ ok: false, action, source: "skhps-backend", error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "createQrSigninMeeting") {
    try {
      const result = await createQrSigninMeeting(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({ ok: false, action, source: "skhps-backend", error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "submitQrSignin") {
    try {
      const result = await submitQrSignin(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "getQrSigninResult") {
    try {
      const result = await getQrSigninResult(env, body);
      return json(result, result.ok === false ? 404 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "listQrSigninRecords") {
    try {
      const result = await listQrSigninRecords(env, body);
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

  if (action === "getQrSigninDashboard") {
    try {
      const result = await getQrSigninDashboard(env, body);
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
        version: "0.1.4-staffmaster-admin",
        hasSupabaseUrl: !!env.SUPABASE_URL,
        hasSupabaseServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
        upload: {
          route: "/api/upload-file",
          bucket: env.SUPABASE_STORAGE_BUCKET || DEFAULT_UPLOAD_BUCKET,
          table: env.SUPABASE_UPLOAD_TABLE || DEFAULT_UPLOAD_TABLE,
          maxFileSizeBytes: getMaxFileSize(env),
          affectsGate: false
        },
        qrSignin: {
          meetingTable: env.QR_SIGNIN_MEETING_TABLE || DEFAULT_QR_SIGNIN_MEETING_TABLE,
          recordTable: env.QR_SIGNIN_RECORD_TABLE || DEFAULT_QR_SIGNIN_RECORD_TABLE,
          calendarId: env.QR_SIGNIN_CALENDAR_ID || DEFAULT_QR_SIGNIN_CALENDAR_ID,
          hasCalendarIcsUrl: !!env.QR_SIGNIN_CALENDAR_ICS_URL,
          hasAppsScriptFallback: !!env.QR_SIGNIN_APPS_SCRIPT_URL
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
