/*
 * 檔案位置：skhps-backend-worker/src/index.ts
 * 時間戳記：2026-07-02 11:25 UTC+8
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
 *   - getCssRegistryRuntime / getCssSheetRuntime（相容舊 action，實際讀 Supabase CssRegistryRuntimeRow）
 *   - saveCssSheetRows（CSS Setting Studio 存檔，寫回 Supabase CssRegistryRule，layer 固定 override / env 固定 global；Google Sheet 已 retire，不再 dual-write）
 *   - deleteCssRegistryRows（精準刪除 Supabase CssRegistryRule 測試/維護列）
 *   - getQuickLoginStaff（讀 Supabase 共用人員主檔 StaffMaster，並以 NewStaff 最新新增時間覆蓋既有員編密碼）
 *   - recordQuickLoginNewStaff（記錄 quick-login wrapper LOGIN 帳密；不作為顯示名單來源）
 *   - listStaffMaster / upsertStaffMaster / updateStaffMasterStatus / reorderStaffMaster（StaffMaster 管理）
 *   - QR 簽到後台管理：updateQrSigninRecord / exportQrSigninRecords
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
  SUPABASE_CSS_REGISTRY_RUNTIME_VIEW?: string;
  MAX_FILE_SIZE_BYTES?: string;
  APP_DEFAULT_TABLE?: string;

  // 2026-07-17：wrangler.toml 早就綁了這個 KV，但一直沒被用；拿來做
  // 日曆/會議這種「全 env 共用、變動不頻繁」的邊緣快取。
  SKHPS_CACHE?: KVNamespace;

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
const DEFAULT_CSS_REGISTRY_RUNTIME_VIEW = "CssRegistryRuntimeRow";
const DEFAULT_APP_DEFAULT_TABLE = "Default";
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

async function supabaseGet<T>(env: Env, path: string, extraHeaders?: HeadersInit): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
  const url = `${baseUrl}/rest/v1/${path.replace(/^\/+/, "")}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...getSupabaseHeaders(env),
      ...(extraHeaders || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SUPABASE_GET_FAILED ${response.status} ${text}`);
  }

  return await response.json() as T;
}

async function supabaseGetAllRows(env: Env, path: string, pageSize = 1000, maxPages = 20): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const rows = await supabaseGet<Record<string, unknown>[]>(env, path, {
      "Range-Unit": "items",
      "Range": `${from}-${to}`
    });

    out.push(...rows);

    if (rows.length < pageSize) {
      return out;
    }
  }

  throw new Error(`SUPABASE_GET_PAGE_LIMIT_EXCEEDED ${maxPages} pages`);
}

function getCssRegistryRuntimeView(env: Env): string {
  return String(env.SUPABASE_CSS_REGISTRY_RUNTIME_VIEW || DEFAULT_CSS_REGISTRY_RUNTIME_VIEW).trim() || DEFAULT_CSS_REGISTRY_RUNTIME_VIEW;
}

function normalizeCssRegistryKeys(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : String(input || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const keys = raw
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);

  return keys.length ? keys : ["cssMain"];
}

// 2026-07-17（加速）：原本 `...row` 把 Supabase 每一欄都攤開送給前端，導致
// 每筆 row 夾帶一堆「套 CSS 用不到」的欄位（source、三份時間戳、sheet_key/
// __order/sort_order 重複…）。實測前端 css-sheet-runtime 組 CSS 只讀下面這 9
// 個欄位，其餘全砍——單筆 ~478b → ~230b。若之後有欄位真的要用，回來這裡加。
function normalizeCssRegistryRuntimeRow(row: Record<string, unknown>, index: number): Record<string, unknown> {
  return {
    sheetKey: firstText(row.sheetKey, row.sheet_key, "cssMain"),
    component: firstText(row.component),
    selector: firstText(row.selector, row.className, row.class_name),
    className: firstText(row.className, row.selector, row.class_name),
    property: firstText(row.property),
    value: firstText(row.value),
    description: firstText(row.description),
    updatedAt: firstText(row.updatedAt, row.updated_at, row.source_updated_at),
    __order: Number(row.__order ?? row.sort_order ?? index)
  };
}

async function getCssRegistryRuntime(env: Env, body: any, action: string): Promise<Record<string, unknown>> {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env, payload.runtime, payload.requestedRuntime));
  const registryKeys = normalizeCssRegistryKeys(
    payload.registryKeys ??
    payload.cssRegistryKeys ??
    payload.sheetKeys ??
    payload.sheets ??
    payload.sheetKey
  );
  const view = getCssRegistryRuntimeView(env);
  const envs = ["global", appEnv].filter((item, index, list) => list.indexOf(item) === index);
  const envFilter = envs.map((item) => encodeURIComponent(item)).join(",");
  const path = [
    `${encodeURIComponent(view)}?select=*`,
    `env=in.(${envFilter})`
  ].join("&");
  const rows = await supabaseGetAllRows(env, path);
  const keySet = new Set(registryKeys);
  const normalizedRows = rows
    .map(normalizeCssRegistryRuntimeRow)
    .filter((row) => keySet.has(firstText(row.sheetKey, row.sheet_key, "cssMain")))
    .sort((a, b) => Number(a.__order ?? a.sort_order ?? 0) - Number(b.__order ?? b.sort_order ?? 0));

  return {
    ok: true,
    action,
    canonicalAction: "getCssRegistryRuntime",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase CssRegistryRuntimeRow / Cloudflare Worker",
    env: appEnv,
    envs,
    view,
    registryKeys,
    sheetKeys: registryKeys,
    count: normalizedRows.length,
    rows: normalizedRows
    // 2026-07-17（加速）：移除 `data: { rows: normalizedRows }`——那是 rows 的
    // 原封重複（2.15MB），前端 normalizeBackendRows 只讀 response.rows、從沒讀
    // 過 data，純浪費。若未來有 client 依賴 data.rows 再回來加回。
  };
}

function normalizeCssSheetSaveRow(row: any): {
  component: string;
  selector: string;
  property: string;
  value: string;
  description: string;
} {
  return {
    component: firstText(row && row.component),
    selector: firstText(row && row.className, row && row.selector),
    property: firstText(row && row.property),
    value: firstText(row && row.value),
    description: firstText(row && row.description)
  };
}

function normalizeCssRegistrySource(input: unknown): string {
  const text = firstText(input)
    .replace(/[^a-zA-Z0-9._:-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return text || "css-setting-studio";
}

/*
 * CSS Setting Studio 存檔目標。Google Sheet 已 retire，這是唯一的寫入路徑。
 * 固定寫 env=global / layer=override，對應舊 Sheet 時代「目前值」那一列（不是 default 列）。
 * sort_order 沿用既有列的值，避免每次存檔都把排序打回 0。
 */
async function saveCssRegistryRows(env: Env, body: any): Promise<Record<string, unknown>> {
  const payload = normalizeRegistryPayload(body);
  const sheetKey = firstText(payload.sheetKey, payload.tabKey, "cssMain");
  const source = normalizeCssRegistrySource(payload.source);
  const inputRows = Array.isArray(payload.rows) ? payload.rows : [];

  const rows = inputRows
    .map(normalizeCssSheetSaveRow)
    .filter((row) => row.component && row.selector && row.property && row.value !== "");

  if (!rows.length) {
    return {
      ok: false,
      action: "saveCssSheetRows",
      canonicalAction: "saveCssRegistryRows",
      source: "skhps-backend-supabase",
      error: "NO_ROWS",
      message: "沒有可儲存的 CSS 列"
    };
  }

  const table = "CssRegistryRule";
  const components = rows
    .map((row) => row.component)
    .filter((item, index, list) => list.indexOf(item) === index);
  const componentFilter = components.map((item) => encodeURIComponent(item)).join(",");

  const existingRows = await supabaseGetAllRows(
    env,
    `${encodeURIComponent(table)}?env=eq.global&layer=eq.override&component=in.(${componentFilter})&select=component,selector,property,sort_order`
  );

  const sortOrderKey = (component: string, selector: string, property: string) =>
    `${component}${selector}${property}`;

  const existingSortOrder = new Map<string, number>();
  existingRows.forEach((row) => {
    existingSortOrder.set(
      sortOrderKey(String(row.component), String(row.selector), String(row.property)),
      Number(row.sort_order ?? 0)
    );
  });

  const nowIso = new Date().toISOString();
  let updatedCount = 0;

  const records = rows.map((row) => {
    const key = sortOrderKey(row.component, row.selector, row.property);
    const isExisting = existingSortOrder.has(key);
    if (isExisting) updatedCount += 1;

    return {
      env: "global",
      sheet_key: sheetKey,
      component: row.component,
      selector: row.selector,
      property: row.property,
      value: row.value,
      description: row.description,
      source_updated_at: nowIso,
      layer: "override",
      enabled: true,
      sort_order: existingSortOrder.get(key) ?? 0,
      source
    };
  });

  await supabaseUpsert<Record<string, unknown>[]>(
    env,
    table,
    records,
    "env,layer,component,selector,property"
  );

  return {
    ok: true,
    action: "saveCssSheetRows",
    canonicalAction: "saveCssRegistryRows",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase CssRegistryRule / Cloudflare Worker",
    registrySource: source,
    sheetKey,
    insertedRows: records.length - updatedCount,
    updatedRows: updatedCount,
    updatedAt: nowIso
  };
}

function cssRegistryDeleteRowsFromPayload(payload: any): {
  component: string;
  selector: string;
  property: string;
  source: string;
}[] {
  const inputRows = Array.isArray(payload.rows) ? payload.rows : [payload];

  return inputRows
    .map((row: any) => ({
      component: firstText(row && row.component),
      selector: firstText(row && row.className, row && row.selector),
      property: firstText(row && row.property),
      source: firstText(row && row.source)
    }))
    .filter((row: {
      component: string;
      selector: string;
      property: string;
      source: string;
    }) => row.component && row.selector && row.property);
}

async function deleteCssRegistryRows(env: Env, body: any): Promise<Record<string, unknown>> {
  const payload = normalizeRegistryPayload(body);
  const rows = cssRegistryDeleteRowsFromPayload(payload);

  if (!rows.length) {
    return {
      ok: false,
      action: "deleteCssRegistryRows",
      source: "skhps-backend-supabase",
      error: "NO_ROWS",
      message: "缺少可刪除的 CSS registry key：component + className/selector + property"
    };
  }

  const table = "CssRegistryRule";
  let deletedRows = 0;

  for (const row of rows) {
    const filters = [
      "env=eq.global",
      "layer=eq.override",
      `component=eq.${encodeURIComponent(row.component)}`,
      `selector=eq.${encodeURIComponent(row.selector)}`,
      `property=eq.${encodeURIComponent(row.property)}`
    ];

    if (row.source) {
      filters.push(`source=eq.${encodeURIComponent(row.source)}`);
    }

    const deleted = await supabaseDelete<Record<string, unknown>[]>(
      env,
      table,
      filters.join("&")
    );

    deletedRows += Array.isArray(deleted) ? deleted.length : 0;
  }

  return {
    ok: true,
    action: "deleteCssRegistryRows",
    source: "skhps-backend-supabase",
    sourceLabel: "Supabase CssRegistryRule / Cloudflare Worker",
    deletedRows
  };
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

async function supabaseDelete<T>(
  env: Env,
  table: string,
  query: string
): Promise<T> {
  const baseUrl = getSupabaseBaseUrl(env);
  const safeTable = table.replace(/^\/+/, "");
  const safeQuery = query.replace(/^\?+/, "");

  const response = await fetch(`${baseUrl}/rest/v1/${safeTable}?${safeQuery}`, {
    method: "DELETE",
    headers: {
      ...getSupabaseHeaders(env),
      "Prefer": "return=representation"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SUPABASE_DELETE_FAILED ${response.status} ${text}`);
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

type QuickLoginPerson = {
  id: string;
  name: string;
  emp: string;
  role: string;
  title: string;
  group: string;
  password: string;
  sortOrder: number;
  sort_order: number;
  active: boolean;
  enabled: boolean;
  allowQuickLogin: boolean;
  allow_quick_login: boolean;
  note: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  source: string;
};

function toQuickLoginPerson(row: StaffMasterRow, tableName: string): QuickLoginPerson {
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

async function getLatestNewStaffByEmp(env: Env): Promise<Record<string, StaffMasterRow>> {
  const tableName = getQuickLoginNewStaffTable();
  const rows = await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?select=*&order=${encodeURIComponent("新增時間")}.desc.nullslast`
  );
  const latestByEmp: Record<string, StaffMasterRow> = {};

  for (const row of rows) {
    const emp = stringValue(row, ["員工編號", "emp", "employee_id"], "");
    const password = stringValue(row, ["密碼", "password", "Password", "PassWord"], "");
    // 員編大小寫視為同一個帳號：dedup key 一律轉大寫，不然 ABC123 / abc123
    // 會被當成兩個帳號，各自維護自己的「最新一筆」，彼此不會互相覆蓋。
    const empKey = emp.toUpperCase();
    if (empKey && password && !latestByEmp[empKey]) {
      latestByEmp[empKey] = row;
    }
  }

  return latestByEmp;
}

function mergeNewStaffIntoQuickLoginPerson(
  base: QuickLoginPerson | null,
  row: StaffMasterRow,
  tableName: string
): QuickLoginPerson {
  const metadata = rowMetadata(row);
  const emp = stringValue(row, ["員工編號", "emp", "employee_id"], base ? base.emp : "");
  const password = stringValue(row, ["密碼", "password", "Password", "PassWord"], base ? base.password : "");
  const name = metadataString(row, metadata, ["姓名", "display_name", "name", "Name"], base ? base.name : emp);
  const role = metadataString(row, metadata, ["職級", "role", "title"], base ? base.role : "");
  const group = metadataString(row, metadata, ["分組", "group_key", "group"], base ? base.group : "");
  const note = metadataString(row, metadata, ["備註", "note"], base ? base.note : "");
  const addedAt = stringValue(row, ["新增時間", "created_at", "createdAt"], "");
  const sortOrder = base ? Number(base.sortOrder || 999) : 999;
  const active = base ? base.active : true;
  const allowQuickLogin = base ? base.allowQuickLogin : true;

  return {
    ...(base || {}),
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
    updatedAt: addedAt || (base ? base.updatedAt : ""),
    metadata: {
      ...((base && base.metadata) || {}),
      ...metadata,
      group_key: group,
      note,
      passwordSource: "NewStaff",
      passwordSourceTable: tableName,
      newStaffTable: tableName,
      newStaffAddedAt: addedAt,
      sourcePriority: "NewStaff"
    },
    source: "supabase-newstaff"
  };
}

async function getQuickLoginStaff(env: Env, appEnv: AppEnvName) {
  const tableName = getStaffTable(env);
  const newStaffTableName = getQuickLoginNewStaffTable();
  /* StaffMaster 也不從 KV 回傳；保留 appEnv 只作診斷。 */
  void appEnv;

  let latestNewStaffByEmp: Record<string, StaffMasterRow> = {};
  let newStaffError = "";

  // 2026-07-17（加速）：StaffMaster 與 NewStaff 兩個查詢互相獨立，原本是
  // 序列 await（撈完 StaffMaster 才撈 NewStaff），改成 Promise.all 並行，
  // 省掉一個查詢的往返（實測 quick-login-staff task ~2s 主要就是這兩個序列
  // Supabase 查詢）。NewStaff 失敗不影響主名單，catch 後留空覆蓋（行為不變）。
  const [rows, newStaffResult] = await Promise.all([
    supabaseGet<StaffMasterRow[]>(env, `${encodeURIComponent(tableName)}?select=*`),
    getLatestNewStaffByEmp(env).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })
    )
  ]);
  if (newStaffResult.ok) {
    latestNewStaffByEmp = newStaffResult.value;
  } else {
    newStaffError = newStaffResult.error;
  }

  const staffPeople = rows.map((row) => toQuickLoginPerson(row, tableName));
  const staffByEmp = new Map<string, QuickLoginPerson>();
  const newStaffEmpList = Object.keys(latestNewStaffByEmp);
  let newStaffOverrideCount = 0;

  // 員編大小寫視為同一個帳號，這裡的 key 跟 getLatestNewStaffByEmp() 的 dedup key
  // 用同一套「一律轉大寫」規則，兩邊 key 才對得起來。
  for (const person of staffPeople) {
    if (person.emp) staffByEmp.set(String(person.emp).toUpperCase(), person);
  }

  const staffList = staffPeople
    .map((person) => {
      const newStaffRow = person.emp ? latestNewStaffByEmp[String(person.emp).toUpperCase()] : null;
      if (!newStaffRow) return person;
      newStaffOverrideCount += 1;
      return mergeNewStaffIntoQuickLoginPerson(person, newStaffRow, newStaffTableName);
    })
    .filter((person) => person.active && person.allowQuickLogin && person.name && person.emp)
    .sort((a, b) => {
      const orderDiff = Number(a.sortOrder || 999) - Number(b.sortOrder || 999);
      if (orderDiff !== 0) return orderDiff;
      return String(a.emp || "").localeCompare(String(b.emp || ""));
    });
  const newStaffIgnoredCount = newStaffEmpList.filter((emp) => !staffByEmp.has(emp)).length;
  const extraList: QuickLoginPerson[] = [];

  const payload = {
    ok: true,
    action: "getQuickLoginStaff",
    source: "skhps-backend-supabase",
    env: appEnv,
    staffTable: tableName,
    newStaffTable: newStaffTableName,
    newStaffLatestCount: newStaffEmpList.length,
    newStaffOverrideCount,
    newStaffIgnoredCount,
    newStaffError,
    passwordFallbackTable: newStaffTableName,
    passwordFallbackCount: newStaffOverrideCount,
    passwordFallbackError: newStaffError,
    count: staffList.length,
    cachedAt: new Date().toISOString(),
    staffList,
    extraList
  };


  return payload;
}

async function findQuickLoginNewStaffRowsByEmpAndPassword(env: Env, emp: string, password: string): Promise<StaffMasterRow[]> {
  const tableName = getQuickLoginNewStaffTable();
  const empColumn = encodeURIComponent("員工編號");
  const passwordColumn = encodeURIComponent("密碼");
  /*
   * 員編大小寫視為同一個帳號：DB 欄位本身沒有 case-folded 的 unique index，
   * 舊資料也可能已經存在大小寫不一致的重複列，用 eq. 精確比對會漏掉這些既有
   * 資料。改用 ilike（不區分大小寫），並轉義 % / _ 這兩個 LIKE 萬用字元，
   * 避免員編剛好含有這兩個字元時被誤判成 pattern。
   */
  const empPattern = emp.replace(/[%_]/g, (match) => "\\" + match);

  return await supabaseGet<StaffMasterRow[]>(
    env,
    `${encodeURIComponent(tableName)}?${empColumn}=ilike.${encodeURIComponent(empPattern)}&${passwordColumn}=eq.${encodeURIComponent(password)}&select=*`
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
  // 統一存成大寫，新資料才會慢慢收斂成同一種大小寫，減少未來還要靠 ilike 兜底的情況。
  const emp = firstText(payload.emp, payload.account, payload.employeeId, payload.employee_id, payload["員工編號"]).toUpperCase();
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
  if (!password) {
    return {
      ok: false,
      action: "recordQuickLoginNewStaff",
      source: "skhps-backend-supabase",
      error: "MISSING_PASSWORD",
      message: "密碼必填"
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
  host_record_id: string | null;
  recorder_record_id: string | null;
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
  version_no: string;
  supersedes_id: string | null;
  qr_origin_id: string | null;
  chain_id: string;
  created_at: string;
  updated_at: string;
};

type QrSigninAuditRow = {
  id: string;
  record_id: string | null;
  meeting_id: string | null;
  action: string;
  actor_name: string | null;
  actor_employee_id: string | null;
  note: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
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

// 2026-07-17：ICS 私人 feed 對「重複事件」只給一筆母事件＋RRULE，不展開成
// 每一次；原本的解析只讀母事件那一天，會漏掉窗口內其他發生（例如每月 10 號
// 的「預班截止」）。以下實作把 RRULE 展開成窗口內的每一次，跟 GAS(CalendarApp)
// 的原生展開對齊，做到「一場不少」。
interface IcsRRule {
  freq: string;
  interval: number;
  until: Date | null;
  count: number;
  byMonthDay: number[];
  byDay: string[];
}

function parseIcsRRule(raw: string): IcsRRule | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const map: Record<string, string> = {};
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) map[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  if (!map.FREQ) return null;
  return {
    freq: map.FREQ.toUpperCase(),
    interval: Math.max(1, parseInt(map.INTERVAL || "1", 10) || 1),
    until: map.UNTIL ? parseIcsDate(map.UNTIL) : null,
    count: map.COUNT ? Math.max(0, parseInt(map.COUNT, 10) || 0) : 0,
    byMonthDay: (map.BYMONTHDAY || "").split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)),
    byDay: (map.BYDAY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  };
}

function icsWeekdayNum(day: string): number | null {
  const key = String(day || "").replace(/^[+-]?\d+/, "").trim().toUpperCase();
  const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return key in map ? map[key] : null;
}

function readIcsExDates(block: string): number[] {
  const out: number[] = [];
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon).toUpperCase();
    if (left === "EXDATE" || left.startsWith("EXDATE;")) {
      for (const v of line.slice(colon + 1).split(",")) {
        const d = parseIcsDate(v.trim());
        if (d) out.push(d.getTime());
      }
    }
  }
  return out;
}

// 把一個重複事件展開成 [windowStart, windowEnd] 內的每一次發生。emitted 從
// DTSTART 起算（給 COUNT 用），只收窗口內、非 EXDATE、UNTIL 之前的。HARD_CAP
// 防呆避免無限迴圈。
function expandIcsOccurrences(
  start: Date, end: Date, rrule: IcsRRule, exdates: number[],
  windowStart: Date, windowEnd: Date
): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const durationMs = Math.max(0, end.getTime() - start.getTime());
  const untilMs = rrule.until ? rrule.until.getTime() : Infinity;
  const wStart = windowStart.getTime();
  const wEnd = windowEnd.getTime();
  const exSet = new Set(exdates);
  const hh = start.getHours(), mm = start.getMinutes(), ss = start.getSeconds();
  const interval = rrule.interval;
  const HARD_CAP = 2000;
  let emitted = 0;
  let stopped = false;

  function take(d: Date): void {
    const t = d.getTime();
    if (!Number.isFinite(t)) return;
    if (t < start.getTime()) return;
    if (t > untilMs) { stopped = true; return; }
    if (rrule.count && emitted >= rrule.count) { stopped = true; return; }
    emitted += 1;
    if (t >= wStart && t <= wEnd && !exSet.has(t)) {
      out.push({ start: new Date(t), end: new Date(t + durationMs) });
    }
  }

  if (rrule.freq === "DAILY") {
    let d = new Date(start.getTime());
    for (let i = 0; i < HARD_CAP && !stopped; i++) {
      take(d);
      if (d.getTime() > wEnd) break;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + interval, hh, mm, ss);
    }
  } else if (rrule.freq === "YEARLY") {
    let d = new Date(start.getTime());
    for (let i = 0; i < HARD_CAP && !stopped; i++) {
      take(d);
      if (d.getTime() > wEnd) break;
      d = new Date(d.getFullYear() + interval, d.getMonth(), d.getDate(), hh, mm, ss);
    }
  } else if (rrule.freq === "WEEKLY") {
    const dows = (rrule.byDay.length
      ? rrule.byDay.map(icsWeekdayNum).filter((n): n is number => n !== null)
      : [start.getDay()]).sort((a, b) => a - b);
    let weekStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay(), hh, mm, ss);
    for (let w = 0; w < HARD_CAP && !stopped; w++) {
      for (const dow of dows) {
        take(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dow, hh, mm, ss));
        if (stopped) break;
      }
      if (weekStart.getTime() > wEnd) break;
      weekStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7 * interval, hh, mm, ss);
    }
  } else if (rrule.freq === "MONTHLY") {
    const doms = (rrule.byMonthDay.length ? rrule.byMonthDay : [start.getDate()]).slice().sort((a, b) => a - b);
    let y = start.getFullYear(), mo = start.getMonth();
    for (let i = 0; i < HARD_CAP && !stopped; i++) {
      for (const dom of doms) {
        const d = new Date(y, mo, dom, hh, mm, ss);
        if (d.getMonth() === (((mo % 12) + 12) % 12)) take(d); // 略過該月沒有的日（如 2/30）
        if (stopped) break;
      }
      if (new Date(y, mo, 1).getTime() > wEnd) break;
      mo += interval;
      while (mo >= 12) { mo -= 12; y += 1; }
    }
  } else {
    take(new Date(start.getTime()));
  }
  return out;
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

  const rows: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const title = decodeIcsText(readIcsProperty(block, "SUMMARY"));
    const uid = decodeIcsText(readIcsProperty(block, "UID"));
    const start = parseIcsDate(readIcsProperty(block, "DTSTART"));
    const end = parseIcsDate(readIcsProperty(block, "DTEND"));
    if (!title || !start || !end) continue;

    const rrule = parseIcsRRule(readIcsProperty(block, "RRULE"));
    if (!rrule) {
      // 單場事件：跟原本一樣，只留窗口內的。
      if (start.getTime() < first.getTime() || start.getTime() > last.getTime()) continue;
      rows.push(toQrSigninMeetingRowFromDates({
        envName, title, start, end,
        source: "google-calendar-ics",
        sourceId: uid || undefined,
        calendarId,
        metadata: { rawSource: "ics" }
      }));
      continue;
    }

    // 週期性事件：展開窗口內的每一次（例如每月 10 號的「預班截止」），
    // sourceId 帶上該次的時間戳確保各場唯一、不會被去重合併掉。
    const exdates = readIcsExDates(block);
    for (const occ of expandIcsOccurrences(start, end, rrule, exdates, first, last)) {
      rows.push(toQrSigninMeetingRowFromDates({
        envName, title, start: occ.start, end: occ.end,
        source: "google-calendar-ics",
        sourceId: uid ? `${uid}__${occ.start.getTime()}` : undefined,
        calendarId,
        metadata: { rawSource: "ics", recurrence: true }
      }));
    }
  }
  return rows;
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
  const singleSelects: Record<string, string> = {};
  if (row.host_record_id) singleSelects.host = row.host_record_id;
  if (row.recorder_record_id) singleSelects.recorder = row.recorder_record_id;

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
    enabled: row.enabled,
    updatedAt: row.updated_at || "",
    metadata: row.metadata || {},
    hostRecordId: row.host_record_id || "",
    recorderRecordId: row.recorder_record_id || "",
    selectionState: {
      singleSelects,
      multiSelects: {}
    }
  };
}

async function listQrSigninMeetingRows(env: Env, appEnv: AppEnvName, limit = 200): Promise<QrSigninMeetingRow[]> {
  const table = getQrSigninMeetingTable(env);
  const rows = await supabaseGet<QrSigninMeetingRow[]>(
    env,
    `${encodeURIComponent(table)}?select=*&env=eq.${encodeURIComponent(appEnv)}&enabled=eq.true&status=eq.active&order=starts_at.desc.nullslast&limit=${limit}`
  );
  
  // 返回所有符合 enabled 和 status 條件的會議，不過濾時間
  return rows.filter((row) => {
    if (!row.starts_at) return true; // 沒有開始時間的會議保留
    const startsAt = Date.parse(row.starts_at);
    return Number.isFinite(startsAt); // 只保留有效的時間戳
  });
}

async function countQrSigninRecordsByMeeting(env: Env, meetingId: string, appEnv?: AppEnvName): Promise<number> {
  const table = getQrSigninRecordTable(env);
  let path = `${encodeURIComponent(table)}?select=count&meeting_id=eq.${encodeURIComponent(meetingId)}&status=not.in.(void,duplicate,error)`;
  if (appEnv) {
    path += `&env=eq.${encodeURIComponent(appEnv)}`;
  }
  const rows = await supabaseGet<Array<{ count: string }>>(env, path);
  
  const countHeader = rows.length > 0 ? rows[0].count : "0";
  return parseInt(String(countHeader || "0"), 10);
}

// 2026-07-17（加速）：取代「每場會議各發一個 count 查詢」的 N+1（會議多時
// 是幾十~上百個並行 Supabase 查詢，實測 getQrSigninMeetings ~5.9s）。改成
// 一個查詢撈出這個 env 底下所有「有效簽到記錄」的 meeting_id（只取 meeting_id
// 欄、分頁），在 worker 端 group 計數。語意跟 countQrSigninRecordsByMeeting
// 完全一致（同一張 QrSigninRecord 表、同一個 status not-in(void,duplicate,error)
// 篩選＋env 篩選），只是把 N 次往返併成一次。
async function countQrSigninRecordsByMeetings(env: Env, appEnv: AppEnvName): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const table = getQrSigninRecordTable(env);
  const path = `${encodeURIComponent(table)}?select=meeting_id&status=not.in.(void,duplicate,error)&env=eq.${encodeURIComponent(appEnv)}`;
  const rows = await supabaseGetAllRows(env, path);
  for (const row of rows) {
    const id = String((row as { meeting_id?: unknown }).meeting_id || "");
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
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

  // 2026-07-17（加速）：原本對每場會議各發一個 count 查詢（N+1，會議多就是
  // 幾十~上百個並行 Supabase 查詢 → ~5.9s）。改成一次撈全部再 worker 端 group
  // 計數（見 countQrSigninRecordsByMeetings），數字語意完全不變。
  const countByMeeting = await countQrSigninRecordsByMeetings(env, appEnv).catch(() => new Map<string, number>());
  const meetingsWithCounts = rows.map((row) => {
    const display = qrSigninMeetingDisplay(row);
    return {
      ...display,
      signinRecordCount: countByMeeting.get(String(row.id)) || 0
    };
  });

  return {
    ok: true,
    action: "getQrSigninMeetings",
    source: syncSource,
    table: getQrSigninMeetingTable(env),
    count: meetingsWithCounts.length,
    data: {
      ok: true,
      meetings: meetingsWithCounts,
      source: syncSource,
      syncError
    },
    meetings: meetingsWithCounts,
    diagnostics: {
      syncSource,
      syncError,
      hasAppsScriptFallback: !!env.QR_SIGNIN_APPS_SCRIPT_URL,
      calendarId: getQrSigninCalendarId(env)
    }
  };
}

/*
 * 純預覽用：解析 ICS / Apps Script 回傳的日曆事件，但完全不呼叫
 * saveQrSigninMeetingRows，不會在 QrSigninMeeting 產生任何 DB row。
 * 之後前端要不要把某一場「變成真的會議」，走既有的 lazy-create 路徑
 * （後台 resolveMeetingId 按新增人員／前台 submitQrSignin 真的有人簽到），
 * 不是每次列清單就順手幫每個日曆事件都建一筆——避免大量從沒人簽到過的
 * 空會議塞滿 QrSigninMeeting。
 */
async function previewQrSigninCalendarMeetings(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  // 2026-07-17：lookbackDays 參數化。**預設 0（＝原本後台「只預覽未來」的行為
  // 不變）**；前台若傳 lookbackDays（例如 45）就能拿到過去+未來的完整窗口。
  // lookaheadDays 沿用原本的 env 預設（45）。
  const lookbackDays = qrNumberFromEnv(payload.lookbackDays, 0);
  const lookaheadDays = qrNumberFromEnv(payload.lookaheadDays, qrNumberFromEnv(env.QR_SIGNIN_CALENDAR_LOOKAHEAD_DAYS, DEFAULT_QR_SIGNIN_LOOKAHEAD_DAYS));

  // 2026-07-17（加速）：日曆讀取（ICS/AppsScript）是這支最慢的部分。加 KV
  // 邊緣快取——全 env 共用、日曆變動不頻繁，快取 120 秒；不同窗口分開 key。
  // 傳 forceRefresh/noCache 可略過。
  const cacheKey = `qr-cal-preview:${appEnv}:${lookbackDays}:${lookaheadDays}`;
  const bypassCache = booleanFromUnknown(payload.forceRefresh) || booleanFromUnknown(payload.noCache);
  if (!bypassCache && env.SKHPS_CACHE) {
    try {
      const cached = await env.SKHPS_CACHE.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cache = "hit";
        return parsed;
      }
    } catch { /* 快取讀失敗就當 miss，繼續正常讀 */ }
  }

  let rows: Record<string, unknown>[] = [];
  let source = "";
  let syncError = "";

  try {
    const icsUrl = getQrSigninCalendarIcsUrl(env);
    if (!icsUrl) throw new Error("QR_SIGNIN_CALENDAR_ICS_URL_MISSING");
    const response = await fetch(icsUrl, { method: "GET" });
    const text = await response.text();
    if (!response.ok) throw new Error(`QR_SIGNIN_ICS_FETCH_FAILED ${response.status} ${text.slice(0, 200)}`);
    rows = parseQrSigninIcsRows(text, env, { ...payload, env: appEnv, lookbackDays, lookaheadDays });
    source = "google-calendar-ics";
  } catch (icsError) {
    try {
      const fallback = await callQrSigninAppsScriptFallback(env, "getQrSigninMeetings", { ...payload, env: appEnv }) as any;
      const data = fallback && fallback.data ? fallback.data : fallback;
      const meetings = data && Array.isArray(data.meetings) ? data.meetings : [];
      const nowMs = Date.now();
      const lookaheadLimitMs = nowMs + lookaheadDays * 86400000;
      const lookbackLimitMs = nowMs - lookbackDays * 86400000;
      rows = meetings
        .map((meeting: any) => toQrSigninMeetingRowFromLegacy({
          envName: appEnv,
          course: meeting.course || meeting.title,
          date: meeting.date || meeting.time || meeting.timeLabel,
          source: "apps-script-calendar",
          sourceId: firstText(meeting.calendarEventId, meeting.sourceId, meeting.id, meeting.eventId, meeting.uid),
          metadata: { rawSource: "apps-script", rawMeeting: meeting }
        }))
        // Apps Script 舊端點回傳全部歷史場次；跟 ICS 路徑一致，用 lookback~lookahead
        // 窗口過濾（預設 lookback=0 就等於原本「只留未來場次」的行為）。
        .filter((row: Record<string, unknown>) => {
          const startsAt = row.starts_at ? Date.parse(String(row.starts_at)) : NaN;
          return Number.isFinite(startsAt) && startsAt >= lookbackLimitMs && startsAt <= lookaheadLimitMs;
        });
      source = "apps-script-calendar";
      syncError = icsError instanceof Error ? icsError.message : String(icsError);
    } catch (fallbackError) {
      syncError = [icsError, fallbackError].map((error) => error instanceof Error ? error.message : String(error)).filter(Boolean).join(" | ");
    }
  }

  const meetings = rows.map((row) => qrSigninCalendarPreviewDisplay(row));

  const result = {
    ok: true,
    action: "previewQrSigninCalendarMeetings",
    source,
    count: meetings.length,
    data: { ok: true, meetings, source, syncError },
    meetings,
    cache: "miss"
  };

  // 只快取成功的 ICS 讀取（fallback/錯誤不快取，免得把壞結果卡住 120 秒）。
  if (env.SKHPS_CACHE && source === "google-calendar-ics" && meetings.length > 0) {
    try {
      await env.SKHPS_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 120 });
    } catch { /* 快取寫失敗不影響回應 */ }
  }

  return result;
}

function qrSigninCalendarPreviewDisplay(row: Record<string, unknown>): Record<string, unknown> {
  const startsAt = String(row.starts_at || "");
  const endsAt = String(row.ends_at || "");
  const start = startsAt ? new Date(startsAt) : null;
  const datePrefix = start && Number.isFinite(start.getTime()) ? formatTaipeiDate(start, "M/d") : String(row.meeting_date || "");
  const title = String(row.title || "");
  const course = datePrefix ? `${datePrefix} ${title}` : title;

  return {
    id: "",
    meetingId: "",
    course,
    date: row.time_label || "",
    title,
    meetingDate: row.meeting_date || "",
    timeLabel: row.time_label || "",
    startTime: startsAt,
    endTime: endsAt,
    isRunning: false,
    selected: false,
    source: row.source || "",
    sourceId: row.source_id || "",
    calendarEventId: row.source_id || "",
    calendarId: row.calendar_id || "",
    status: row.status || "active",
    enabled: row.enabled !== false,
    updatedAt: "",
    metadata: row.metadata || {},
    hostRecordId: "",
    recorderRecordId: "",
    signinRecordCount: 0,
    selectionState: { singleSelects: {}, multiSelects: {} }
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
    sourceId: firstText(payload.sourceId) || undefined
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

function normalizeSwipeSelectionPayload(input: unknown): {
  singleSelects: Record<string, string>;
} {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const singleSource = source.singleSelects && typeof source.singleSelects === "object"
    ? source.singleSelects as Record<string, unknown>
    : {};
  const singleSelects: Record<string, string> = {};

  Object.keys(singleSource).forEach((key) => {
    const cleanKey = String(key || "").trim();
    const rowId = firstText(singleSource[key]);
    if (cleanKey && rowId) singleSelects[cleanKey] = rowId;
  });

  return { singleSelects };
}

async function findQrSigninRecordInMeeting(env: Env, meetingId: string, recordId: string, appEnv: AppEnvName): Promise<QrSigninRecordRow | null> {
  if (!meetingId || !recordId) return null;
  const table = getQrSigninRecordTable(env);
  const rows = await supabaseGet<QrSigninRecordRow[]>(
    env,
    `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(recordId)}&meeting_id=eq.${encodeURIComponent(meetingId)}&env=eq.${encodeURIComponent(appEnv)}&limit=1`
  );
  return rows[0] || null;
}

async function updateQrSigninMeetingSelection(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getQrSigninMeetingTable(env);
  const meetingId = firstText(payload.meetingId, payload.id);
  const appEnv = normalizeEnv(firstText(payload.env, payload.appEnv));
  if (!meetingId) return { ok: false, action: "updateQrSigninMeetingSelection", error: "MISSING_MEETING_ID" };

  const before = await findQrSigninMeetingRow(env, meetingId);
  if (!before) return { ok: false, action: "updateQrSigninMeetingSelection", error: "MEETING_NOT_FOUND", meetingId };

  const requestedSelection = normalizeSwipeSelectionPayload(payload.selectionState || payload.swipeTableSelection || {});

  /*
   * 只 PATCH 這個請求「明講」的 key：selectionState 有值、或 clearSingleSelects 點名清空。
   * 禁止拿 before 的舊值回填沒提到的 key 再整包寫回——前端一次編輯儲存若同時動到
   * 主持人＋紀錄者，會各發一個請求並發進來，read-merge-write 會把另一個請求剛清掉的
   * 欄位用讀到的舊值寫回（結果主持人、紀錄者兩個都打勾）。沒提到的 key 一律不碰，
   * 兩個並發請求寫的欄位彼此不相交，落地順序就不影響最終結果。
   */
  const clearedKeys = new Set<string>();
  if (payload.clearSingleSelects && Array.isArray(payload.clearSingleSelects)) {
    payload.clearSingleSelects.forEach((key) => {
      const cleanKey = String(key || "").trim();
      if (cleanKey === "host" || cleanKey === "recorder") clearedKeys.add(cleanKey);
    });
  }

  const requestedHostRecordId = clearedKeys.has("host") ? "" : firstText(requestedSelection.singleSelects.host);
  const requestedRecorderRecordId = clearedKeys.has("recorder") ? "" : firstText(requestedSelection.singleSelects.recorder);
  const touchesHost = clearedKeys.has("host") || Boolean(requestedHostRecordId);
  const touchesRecorder = clearedKeys.has("recorder") || Boolean(requestedRecorderRecordId);

  let hostRecord: QrSigninRecordRow | null = null;
  let recorderRecord: QrSigninRecordRow | null = null;

  if (requestedHostRecordId) {
    hostRecord = await findQrSigninRecordInMeeting(env, meetingId, requestedHostRecordId, appEnv).catch(() => null);
    if (!hostRecord) {
      return { ok: false, action: "updateQrSigninMeetingSelection", error: "HOST_RECORD_NOT_IN_MEETING", meetingId, recordId: requestedHostRecordId };
    }
  }

  if (requestedRecorderRecordId) {
    recorderRecord = requestedRecorderRecordId === requestedHostRecordId
      ? hostRecord
      : await findQrSigninRecordInMeeting(env, meetingId, requestedRecorderRecordId, appEnv).catch(() => null);
    if (!recorderRecord) {
      return { ok: false, action: "updateQrSigninMeetingSelection", error: "RECORDER_RECORD_NOT_IN_MEETING", meetingId, recordId: requestedRecorderRecordId };
    }
  }

  /*
   * 設主持人/紀錄者也算一次編輯，所以先幫被選中的那筆 INSERT 新版本（source 改為
   * "admin"），meeting 要寫入的 host_record_id/recorder_record_id 用「新版本的 id」，
   * 不是 request 裡的舊 id——這樣 QrSigninRecordCurrent（version_no 最大值）查到的
   * 才會是新版本，新版本才是真正代表這個人的那一筆。主持人跟紀錄者剛好是同一筆時
   * 只版本化一次，兩個欄位共用同一個新 id。
   */
  const actorName = firstText(payload.updatedBy, payload.actorName);
  const actorEmployeeId = firstText(payload.actorEmployeeId);
  let newHostId = "";
  let newRecorderId = "";

  if (hostRecord) {
    const versioned = await createQrSigninRecordVersion(env, hostRecord, { source: "admin" }, "set-host", { actorName, actorEmployeeId });
    newHostId = versioned.saved.id;
    if (recorderRecord && recorderRecord.id === hostRecord.id) newRecorderId = newHostId;
  }
  if (recorderRecord && !newRecorderId) {
    const versioned = await createQrSigninRecordVersion(env, recorderRecord, { source: "admin" }, "set-recorder", { actorName, actorEmployeeId });
    newRecorderId = versioned.saved.id;
  }

  const patch: Record<string, unknown> = {
    updated_by: firstText(payload.updatedBy, payload.actorName, payload.actorEmployeeId) || before.updated_by || null
  };
  if (touchesHost) {
    patch.host_record_id = newHostId || null;
  }
  if (touchesRecorder) {
    patch.recorder_record_id = newRecorderId || null;
  }

  const updated = await supabasePatch<QrSigninMeetingRow[]>(env, table, `id=eq.${encodeURIComponent(meetingId)}`, patch);
  const saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...before, ...patch } as QrSigninMeetingRow;
  const meeting = qrSigninMeetingDisplay(saved);

  // 回應的 selectionState 以 PATCH 後 DB 實際存的值為準，不是用請求內容拼出來的。
  const nextSelection = {
    singleSelects: {
      host: saved.host_record_id || "",
      recorder: saved.recorder_record_id || ""
    },
    multiSelects: {}
  };

  return {
    ok: true,
    action: "updateQrSigninMeetingSelection",
    source: "skhps-backend-supabase",
    table,
    meetingId,
    selectionState: nextSelection,
    data: { ok: true, meeting, selectionState: nextSelection },
    meeting
  };
}

/*
 * 簽到單 PDF 的「會議資訊」欄位（科別/主題/地點/日期/時間/主持人/紀錄/會議性質）
 * 存進 QrSigninMeeting 既有的 metadata JSONB 欄位裡（metadata.pdfFields），
 * 不新增資料表、不新增正式欄位——照 [[project_qr_signin_pdf_header_fields_editable_todo]]
 * 那份筆記原本規劃的方向做。這裡刻意跟「主題/日期/時間/主持人/紀錄」這些
 * 行事曆同步用的既有欄位（title/meeting_date/starts_at/ends_at/host_record_id/
 * recorder_record_id）分開存，不寫回那些欄位——避免下次行事曆同步時被覆蓋掉，
 * 也避免這次「會議資訊」編輯不小心動到行事曆同步的資料來源。
 */
function getAppDefaultTable(env: Env): string {
  return String(env.APP_DEFAULT_TABLE || DEFAULT_APP_DEFAULT_TABLE).trim() || DEFAULT_APP_DEFAULT_TABLE;
}

/*
 * 通用「預設值」key-value 表：用 scope 區分不同畫面/App（例如 qrSignin），
 * 不綁死單一業務。只存目前值，改掉就覆蓋，不做歷史紀錄。
 */
async function getAppDefaults(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getAppDefaultTable(env);
  const scope = firstText(payload.scope);
  if (!scope) return { ok: false, action: "getAppDefaults", error: "MISSING_SCOPE" };

  const rows = await supabaseGet<Array<{ key: string; value: string }>>(
    env,
    `${table}?select=key,value&scope=eq.${encodeURIComponent(scope)}`
  );

  const defaults: Record<string, string> = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    defaults[row.key] = row.value || "";
  });

  return { ok: true, action: "getAppDefaults", source: "skhps-backend-supabase", table, scope, defaults };
}

async function saveAppDefaults(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getAppDefaultTable(env);
  const scope = firstText(payload.scope);
  if (!scope) return { ok: false, action: "saveAppDefaults", error: "MISSING_SCOPE" };

  const input = isPlainObject(payload.defaults) ? payload.defaults : {};
  const records = Object.keys(input).map((key) => ({
    scope,
    key,
    value: firstText(input[key])
  }));

  if (!records.length) return { ok: false, action: "saveAppDefaults", error: "MISSING_DEFAULTS" };

  await supabaseUpsert(env, table, records, "scope,key");

  const defaults: Record<string, string> = {};
  records.forEach((record) => { defaults[record.key] = record.value; });

  return { ok: true, action: "saveAppDefaults", source: "skhps-backend-supabase", table, scope, defaults };
}

async function updateQrSigninMeetingPdfFields(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getQrSigninMeetingTable(env);
  const meetingId = firstText(payload.meetingId, payload.id);
  if (!meetingId) return { ok: false, action: "updateQrSigninMeetingPdfFields", error: "MISSING_MEETING_ID" };

  const before = await findQrSigninMeetingRow(env, meetingId);
  if (!before) return { ok: false, action: "updateQrSigninMeetingPdfFields", error: "MEETING_NOT_FOUND", meetingId };

  // hostName/recorderName 存的是「意圖」（希望是誰、但不一定已經真的指派
  // 成功——那個人可能還沒簽到），不是目前真正的主持人/紀錄；真正的值一律是
  // QrSigninMeeting.selectionState（updateQrSigninMeetingSelection 那條路徑）。
  const input = isPlainObject(payload.pdfFields) ? payload.pdfFields : {};
  const pdfFields = {
    departmentName: firstText(input.departmentName),
    topic: firstText(input.topic),
    location: firstText(input.location),
    meetingDate: firstText(input.meetingDate),
    timeStart: firstText(input.timeStart),
    timeEnd: firstText(input.timeEnd),
    hostName: firstText(input.hostName),
    recorderName: firstText(input.recorderName),
    meetingType: firstText(input.meetingType)
  };

  const existingMetadata = isPlainObject(before.metadata) ? before.metadata : {};
  const nextMetadata = { ...existingMetadata, pdfFields };

  const updated = await supabasePatch<QrSigninMeetingRow[]>(env, table, `id=eq.${encodeURIComponent(meetingId)}`, { metadata: nextMetadata });
  const saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...before, metadata: nextMetadata } as QrSigninMeetingRow;

  return {
    ok: true,
    action: "updateQrSigninMeetingPdfFields",
    source: "skhps-backend-supabase",
    table,
    meetingId,
    pdfFields,
    meeting: qrSigninMeetingDisplay(saved)
  };
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

function qrRecordDataText(source: Record<string, unknown> | QrSigninRecordRow | null | undefined, snakeKey: string, camelKey?: string): string {
  if (!source) return "";
  return firstText((source as Record<string, unknown>)[snakeKey], camelKey ? (source as Record<string, unknown>)[camelKey] : undefined);
}

function qrRecordTextComparable(value: unknown): string {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ");
}

function qrRecordStatusComparable(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "success" || raw === "signed" || raw === "manual" || raw === "duplicate" || raw === "已簽到") return "signed";
  if (raw === "outside_window" || raw === "outside-window" || raw === "late" || raw === "closed" || raw === "逾時" || raw === "未於時限內簽到") return "outside_window";
  if (raw === "leave" || raw === "請假") return "leave";
  if (raw === "absent" || raw === "failed" || raw === "failure" || raw === "error" || raw === "未簽到") return "absent";
  if (raw === "void" || raw === "deleted" || raw === "archived" || raw === "作廢") return "void";
  return raw;
}

function qrRecordSignedMinuteComparable(value: unknown): string {
  const text = firstText(value);
  let match: RegExpMatchArray | null;
  let date: Date;

  if (!text) return "";

  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2})/);
  if (match && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return [match[1], String(match[2]).padStart(2, "0"), String(match[3]).padStart(2, "0")].join("-") +
      " " + [String(match[4]).padStart(2, "0"), match[5]].join(":");
  }

  date = new Date(text);
  if (Number.isNaN(date.getTime()) && text.indexOf(" ") > -1) {
    date = new Date(text.replace(" ", "T"));
  }
  if (!Number.isNaN(date.getTime())) {
    return `${formatTaipeiDate(date, "Y-M-D")} ${formatTaipeiDate(date, "H:mm")}`;
  }

  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (match) {
    return [match[1], String(match[2]).padStart(2, "0"), String(match[3]).padStart(2, "0")].join("-") +
      " " + [String(match[4]).padStart(2, "0"), match[5]].join(":");
  }

  return qrRecordTextComparable(text);
}

function normalizeQrSigninAdminSignedAt(value: unknown): string {
  const text = firstText(value);
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);

  if (!text) return "";

  /*
   * 後台編輯畫面送來的是台北時間。若沒有明確時區，必須補 +08:00，不能讓
   * Supabase / PostgreSQL 或 JS Date 用 UTC/本機預設自行解讀，否則同一筆資料
   * 每儲存一次就可能被位移 8 小時。
   */
  if (match && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return [match[1], String(match[2]).padStart(2, "0"), String(match[3]).padStart(2, "0")].join("-") +
      "T" + [String(match[4]).padStart(2, "0"), match[5], match[6] || "00"].join(":") +
      "+08:00";
  }

  return text;
}

function qrRecordComparable(source: Record<string, unknown> | QrSigninRecordRow | null | undefined): Record<string, string> {
  const signedAt = qrRecordDataText(source, "signed_at", "recordedSignedAt") || qrRecordDataText(source, "signedAt");

  /*
   * 「是否修改」只比較使用者看得到／可編輯的 active content。
   * source、submitted_at、updated_at、note/reason 這類系統欄位不拿來當修改判斷，
   * 否則使用者把畫面欄位改回原值後，仍可能因秒數、後台時間或隱藏欄位不同而被誤判為已修改。
   */
  return {
    name: qrRecordTextComparable(qrRecordDataText(source, "name")),
    employee_id: qrRecordTextComparable(qrRecordDataText(source, "employee_id", "employeeId")),
    role: qrRecordTextComparable(qrRecordDataText(source, "role")),
    signed_at: qrRecordSignedMinuteComparable(signedAt),
    status: qrRecordStatusComparable(qrRecordDataText(source, "status"))
  };
}

function qrSigninRecordRoleFlags(row: QrSigninRecordRow, meeting?: QrSigninMeetingRow | null): { isHost: boolean; isRecorder: boolean } {
  const recordId = firstText(row && row.id);
  const hostRecordId = firstText(meeting && meeting.host_record_id);
  const recorderRecordId = firstText(meeting && meeting.recorder_record_id);
  return {
    isHost: Boolean(recordId && hostRecordId && hostRecordId === recordId),
    isRecorder: Boolean(recordId && recorderRecordId && recorderRecordId === recordId)
  };
}

function qrSigninRecordContentEditedFromOriginal(row: QrSigninRecordRow, original?: Record<string, unknown> | null): boolean {
  // 如果 source 是 "admin"，表示後台修改過，直接返回 true
  if (row.source === "admin") return true;
  
  if (!original) return row.source !== "qr";
  const current = qrRecordComparable(row);
  const base = qrRecordComparable(original);
  return Object.keys(current).some((key) => String(current[key] || "") !== String(base[key] || ""));
}

function qrSigninRecordEditedFromOriginal(row: QrSigninRecordRow, original?: Record<string, unknown> | null, meeting?: QrSigninMeetingRow | null): boolean {
  const roleFlags = qrSigninRecordRoleFlags(row, meeting || null);
  if (roleFlags.isHost || roleFlags.isRecorder) return true;
  return qrSigninRecordContentEditedFromOriginal(row, original || null);
}

function qrSigninOriginalSource(row: QrSigninRecordRow, original?: Record<string, unknown> | null, isEdited?: boolean): string {
  // 新邏輯：直接返回記錄中存儲的 source 值，不再根據 isEdited 改變
  // source 值已在寫入時根據與原始記錄的比對結果決定
  return firstText(row && row.source, "admin");
}

/*
 * 「QR 原始基準」= qr_origin_id 指向的那筆，不是這筆自己的 audit 快照——
 * 單純 PK 查，沒有 qr_origin_id（從沒有真正 QR 簽到過）就回 null。
 */
async function findQrSigninRecordQrOrigin(env: Env, row: QrSigninRecordRow | null | undefined): Promise<QrSigninRecordRow | null> {
  if (!row || !row.qr_origin_id) return null;
  if (row.qr_origin_id === row.id) return row;
  return findQrSigninRecordById(env, row.qr_origin_id);
}

function qrSigninResultFromRecord(row: QrSigninRecordRow, meeting?: QrSigninMeetingRow | null, original?: Record<string, unknown> | null): Record<string, unknown> {
  const display = meeting ? qrSigninMeetingDisplay(meeting) : {} as Record<string, unknown>;
  const status = qrSigninFrontendStatus(row);
  const reason = row.reason || qrSigninReasonText(row.status);
  const roleFlags = qrSigninRecordRoleFlags(row, meeting || null);
  const isContentEdited = qrSigninRecordContentEditedFromOriginal(row, original || null);
  const isEdited = roleFlags.isHost || roleFlags.isRecorder || isContentEdited;
  const sourceRaw = qrSigninOriginalSource(row, original || null, isEdited);
  const originalSubmittedAt = firstText(original && original.submitted_at, original && original.submittedAt, row.submitted_at);
  const roleUpdatedAt = (roleFlags.isHost || roleFlags.isRecorder) ? firstText(meeting && meeting.updated_at) : "";
  return {
    resultId: row.id,
    meetingId: row.meeting_id,
    /*
     * chainId：這條版本鏈從第一筆就決定、之後每次編輯都原封不動繼承的身分識別，
     * 跟 name/employeeId 這些「內容」完全脫鉤——內容可以被編輯（甚至改錯字），
     * 但 chainId 不會變。前端合併本地狀態（upsertLocalRecord）要用這個判斷
     * 「這是同一個人」，不能只靠 employeeId/name（那兩個本身就是可編輯的內容，
     * 編輯當下改掉的話會比對不到本地舊記錄，變成畫面上重複出現同一個人）。
     */
    chainId: row.chain_id,
    status,
    reason,
    meeting: firstText(display.title, display.course, "會議簽到"),
    date: firstText(display.meetingDate),
    time: firstText(display.timeLabel),
    name: row.name,
    employeeId: row.employee_id || "",
    role: row.role || "",
    // 只有真的簽到/補登才能用 submitted_at 頂替顯示時間；其他狀態 signed_at
    // 本來就該是空的，不能被 submitted_at（純粹是這筆記錄何時被送出/建立的
    // 行政時間戳）頂替掉，不然畫面「未簽到」還是會看起來有簽到時間。
    signedAt: (row.status === "signed" || row.status === "manual") ? (row.signed_at || row.submitted_at) : (row.signed_at || ""),
    submittedAt: row.submitted_at,
    frontendSubmittedAt: originalSubmittedAt,
    originalSubmittedAt,
    backendUpdatedAt: isEdited ? firstText(isContentEdited ? row.updated_at : "", roleUpdatedAt, row.updated_at) : "",
    updatedAt: row.updated_at,
    recordedSignedAt: row.signed_at || "",
    source: sourceRaw,
    sourceRaw,
    isContentEdited,
    isHost: roleFlags.isHost,
    isRecorder: roleFlags.isRecorder,
    hasBackendRoleState: roleFlags.isHost || roleFlags.isRecorder,
    isEdited,
    hasQrOrigin: Boolean(original),
    /*
     * 「兩包資料」的 package A：這個人這場會議最早一筆真正 QR 自行簽到的內容。
     * null 代表從沒有真正 QR 簽到過——前端「清除修改內容」的顯示條件必須以此為準，
     * 不能只看 source/isEdited（否則「後台先建、從沒有 QR 到來」的記錄也會顯示清除）。
     */
    qrOriginRecord: original
      ? {
          name: firstText(original.name),
          role: firstText(original.role),
          employeeId: firstText(original.employee_id, original.employeeId),
          signedAt: firstText(original.signed_at, original.recordedSignedAt, original.signedAt),
          status: firstText(original.status)
        }
      : null,
    message: status === "success" ? "簽到成功" : status === "duplicate" ? "你已經簽到過，不需要重複送出" : "簽到失敗"
  };
}

async function findQrSigninMeetingRow(env: Env, meetingId: string): Promise<QrSigninMeetingRow | null> {
  const table = getQrSigninMeetingTable(env);
  const rows = await supabaseGet<QrSigninMeetingRow[]>(env, `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(meetingId)}&limit=1`);
  return rows[0] || null;
}

/*
 * QrSigninRecordCurrent 是一個 view（distinct on meeting_id/employee_id/lower(name)
 * 取 version_no 最大值），取代原本的 is_current=eq.true 篩選——一人一場一筆是查詢
 * 時保證的，不再需要 DB 唯一索引強制，也就不會有「兩個請求搶著標 is_current」的
 * race condition。
 */
async function findCurrentQrSigninRecord(env: Env, input: { meetingId: string; employeeId: string; name: string }): Promise<QrSigninRecordRow | null> {
  const basePath = `${encodeURIComponent("QrSigninRecordCurrent")}?select=*&meeting_id=eq.${encodeURIComponent(input.meetingId)}&limit=1`;

  if (input.employeeId) {
    const byEmpRows = await supabaseGet<QrSigninRecordRow[]>(
      env,
      `${basePath}&employee_id=eq.${encodeURIComponent(input.employeeId)}`
    );
    if (byEmpRows[0]) return byEmpRows[0];

    // 員編比不到不能直接放棄——既有記錄本身的 employee_id 可能是空的
    // （例如前台手動打字沒選名冊送出的舊資料），姓名其實對得上，一定要
    // 退回比姓名，不然會漏判成「還沒簽到」而允許重複建立一筆新記錄。
    if (!input.name) return null;
    const byNameRows = await supabaseGet<QrSigninRecordRow[]>(
      env,
      `${basePath}&name=eq.${encodeURIComponent(input.name)}`
    );
    return byNameRows[0] || null;
  }

  const rows = await supabaseGet<QrSigninRecordRow[]>(env, `${basePath}&name=eq.${encodeURIComponent(input.name)}`);
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
      sourceId: firstText(payload.sourceId) || undefined
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
      metadata: {
        source: "submitQrSignin",
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
    /*
     * 這個人這場會議已經有一筆現存記錄。兩種情況：
     * - existing.source === 'qr'：這是同一個人自己先前的 QR 嘗試（例如逾時後重掃），
     *   維持現狀 UPDATE-in-place——這是同一個 QR 事件本身在完成，不是別人的編輯。
     * - existing.source !== 'qr'：後台先建立/補登過這個人（例如手動預先登記），
     *   現在才出現真正的 QR 自行簽到。這一刻起 QR 才是「主原始資料」，後台先前
     *   補的內容變成被取代的附加/補充版本，必須 INSERT 新版本（不是直接覆蓋），
     *   且這一筆新版本的 qr_origin_id 要指向自己（這條鏈第一次出現真正 QR）。
     */
    const isOwnQrRetry = existing.source === "qr";

    if (statusInfo.status === "signed") {
      const patch: Record<string, unknown> = {
        role,
        signed_at: signedAt,
        status: "signed",
        reason: null,
        source: "qr",
        client_request_id: clientRequestId || null
      };
      let saved: QrSigninRecordRow;
      if (isOwnQrRetry) {
        const updated = await supabasePatch<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(existing.id)}`, patch);
        saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...existing, ...patch } as QrSigninRecordRow;
        await insertQrSigninAudit(env, {
          record_id: saved.id || null,
          meeting_id: meetingId,
          action: "resolve-failed-signin",
          actor_name: name,
          actor_employee_id: employeeId || null,
          // 這個分支是 PATCH 蓋掉 existing（isOwnQrRetry，同一鏈原地更新，不走版本化），
          // before_data 是 existing 被覆蓋前唯一還留得住的快照，不能省；after_data
          // 拿掉是因為那就是 saved 現在這一列本身，Record 表已經有了。
          before_data: existing,
          metadata: { source: "submitQrSignin" }
        });
      } else {
        const versioned = await createQrSigninRecordVersion(env, existing, patch, "qr-signin-supersedes-admin", {
          actorName: name,
          actorEmployeeId: employeeId || null,
          selfIsQrOrigin: true
        });
        saved = versioned.saved;
      }
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
      source: "qr",
      client_request_id: clientRequestId || null
    };
    let saved: QrSigninRecordRow;
    if (isOwnQrRetry) {
      const updated = await supabasePatch<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(existing.id)}`, patch);
      saved = Array.isArray(updated) && updated[0] ? updated[0] : { ...existing, ...patch } as QrSigninRecordRow;
      await insertQrSigninAudit(env, {
        record_id: saved.id || null,
        meeting_id: meetingId,
        action: "repeated-failed-signin",
        actor_name: name,
        actor_employee_id: employeeId || null,
        // 同上：這個分支也是 PATCH 蓋掉 existing，before_data 是唯一存活快照，留著；
        // after_data 省略（就是 saved，Record 表本身已經有）。
        before_data: existing,
        metadata: {
          source: "submitQrSignin",
          attemptedStatus: statusInfo.status,
          attemptedReason: statusInfo.reason || ""
        }
      });
    } else {
      const versioned = await createQrSigninRecordVersion(env, existing, patch, "qr-signin-supersedes-admin", {
        actorName: name,
        actorEmployeeId: employeeId || null,
        selfIsQrOrigin: true,
        metadata: { attemptedStatus: statusInfo.status, attemptedReason: statusInfo.reason || "" }
      });
      saved = versioned.saved;
    }
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

  // 全新的人第一次簽到：這一筆本身就是 QR 原始基準也是新的一條版本鏈，chain_id 是
  // NOT NULL 欄位，必須在 INSERT 當下就給值——不能像舊寫法那樣先插入再事後 PATCH
  // 補 chain_id，那樣 INSERT 本身就會先被 NOT NULL 擋掉。
  const newRecordId = crypto.randomUUID();
  const record: Record<string, unknown> = {
    id: newRecordId,
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
    qr_origin_id: newRecordId,
    chain_id: newRecordId
  };

  const inserted = await supabasePost<QrSigninRecordRow[]>(env, table, record);
  let saved = Array.isArray(inserted) && inserted[0] ? inserted[0] : record as QrSigninRecordRow;
  await insertQrSigninAudit(env, {
    record_id: saved.id || null,
    meeting_id: meetingId,
    action: statusInfo.status === "signed" ? "qr-signin" : "failed-signin",
    actor_name: name,
    actor_employee_id: employeeId || null,
    // 這是全新一條鏈的第一筆，saved 本身就永久留在 Record 表，不用再存一份 after_data。
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
  const original = await findQrSigninRecordQrOrigin(env, rows[0]).catch(() => null);
  const result = qrSigninResultFromRecord(rows[0], meeting, original);
  return { ok: true, action: "getQrSigninResult", source: "skhps-backend-supabase", table, data: result, ...result };
}

async function listQrSigninRecords(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const limit = Math.min(Math.max(qrNumberFromEnv(payload.limit, 100), 1), 500);
  const meetingId = firstText(payload.meetingId);
  const table = getQrSigninRecordTable(env);
  // QrSigninRecordCurrent 一人一場一筆（version_no 最大值），不再需要「同人分組、
  // 保留最舊 QR + 最新 admin」的 client-side 拼裝——那套邏輯是舊「直接 UPDATE 覆蓋」
  // 設計遺留的權宜之計。
  let path = `${encodeURIComponent("QrSigninRecordCurrent")}?select=*&env=eq.${encodeURIComponent(appEnv)}&order=submitted_at.asc.nullslast,created_at.asc&limit=${limit}`;
  // 如果有指定 meetingId，就篩選該會議，否則查全部
  if (meetingId) path += `&meeting_id=eq.${encodeURIComponent(meetingId)}`;
  const rows = await supabaseGet<QrSigninRecordRow[]>(env, path);

  const meetingIds = Array.from(new Set(rows.map((row) => row.meeting_id).filter(Boolean)));
  const meetings = new Map<string, QrSigninMeetingRow>();
  for (const id of meetingIds.slice(0, 30)) {
    const meeting = await findQrSigninMeetingRow(env, id).catch(() => null);
    if (meeting) meetings.set(id, meeting);
  }

  const records: Record<string, unknown>[] = [];
  for (const row of rows) {
    const original = await findQrSigninRecordQrOrigin(env, row).catch(() => null);
    records.push(qrSigninResultFromRecord(row, meetings.get(row.meeting_id) || null, original));
  }
  return { ok: true, action: "listQrSigninRecords", source: "skhps-backend-supabase", table, count: records.length, records, data: records };
}

function normalizeQrSigninAdminStatus(input: unknown): string {
  const value = String(input || "").trim().toLowerCase();
  if (value === "manualsign" || value === "manual-sign" || value === "manual" || value === "補登") return "manual";
  if (value === "markleave" || value === "mark-leave" || value === "leave" || value === "請假") return "leave";
  if (value === "delete" || value === "void" || value === "archive" || value === "刪除" || value === "作廢") return "void";
  if (value === "absent" || value === "未簽到") return "absent";
  if (value === "signed" || value === "已簽到") return "signed";
  if (value === "outside_window" || value === "逾時") return "outside_window";
  if (value === "duplicate" || value === "重複簽到") return "duplicate";
  return "";
}

function qrSigninAdminActionName(status: string, actionName: string): string {
  const action = String(actionName || "").trim();
  if (action) return action;
  if (status === "manual") return "manual-signin";
  if (status === "leave") return "mark-leave";
  if (status === "void") return "void-record";
  return "update-record";
}

async function findQrSigninRecordById(env: Env, recordId: string): Promise<QrSigninRecordRow | null> {
  const table = getQrSigninRecordTable(env);
  const rows = await supabaseGet<QrSigninRecordRow[]>(env, `${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(recordId)}&limit=1`);
  return rows[0] || null;
}

/*
 * 每一次「編輯」都在這裡 INSERT 一筆新版本，不直接 UPDATE 原本那筆：
 * - 舊版內容原封不動保留（版本歷史用實體 row 呈現，不必只靠 QrSigninRecordAudit
 *   的 before/after_data 才能還原）。
 * - 純粹一筆 INSERT，不需要先 UPDATE 任何東西：「目前生效版本」是查詢時的概念
 *   （QrSigninRecordCurrent view 取 version_no 最大值），天生不會有併發衝突——
 *   這裡曾經用 is_current 旗標 + 唯一索引實作，逼得每次都要「先標舊版 false、
 *   再 INSERT 新版 true」兩步，兩個請求前後腳搶著寫就會撞唯一索引丟 500；
 *   改成單純比 version_no 之後這個 race 整類消失。
 * - qr_origin_id 預設整條繼承前一版的值，不會因為後續編輯而改變——這是「清除修改
 *   內容」要回到的 QR 原始基準，只有 submitQrSignin 偵測到「這條鏈第一次出現真正
 *   QR 簽到」時才會改寫它（見 submitQrSignin）。
 * - 若前一版剛好是這場會議的主持人/紀錄者，host_record_id/recorder_record_id 會
 *   自動跟著新版本走（只 patch 有命中的那個欄位，維持既有的防併發寫法）。
 */
async function createQrSigninRecordVersion(
  env: Env,
  previous: QrSigninRecordRow,
  patch: Record<string, unknown>,
  auditAction: string,
  auditMeta: {
    actorName?: string | null;
    actorEmployeeId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
    /*
     * 只有 submitQrSignin 偵測到「這條鏈第一次出現真正 QR 簽到」時才會傳 true——
     * 這一筆新版本本身就是 QR 原始基準，qr_origin_id 要指向自己，不是繼承前一版
     * （前一版通常是後台先建的 admin 記錄，沒有 QR 基準可繼承）。
     */
    selfIsQrOrigin?: boolean;
  }
): Promise<{ saved: QrSigninRecordRow; meeting: QrSigninMeetingRow | null }> {
  const table = getQrSigninRecordTable(env);

  const newRow: Record<string, unknown> = {
    ...previous,
    ...patch,
    supersedes_id: previous.id,
    qr_origin_id: auditMeta.selfIsQrOrigin ? null : (previous.qr_origin_id || null)
  };
  delete newRow.id;
  delete newRow.version_no;
  delete newRow.created_at;
  delete newRow.updated_at;

  const inserted = await supabasePost<QrSigninRecordRow[]>(env, table, newRow);
  let saved = Array.isArray(inserted) && inserted[0] ? inserted[0] : newRow as QrSigninRecordRow;

  if (auditMeta.selfIsQrOrigin && saved.id) {
    const selfOrigin = await supabasePatch<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(saved.id)}`, { qr_origin_id: saved.id });
    saved = Array.isArray(selfOrigin) && selfOrigin[0] ? selfOrigin[0] : { ...saved, qr_origin_id: saved.id };
  }

  let meeting: QrSigninMeetingRow | null = await findQrSigninMeetingRow(env, previous.meeting_id).catch(() => null);
  if (meeting) {
    const meetingPatch: Record<string, unknown> = {};
    if (meeting.host_record_id === previous.id) meetingPatch.host_record_id = saved.id;
    if (meeting.recorder_record_id === previous.id) meetingPatch.recorder_record_id = saved.id;
    if (Object.keys(meetingPatch).length) {
      const meetingTable = getQrSigninMeetingTable(env);
      const updatedMeetings = await supabasePatch<QrSigninMeetingRow[]>(env, meetingTable, `id=eq.${encodeURIComponent(meeting.id)}`, meetingPatch);
      meeting = Array.isArray(updatedMeetings) && updatedMeetings[0] ? updatedMeetings[0] : { ...meeting, ...meetingPatch } as QrSigninMeetingRow;
    }
  }

  await insertQrSigninAudit(env, {
    record_id: saved.id || null,
    meeting_id: previous.meeting_id,
    action: auditAction,
    actor_name: auditMeta.actorName || null,
    actor_employee_id: auditMeta.actorEmployeeId || null,
    note: auditMeta.note || null,
    // previous 和 saved 都是版本鏈上的實體列，永久留在 Record 表裡（previous.id 就是
    // saved.supersedes_id），這裡不用再各存一份全量 JSONB 快照，只留事件本身。
    metadata: { source: "qr-signin-backend", ...(auditMeta.metadata || {}) }
  });

  return { saved, meeting };
}

async function updateQrSigninRecord(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const table = getQrSigninRecordTable(env);
  const recordId = firstText(payload.recordId, payload.resultId, payload.id);
  let meetingId = firstText(payload.meetingId);
  let before: QrSigninRecordRow | null = null;

  if (recordId) {
    before = await findQrSigninRecordById(env, recordId);
    if (!before) return { ok: false, action: "updateQrSigninRecord", error: "RECORD_NOT_FOUND", recordId };
    meetingId = meetingId || before.meeting_id;
  }

  if (!meetingId) return { ok: false, action: "updateQrSigninRecord", error: "MISSING_MEETING_ID" };

  const meeting = await findQrSigninMeetingRow(env, meetingId).catch(() => null);
  if (!meeting) return { ok: false, action: "updateQrSigninRecord", error: "MEETING_NOT_FOUND", meetingId };

  const status = normalizeQrSigninAdminStatus(firstText(payload.status, payload.actionKey, payload.action));
  const nowIso = new Date().toISOString();
  /*
   * 只有「已簽到／補登」代表真的有簽到這件事發生，缺值才補「現在」當預設；
   * 請假／未簽到／未於時限內簽到／作廢都沒有真正的簽到時間，前端故意送空字串
   * 就是要留空，不能在這裡又補一個「現在」蓋掉，不然畫面會出現「未簽到」卻有
   * 簽到時間的矛盾資料。使用者自己在編輯表單填的時間一律照填（不管狀態是什麼）。
   */
  const providedSignedAt = normalizeQrSigninAdminSignedAt(firstText(payload.signedAt, payload.signed_at));
  const impliesActualSignin = status === "signed" || status === "manual";
  const signedAt = providedSignedAt || (impliesActualSignin ? nowIso : "");
  const name = firstText(payload.name, before && before.name);
  const employeeId = firstText(payload.employeeId, payload.employee_id, payload.empNo, before && before.employee_id);
  const role = firstText(payload.role, payload.rank, before && before.role);
  const reason = firstText(payload.reason, payload.note);
  const actorName = firstText(payload.actorName, payload.updatedBy, payload.operatorName);
  const actorEmployeeId = firstText(payload.actorEmployeeId, payload.operatorEmployeeId);
  const adminAction = qrSigninAdminActionName(status, firstText(payload.adminAction));

  if (!status) return { ok: false, action: "updateQrSigninRecord", error: "MISSING_STATUS" };
  if (!before && !name) return { ok: false, action: "updateQrSigninRecord", error: "MISSING_NAME" };

  /*
   * 「新增人員」＝前端送過來時沒有 recordId（見 qr-signin-backend.js 的
   * qrSwipePayload，新增的 transient row 從沒被存過，recordId 一定是空字串）。
   * 這種情況下如果姓名+員編剛好跟這場會議「目前生效」的某個人一樣，不能悄悄把
   * 對方的鏈也版本化一次——那等於在使用者沒發現的情況下改掉了別人的簽到資料
   * （例如員編多打一碼、剛好撞到別人）。改成直接擋下來，回傳那個人現有的資料，
   * 讓前端問使用者「這個人已經在名單裡，要不要改成編輯」。
   */
  const isNewPersonAttempt = !recordId;

  if (!before) {
    before = await findCurrentQrSigninRecord(env, { meetingId, employeeId, name }).catch(() => null);
  }

  if (isNewPersonAttempt && before) {
    const existingOriginal = before.qr_origin_id ? await findQrSigninRecordById(env, before.qr_origin_id).catch(() => null) : null;
    const existingResult = qrSigninResultFromRecord(before, meeting, existingOriginal);
    return {
      ok: false,
      action: "updateQrSigninRecord",
      error: "DUPLICATE_PERSON_IN_MEETING",
      existingRecordId: before.id,
      existingRecord: existingResult,
      record: existingResult
    };
  }

  /*
   * 編輯表單裡的主持人/紀錄者切換（bottom sheet 內建的 data-sk-bottom-sheet-single-select）
   * 跟表單「儲存」是同一次使用者動作，但水庫會各自獨立觸發一次 onSingleSelectSave 和
   * 一次 onSave——如果前端各自打一次後端請求，會各自對這筆記錄版本化成兩條不同的鏈
   * （其中一條通常會因為「內容沒變」被判定 source 打回 qr，而且沒人接手把 meeting
   * 的主持人指標接到那條鏈上），使用者會看到「儲存後主持人打勾又消失、來源跳回前台」。
   * 前端現在會把編輯時的主持人/紀錄者切換合併進同一次 updateQrSigninRecord 請求
   * （見 qr-signin-backend.js 的 onSingleSelectSave + handleQrSwipeSave），這裡收到
   * selectionState/clearSingleSelects 就一起套用在「這一次」建立的版本上，全程只有
   * 一條版本鏈、一次寫入。
   */
  const selectionPayload = normalizeSwipeSelectionPayload(payload.selectionState || {});
  const clearedSelectionKeys = new Set<string>();
  if (Array.isArray(payload.clearSingleSelects)) {
    payload.clearSingleSelects.forEach((key: unknown) => {
      const cleanKey = String(key || "").trim();
      if (cleanKey === "host" || cleanKey === "recorder") clearedSelectionKeys.add(cleanKey);
    });
  }
  const requestedHostRecordId = clearedSelectionKeys.has("host") ? "" : firstText(selectionPayload.singleSelects.host);
  const requestedRecorderRecordId = clearedSelectionKeys.has("recorder") ? "" : firstText(selectionPayload.singleSelects.recorder);
  const touchesHost = clearedSelectionKeys.has("host") || Boolean(requestedHostRecordId);
  const touchesRecorder = clearedSelectionKeys.has("recorder") || Boolean(requestedRecorderRecordId);
  /*
   * before 存在（編輯既有記錄）時，前端送來的 id 是這筆記錄「當下真正的」
   * resultId，一定要嚴格比對 === before.id 才算「指定的是自己」。
   * before 不存在（新增人員、INSERT 分支）時，前端送來的 id 其實是水庫
   * swipe-table.js 幫transient列產生的本機暫時 id（"row-<timestamp>"），
   * 存檔當下這筆記錄根本還沒有真正的 resultId，前端不可能預先知道、也就
   * 不可能送出真正比對得上的 id——但 UI 機制（checkHostRecorderNameMatch
   * 打姓名自動勾選 / 編輯列自己的單選圈）保證這個圈圈只會勾在「正在新增
   * 的這一列自己」，不會是別列，所以只要不是「清空」，touchesHost 為真
   * 就等同「這筆新記錄要成為主持人」，不需要（也無法）比對 id。
   * 沒有這段，新增人員時勾選主持人會在存檔當下悄悄整個沒作用（DB 沒寫入
   * host_record_id），要等下一次重新整理讓 resolveHostRecorderIntent()
   * 用真正的 id 重新指派一次才會生效（2026-07-09 使用者回報：新增人員
   * 打姓名時主持人打勾有顯示，儲存後卻不見了，重新整理才出現）。
   */
  const becomesHost = touchesHost && (before ? requestedHostRecordId === before.id : !clearedSelectionKeys.has("host"));
  const becomesRecorder = touchesRecorder && (before ? requestedRecorderRecordId === before.id : !clearedSelectionKeys.has("recorder"));

  // 根據新邏輯判斷 source：比對新內容是否與 QR 原始基準（qr_origin_id 指向的那筆）相同
  let computedSource = before ? before.source : "admin";  // 預設用現在的 source

  if (becomesHost || becomesRecorder) {
    // 這次編輯同時把這筆設成主持人/紀錄者：跟 updateQrSigninMeetingSelection 的行為
    // 一致，一律標記 source=admin，不要被下面「內容沒變就打回 qr」的邏輯蓋掉。
    computedSource = "admin";
  } else if (status !== "manual" && status !== "leave" && before) {
    // 取得 QR 原始基準來比對（不是這筆自己的 audit 快照，而是整條鏈的 qr_origin_id）
    const original = before.qr_origin_id ? await findQrSigninRecordById(env, before.qr_origin_id).catch(() => null) : null;
    if (original) {
      // 構建新的內容物件（用於比對）
      const newContent = {
        name,
        employee_id: employeeId || null,
        role: role || null,
        signed_at: signedAt,
        status
      };
      const currentComparable = qrRecordComparable(newContent);
      const originalComparable = qrRecordComparable(original);
      
      // 如果與原始內容完全相同，改回原始 source（通常是 "qr"）
      const isUnchanged = Object.keys(currentComparable).every(
        (key) => String(currentComparable[key] || "") === String(originalComparable[key] || "")
      );
      
      if (isUnchanged) {
        computedSource = String(original.source || "admin");
      } else {
        // 內容改變過，標記為後台修改
        computedSource = "admin";
      }
    }
  }

  const patch: Record<string, unknown> = {
    name,
    employee_id: employeeId || null,
    role: role || null,
    status,
    reason: reason || null,
    source: computedSource,
    updated_by: firstText(payload.updatedBy, actorName, actorEmployeeId) || null,
    note: firstText(payload.note, before && before.note) || null
  };

  // 編輯表單的簽到時間欄位不管簽到狀態是什麼都可以改，之前只有 manual/signed
  // 兩種狀態才會把 signedAt 寫進 patch，導致其他狀態（outside_window/leave/absent…）
  // 編輯時間欄位存了也是白存，畫面看起來改了、重新整理又打回原本的值。
  patch.signed_at = signedAt || null;
  // submitted_at 是「這筆記錄何時被建立/送出」的行政時間戳，跟 signed_at（有沒有
  // 真的簽到）是兩件事，不該被上面「非已簽到就留空」的邏輯連帶影響，一律用現在時間。
  patch.submitted_at = before ? before.submitted_at : nowIso;

  let saved: QrSigninRecordRow;
  /*
   * createQrSigninRecordVersion() 內建「若前一版剛好是主持人/紀錄者，
   * host_record_id/recorder_record_id 自動跟著新版本走」的邏輯，DB 寫入
   * 當下就是對的。但這裡組回應／effectiveMeeting 用的如果還是函式最上面
   * 抓的那份「編輯前」meeting 快照，就會回傳過期資料：這次請求明明沒去動
   * 主持人（touchesHost/touchesRecorder 都是 false，因為前端沒送
   * selectionState），使用者卻會看到「儲存後主持人消失」——DB 早就正確
   * 指到新版本，只是這次 API 回應沒反映，重新整理（重新抓 DB）就會恢復
   * 正常（2026-07-09 使用者回報：編輯已經是主持人的既有列，存檔當下畫面
   * 顯示沒有主持人，重新整理後兩邊又都對）。改成用 versioned.meeting
   * （createQrSigninRecordVersion 已經處理過自動接續的最新 meeting）當
   * effectiveMeeting 的起點，下面「這次編輯也明確切換主持人/紀錄者」的
   * PATCH 才疊加上去。
   */
  let effectiveMeeting = meeting;
  if (before) {
    const versioned = await createQrSigninRecordVersion(env, before, patch, adminAction, {
      actorName,
      actorEmployeeId,
      note: firstText(payload.note)
    });
    saved = versioned.saved;
    effectiveMeeting = versioned.meeting || meeting;
  } else {
    // 全新的人（後台手動新增，沒有既有記錄可版本化）：一律沒有 QR 基準。
    // chain_id 是 NOT NULL，必須在 INSERT 當下就給值（同 submitQrSignin 的新人分支），
    // 不能先插入再事後 PATCH 補 chain_id，那樣 INSERT 本身就會被 NOT NULL 擋掉。
    const newRecordId = crypto.randomUUID();
    const record: Record<string, unknown> = {
      id: newRecordId,
      meeting_id: meetingId,
      app_id: "qr-signin",
      env: appEnv,
      staff_source: "StaffMaster",
      submitted_at: nowIso,
      duplicate_of: null,
      client_request_id: firstText(payload.clientRequestId) || null,
      created_by: firstText(payload.createdBy, actorName, actorEmployeeId) || null,
      qr_origin_id: null,
      chain_id: newRecordId,
      ...patch
    };
    const inserted = await supabasePost<QrSigninRecordRow[]>(env, table, record);
    saved = Array.isArray(inserted) && inserted[0] ? inserted[0] : record as QrSigninRecordRow;

    await insertQrSigninAudit(env, {
      record_id: saved.id || null,
      meeting_id: meetingId,
      action: adminAction,
      actor_name: actorName || null,
      actor_employee_id: actorEmployeeId || null,
      note: firstText(payload.note) || null,
      // 全新一條鏈，沒有 before 可言；saved 本身永久留在 Record 表，不用再存 after_data。
      metadata: { source: "qr-signin-backend" }
    });
  }

  // 把編輯當下合併進來的主持人/紀錄者切換，疊加在 effectiveMeeting（已經含
  // createQrSigninRecordVersion 自動接續的結果）之上（見上方大註解）。這裡
  // 故意不再限定 before 存在——新增人員（!before）一樣可能在同一次請求裡
  // 帶著 becomesHost/becomesRecorder（見上面 becomesHost 大註解），一樣要
  // 套用到剛 INSERT 出來的 saved.id。
  if (touchesHost || touchesRecorder) {
    const meetingPatch: Record<string, unknown> = {};
    if (touchesHost) meetingPatch.host_record_id = becomesHost ? saved.id : null;
    if (touchesRecorder) meetingPatch.recorder_record_id = becomesRecorder ? saved.id : null;
    const meetingTable = getQrSigninMeetingTable(env);
    const updatedMeetings = await supabasePatch<QrSigninMeetingRow[]>(env, meetingTable, `id=eq.${encodeURIComponent(meetingId)}`, meetingPatch);
    effectiveMeeting = Array.isArray(updatedMeetings) && updatedMeetings[0] ? updatedMeetings[0] : { ...effectiveMeeting, ...meetingPatch } as QrSigninMeetingRow;
  }

  const original = saved.qr_origin_id ? await findQrSigninRecordById(env, saved.qr_origin_id).catch(() => null) : null;
  const result = qrSigninResultFromRecord(saved, effectiveMeeting, original);
  return { ok: true, action: "updateQrSigninRecord", source: "skhps-backend-supabase", table, data: result, record: result, before, meeting: effectiveMeeting ? qrSigninMeetingDisplay(effectiveMeeting) : null };
}

/*
 * 「清除修改內容」= 還原成這個人這場會議「最早一筆真正 QR 自行簽到」（qr_origin_id
 * 指向的那筆），不是還原成「這條版本鏈實體上最早一筆」——後台先建、QR 後到的情境下，
 * 這兩者不是同一筆。qr_origin_id 為空代表從沒有真正 QR 簽到過，沒有基準可清，
 * 直接回錯誤（前端也應該完全不顯示這個按鈕，見 qr-signin-backend.js 的 isEdited 判斷）。
 */
async function deleteQrSigninRecordEdits(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getQrSigninRecordTable(env);
  const meetingTable = getQrSigninMeetingTable(env);
  const recordId = firstText(payload.recordId, payload.resultId, payload.id);

  if (!recordId) return { ok: false, action: "deleteQrSigninRecordEdits", error: "MISSING_RECORD_ID" };

  const before = await findQrSigninRecordById(env, recordId);
  if (!before) return { ok: false, action: "deleteQrSigninRecordEdits", error: "RECORD_NOT_FOUND", recordId };

  if (!before.qr_origin_id) {
    return { ok: false, action: "deleteQrSigninRecordEdits", error: "NO_QR_ORIGIN", recordId };
  }

  const qrOrigin = await findQrSigninRecordById(env, before.qr_origin_id);
  if (!qrOrigin) {
    return { ok: false, action: "deleteQrSigninRecordEdits", error: "NO_QR_ORIGIN", recordId };
  }

  const meetingBefore = await findQrSigninMeetingRow(env, before.meeting_id).catch(() => null);
  const roleFlags = qrSigninRecordRoleFlags(before, meetingBefore || null);
  const actorName = firstText(payload.actorName, payload.updatedBy, payload.operatorName);
  const actorEmployeeId = firstText(payload.actorEmployeeId, payload.operatorEmployeeId);

  const patch: Record<string, unknown> = {
    name: qrOrigin.name,
    employee_id: qrOrigin.employee_id,
    role: qrOrigin.role,
    staff_source: qrOrigin.staff_source,
    signed_at: qrOrigin.signed_at,
    submitted_at: qrOrigin.submitted_at,
    status: qrOrigin.status,
    reason: qrOrigin.reason,
    source: qrOrigin.source,
    duplicate_of: qrOrigin.duplicate_of,
    client_request_id: qrOrigin.client_request_id,
    note: qrOrigin.note,
    updated_by: firstText(payload.updatedBy, actorName, actorEmployeeId) || null
  };

  const versioned = await createQrSigninRecordVersion(env, before, patch, "clear-record-edits", {
    actorName,
    actorEmployeeId,
    note: firstText(payload.note),
    metadata: { restoreOriginal: true, clearHost: roleFlags.isHost, clearRecorder: roleFlags.isRecorder }
  });
  const saved = versioned.saved;
  let savedMeeting = versioned.meeting;

  // 「清除」本身就是要把主持人/紀錄者身分一起清掉，優先權高於
  // createQrSigninRecordVersion 內建的「host/recorder 指標跟著新版本走」。
  if (savedMeeting && (roleFlags.isHost || roleFlags.isRecorder)) {
    const meetingPatch: Record<string, unknown> = {
      updated_by: firstText(payload.updatedBy, actorName, actorEmployeeId) || savedMeeting.updated_by || null
    };
    if (roleFlags.isHost) meetingPatch.host_record_id = null;
    if (roleFlags.isRecorder) meetingPatch.recorder_record_id = null;
    const updatedMeetings = await supabasePatch<QrSigninMeetingRow[]>(env, meetingTable, `id=eq.${encodeURIComponent(savedMeeting.id)}`, meetingPatch);
    savedMeeting = Array.isArray(updatedMeetings) && updatedMeetings[0]
      ? updatedMeetings[0]
      : { ...savedMeeting, ...meetingPatch } as QrSigninMeetingRow;
  }

  const result = qrSigninResultFromRecord(saved, savedMeeting, qrOrigin);
  const meetingDisplay = savedMeeting ? qrSigninMeetingDisplay(savedMeeting) : null;
  return {
    ok: true,
    action: "deleteQrSigninRecordEdits",
    source: "skhps-backend-supabase",
    table,
    data: result,
    record: result,
    meeting: meetingDisplay,
    selectionState: meetingDisplay && meetingDisplay.selectionState || { singleSelects: {}, multiSelects: {} },
    before
  };
}

async function deleteQrSigninRecord(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const table = getQrSigninRecordTable(env);
  const auditTable = getQrSigninAuditTable(env);
  const recordId = firstText(payload.recordId, payload.resultId, payload.id);

  if (!recordId) return { ok: false, action: "deleteQrSigninRecord", error: "MISSING_RECORD_ID" };

  const before = await findQrSigninRecordById(env, recordId);
  if (!before) return { ok: false, action: "deleteQrSigninRecord", error: "RECORD_NOT_FOUND", recordId };

  const actorName = firstText(payload.actorName, payload.updatedBy, payload.operatorName);
  const actorEmployeeId = firstText(payload.actorEmployeeId, payload.operatorEmployeeId);

  /*
   * 真刪除：整條版本鏈（chain_id 相同的所有版本）一起砍掉，不是只刪
   * recordId 這一筆。每次編輯都是 INSERT 新版本、supersedes_id 指回前一版
   * （見 saveQrSigninRecordEdit 上面的說明），前端手上的 recordId 只要不是
   * 這條鏈「目前生效版本」（例如重新整理前的舊快照、或編輯送出的回應還沒
   * 更新到前端狀態），單刪這一筆就會直接撞
   * QrSigninRecord_supersedes_id_fkey（因為還有更新的版本用 supersedes_id
   * 指著它）。改成一次抓出整條鏈、用同一個 DELETE 陳述式整批刪掉——只要
   * 鏈外沒有東西指著它們，同一批一起刪就不會有「被鏈內其他列擋住」的問題。
   */
  const chainId = before.chain_id || "";
  const chainRows = chainId
    ? await supabaseGet<QrSigninRecordRow[]>(env, `${encodeURIComponent(table)}?select=id&chain_id=eq.${encodeURIComponent(chainId)}`)
    : [before];
  const chainRecordIds = (Array.isArray(chainRows) && chainRows.length ? chainRows.map((row) => row.id) : [recordId]).filter(Boolean);
  const chainIdFilter = chainRecordIds.map((id) => encodeURIComponent(id)).join(",");

  /*
   * 連同這條鏈過去所有的稽核紀錄（audit trail，含最原始那一筆）一起砍掉。
   * 跟「封存/作廢」（status=void，資料還在）是不同語意——這裡刪完之後這筆記錄的
   * 歷史完全不存在，之後如果要做「恢復原始資料」，是靠 audit trail 保留原始 before_data，
   * 所以這個 delete 動作本身也要留一筆自己的稽核紀錄（存在另一張表／或直接記 log），
   * 避免砍掉之後完全查不到「誰在什麼時候刪除了這筆」。
   */
  await supabaseDelete<unknown[]>(env, auditTable, `record_id=in.(${chainIdFilter})`).catch(() => []);

  // record_id 是 FK（on delete set null），一定要在刪記錄「之前」寫入，
  // 不然記錄一旦被刪掉，這筆稽核紀錄的 record_id 會直接違反外鍵限制而寫入失敗。
  // 記錄真的被刪除後，Postgres 會自動把這筆的 record_id 設成 null，
  // before_data 裡仍保留完整快照，所以不影響追溯「誰在何時刪除了什麼」。
  await insertQrSigninAudit(env, {
    record_id: recordId,
    meeting_id: before.meeting_id,
    action: "delete-record",
    actor_name: actorName || null,
    actor_employee_id: actorEmployeeId || null,
    note: firstText(payload.note) || null,
    before_data: before,
    after_data: { deletedChainRecordIds: chainRecordIds },
    metadata: { source: "qr-signin-backend", hardDelete: true, chainId: chainId || null }
  });

  const deleted = chainId
    ? await supabaseDelete<QrSigninRecordRow[]>(env, table, `chain_id=eq.${encodeURIComponent(chainId)}`)
    : await supabaseDelete<QrSigninRecordRow[]>(env, table, `id=eq.${encodeURIComponent(recordId)}`);

  /*
   * 這個人如果剛好是這場會議目前的主持人/紀錄者，整條鏈砍掉之後
   * QrSigninMeeting.host_record_id/recorder_record_id 會變成指著一筆已經
   * 不存在的記錄——這是一個「懸空指標」：畫面上主持人框看起來是空的（候選
   * 名單裡已經沒有這個人可以比對），但 liveSingleSelectId() 讀到的還是這個
   * 已刪除的舊 id（非空字串），導致「輸入預設值」的空值判斷誤判成「還有人
   * 被指派」而不肯套用預設值，只有整頁重新整理、選會議清單重新抓一次
   * meeting 才會撞見這個不存在的 id 進而正確清空。這裡砍記錄的同時，只要
   * 這個人是這條鏈的一員就直接把 meeting 對應欄位一起清掉，不留懸空指標。
   */
  let meetingAfterDelete: QrSigninMeetingRow | null = await findQrSigninMeetingRow(env, before.meeting_id).catch(() => null);
  if (meetingAfterDelete) {
    const meetingTable = getQrSigninMeetingTable(env);
    const meetingPatch: Record<string, unknown> = {};
    if (meetingAfterDelete.host_record_id && chainRecordIds.indexOf(meetingAfterDelete.host_record_id) >= 0) {
      meetingPatch.host_record_id = null;
    }
    if (meetingAfterDelete.recorder_record_id && chainRecordIds.indexOf(meetingAfterDelete.recorder_record_id) >= 0) {
      meetingPatch.recorder_record_id = null;
    }
    if (Object.keys(meetingPatch).length) {
      const updatedMeetings = await supabasePatch<QrSigninMeetingRow[]>(env, meetingTable, `id=eq.${encodeURIComponent(meetingAfterDelete.id)}`, meetingPatch).catch(() => []);
      meetingAfterDelete = Array.isArray(updatedMeetings) && updatedMeetings[0] ? updatedMeetings[0] : { ...meetingAfterDelete, ...meetingPatch } as QrSigninMeetingRow;
    }
  }

  return {
    ok: true,
    action: "deleteQrSigninRecord",
    source: "skhps-backend-supabase",
    table,
    recordId,
    deletedChainRecordIds: chainRecordIds,
    deletedCount: Array.isArray(deleted) ? deleted.length : 0,
    meeting: meetingAfterDelete ? qrSigninMeetingDisplay(meetingAfterDelete) : null
  };
}

/*
 * 最小 .xlsx 寫檔實作：Worker 沒有裝任何 xlsx 套件，這裡跟 PDF exporter
 * 同一套風格，直接手刻 ZIP + 最小 OOXML 結構，不引入外部依賴。
 * ZIP 一律用 STORED（不壓縮），省掉自己刻 DEFLATE 演算法的麻煩；檔案不大，
 * 不壓縮換來的檔案體積增加可以接受。每個 sheet 儲存格都用 inlineStr，
 * 不用 sharedStrings.xml，少一個檔案、邏輯單純。
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;

  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  const result = new Uint8Array(offset + centralSize + endRecord.length);
  let pos = 0;
  localParts.forEach((part) => { result.set(part, pos); pos += part.length; });
  centralParts.forEach((part) => { result.set(part, pos); pos += part.length; });
  result.set(endRecord, pos);
  return result;
}

function xmlEscape(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xlsxColumnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildXlsxSheetXml(header: string[], rows: string[][]): string {
  const allRows = [header, ...rows];
  const rowsXml = allRows.map((cells, rowIndex) => {
    const r = rowIndex + 1;
    const cellsXml = cells.map((cellValue, colIndex) => {
      const ref = xlsxColumnLetter(colIndex) + r;
      const text = xmlEscape(cellValue);
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${cellsXml}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

function buildMinimalXlsx(header: string[], rows: string[][]): Uint8Array {
  const encoder = new TextEncoder();
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheetXml = buildXlsxSheetXml(header, rows);

  return buildZip([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rootRels) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml) }
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/*
 * 匯出檔名跟前端「簽到單 PDF」（[meetingDate, meeting.title, "簽到單.pdf"].join("-")）
 * 用同一套命名邏輯：{會議日期}-{會議名稱}-{suffix}.xlsx，只是 suffix 換成
 * 「簽到上傳」或「簽到原始檔案」。找不到會議資料時退回今天日期跟通用名稱。
 */
async function qrExportFilename(env: Env, meetingId: string, suffix: string): Promise<string> {
  const meeting = meetingId ? await findQrSigninMeetingRow(env, meetingId).catch(() => null) : null;
  const meetingDate = firstText(meeting && meeting.meeting_date) || new Date().toISOString().slice(0, 10);
  const title = firstText(meeting && meeting.title) || "會議";
  return [meetingDate, title, suffix].filter(Boolean).join("-") + ".xlsx";
}

/*
 * exportQrSigninRecords 回傳的 row.signedAt 是 ISO 字串（UTC），CSV 給人看的
 * 欄位要轉成台北時間、人類看得懂的「YYYY/MM/DD HH:mm」，不能直接印 ISO 原文。
 */
function formatTaipeiDisplayDateTime(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return [
    taipei.getUTCFullYear(),
    pad2(taipei.getUTCMonth() + 1),
    pad2(taipei.getUTCDate())
  ].join("/") + " " + [
    pad2(taipei.getUTCHours()),
    pad2(taipei.getUTCMinutes())
  ].join(":");
}

// 「簽到上傳格式」的簽到時間只要 07:30 這種時分，不用帶年月日。
function formatTaipeiTimeOnly(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return [pad2(taipei.getUTCHours()), pad2(taipei.getUTCMinutes())].join(":");
}

/*
 * exportQrSigninRecords 回傳的 row.status 是 qrSigninFrontendStatus() 那套
 * success/duplicate/closed/raw 狀態，不是給人看的中文——CSV 要用跟 Swipe Table
 * 一致的 4 種中文狀態（已簽到/請假/未簽到/未於時限內簽到）。
 */
function qrCsvStatusLabel(status: unknown): string {
  const normalized = qrRecordStatusComparable(status);
  if (normalized === "signed") return "已簽到";
  if (normalized === "outside_window") return "未於時限內簽到";
  if (normalized === "leave") return "請假";
  return "未簽到";
}

// 給「另一個簽到上傳」格式用：狀態只能是出席/未簽到，不分是哪一種沒出席。
function qrCsvAttendanceLabel(status: unknown): string {
  return qrRecordStatusComparable(status) === "signed" ? "出席" : "未簽到";
}

async function exportQrSigninRecords(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const meetingId = firstText(payload.meetingId);
  // 一定要把 env 轉傳下去，不然 listQrSigninRecords 內部找不到 env 會預設當 prod，
  // 在 local-dev/dev 測試匯出時會查到 prod 的資料（甚至查不到自己剛建的測試資料）。
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const result = await listQrSigninRecords(env, { payload: { meetingId, env: appEnv, limit: qrNumberFromEnv(payload.limit, 500) } });
  const rows = Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
  const header = ["姓名", "員工編號", "職級", "狀態", "簽到時間"];
  const sheetRows = rows.map((row) => [
    String(row.name || ""),
    String(row.employeeId || ""),
    String(row.role || ""),
    qrCsvStatusLabel(row.status),
    formatTaipeiDisplayDateTime(row.signedAt)
  ]);
  const base64 = bytesToBase64(buildMinimalXlsx(header, sheetRows));
  const filename = await qrExportFilename(env, meetingId, "簽到原始檔案");

  return {
    ok: true,
    action: "exportQrSigninRecords",
    source: "skhps-backend-supabase",
    filename,
    mimeType: XLSX_MIME_TYPE,
    count: rows.length,
    base64,
    data: { base64, rows }
  };
}

/*
 * 「另一個簽到上傳」格式：給外部系統上傳用，欄位固定是員工編號/身分證字號/姓名/
 * 簽到時間/簽退時間/狀態。目前系統沒有蒐集身分證字號，這欄跟簽退時間一律留空；
 * 狀態只分「出席」跟「未簽到」兩種，不分請假/未於時限內簽到這些細節。
 */
async function exportQrSigninAttendanceUpload(env: Env, body: any) {
  const payload = normalizeRegistryPayload(body);
  const meetingId = firstText(payload.meetingId);
  const appEnv = normalizeEnv(firstText(body.env, payload.env));
  const result = await listQrSigninRecords(env, { payload: { meetingId, env: appEnv, limit: qrNumberFromEnv(payload.limit, 500) } });
  const rows = Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
  const header = ["員工編號", "身分證字號", "姓名", "簽到時間", "簽退時間", "狀態"];
  const sheetRows = rows.map((row) => [
    String(row.employeeId || ""),
    "",
    String(row.name || ""),
    formatTaipeiTimeOnly(row.signedAt),
    "",
    qrCsvAttendanceLabel(row.status)
  ]);
  const base64 = bytesToBase64(buildMinimalXlsx(header, sheetRows));
  const filename = await qrExportFilename(env, meetingId, "簽到上傳");

  return {
    ok: true,
    action: "exportQrSigninAttendanceUpload",
    source: "skhps-backend-supabase",
    filename,
    mimeType: XLSX_MIME_TYPE,
    count: rows.length,
    base64,
    data: { base64, rows }
  };
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

  if (action === "getCssRegistryRuntime" || action === "getCssSheetRuntime") {
    try {
      const result = await getCssRegistryRuntime(env, body, action);
      return json(result);
    } catch (error) {
      return json({
        ok: false,
        action,
        canonicalAction: "getCssRegistryRuntime",
        source: "skhps-backend-supabase",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "saveCssSheetRows") {
    try {
      const result = await saveCssRegistryRows(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        canonicalAction: "saveCssRegistryRows",
        source: "skhps-backend-supabase",
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "deleteCssRegistryRows") {
    try {
      const result = await deleteCssRegistryRows(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({
        ok: false,
        action,
        source: "skhps-backend-supabase",
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


  if (action === "previewQrSigninCalendarMeetings") {
    try {
      const result = await previewQrSigninCalendarMeetings(env, body);
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

  if (action === "updateQrSigninMeetingSelection") {
    try {
      const result = await updateQrSigninMeetingSelection(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({ ok: false, action, source: "skhps-backend", error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "updateQrSigninMeetingPdfFields") {
    try {
      const result = await updateQrSigninMeetingPdfFields(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({ ok: false, action, source: "skhps-backend", error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "getAppDefaults") {
    try {
      const result = await getAppDefaults(env, body);
      return json(result, result.ok === false ? 400 : 200);
    } catch (error) {
      return json({ ok: false, action, source: "skhps-backend", error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action === "saveAppDefaults") {
    try {
      const result = await saveAppDefaults(env, body);
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

  if (action === "updateQrSigninRecord") {
    try {
      const result = await updateQrSigninRecord(env, body);
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

  if (action === "deleteQrSigninRecordEdits") {
    try {
      const result = await deleteQrSigninRecordEdits(env, body);
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

  if (action === "deleteQrSigninRecord") {
    try {
      const result = await deleteQrSigninRecord(env, body);
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

  if (action === "exportQrSigninRecords") {
    try {
      const result = await exportQrSigninRecords(env, body);
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

  if (action === "exportQrSigninAttendanceUpload") {
    try {
      const result = await exportQrSigninAttendanceUpload(env, body);
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

  if (action === "syncLocalDevFromProd") {
    try {
      // 1. 同步會議表
      const meetingTable = getQrSigninMeetingTable(env);
      let allProdMeetings: QrSigninMeetingRow[] = [];
      let offset = 0;
      const pageSize = 1000;
      
      console.log("Starting to query prod meetings...");
      while (true) {
        const pageMeetings = await supabaseGet<QrSigninMeetingRow[]>(
          env,
          `${encodeURIComponent(meetingTable)}?select=*&env=eq.prod&enabled=eq.true&status=eq.active&order=created_at.asc&limit=${pageSize}&offset=${offset}`
        ).catch((e) => {
          console.log("Query meetings error:", e);
          return [] as QrSigninMeetingRow[];
        });
        
        console.log(`Queried meetings at offset ${offset}: ${Array.isArray(pageMeetings) ? pageMeetings.length : 'error'} results`);
        if (!Array.isArray(pageMeetings) || pageMeetings.length === 0) break;
        allProdMeetings = allProdMeetings.concat(pageMeetings);
        
        if (pageMeetings.length < pageSize) break;
        offset += pageSize;
      }
      
      console.log(`Total prod meetings fetched: ${allProdMeetings.length}`);
      
      // 刪除所有 local-dev 會議
      await supabaseDelete(env, meetingTable, "env=eq.local-dev").catch(() => null);
      
      // 批量複製會議（不保留 ID，讓 Supabase 生成新 ID）
      const meetingsToInsert: Record<string, unknown>[] = [];
      const meetingIdMap = new Map<string, string>(); // prod id => local-dev id mapping
      for (const meeting of allProdMeetings) {
        const prodId = meeting.id;
        const newMeeting: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(meeting)) {
          if (key !== "id") {
            newMeeting[key] = key === "env" ? "local-dev" : value;
          }
        }
        meetingsToInsert.push(newMeeting);
      }
      console.log(`Prepared ${meetingsToInsert.length} meetings for insert (IDs not preserved, will be auto-generated)`);
      
      let meetingsInserted = 0;
      if (meetingsToInsert.length > 0) {
        const baseUrl = getSupabaseBaseUrl(env);
        console.log(`Attempting to insert ${meetingsToInsert.length} meetings one by one...`);
        
        for (let i = 0; i < meetingsToInsert.length; i++) {
          const meeting = meetingsToInsert[i];
          try {
            const meetingResponse = await fetch(`${baseUrl}/rest/v1/${encodeURIComponent(meetingTable)}`, {
              method: "POST",
              headers: {
                ...getSupabaseHeaders(env),
                "Prefer": "return=representation"
              },
              body: JSON.stringify(meeting)
            });
            
            if (meetingResponse.ok) {
              meetingsInserted++;
              if (i % 5 === 0) {
                console.log(`Inserted ${meetingsInserted}/${meetingsToInsert.length} meetings`);
              }
            } else {
              const errorText = await meetingResponse.text();
              console.log(`Meeting ${i} insert failed (${meetingResponse.status}): ${errorText.substring(0, 200)}`);
            }
          } catch (e) {
            console.log(`Meeting ${i} insert error: ${e}`);
          }
        }
        console.log(`Finished inserting meetings: ${meetingsInserted}/${meetingsToInsert.length}`);
      } else {
        console.log("No meetings to insert");
      }
      
      // 2. 暫時跳過記錄複製
      let recordsInserted = 0;
      
      return json({
        ok: true,
        action,
        message: `Synced ${meetingsInserted} meetings (records sync skipped) from prod to local-dev`,
        meetings: { copied: meetingsInserted, total: allProdMeetings.length },
        records: { copied: recordsInserted, total: 0 }
      });
    } catch (error) {
      return json({
        ok: false,
        action,
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }

  if (action === "resetLocalDevSourceToQr") {
    try {
      const table = getQrSigninRecordTable(env);
      const result = await supabasePatch(
        env,
        table,
        "env=eq.local-dev",
        { source: "qr" }
      );
      return json({
        ok: true,
        action,
        message: "All local-dev records source reset to qr",
        result
      });
    } catch (error) {
      return json({
        ok: false,
        action,
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
        cssRegistry: {
          route: "/api/action",
          action: "getCssRegistryRuntime",
          compatibilityAction: "getCssSheetRuntime",
          view: getCssRegistryRuntimeView(env),
          source: "supabase"
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
