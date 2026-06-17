/*
 * 檔案位置：skhps-backend-worker/seed/001_seed_apps.sql
 * 時間戳記：2026-06-17
 * 用途：SKHPS external apps 第一階段 seed data。
 */

insert into apps (
  app_id,
  title,
  description,
  group_key,
  default_href,
  active
)
values
  (
    'quick-login',
    '醫院系統快速登入',
    '常用院內系統快速入口。',
    'frontend',
    'https://quick-login.jonaminz.com/',
    true
  ),
  (
    'qr-signin',
    'QR 簽到',
    'QR code 簽到與結果查詢。',
    'frontend',
    'https://qr-signin.jonaminz.com/',
    true
  ),
  (
    'dressing-inventory',
    '敷料庫存盤點領用系統',
    '敷料庫存、批號、效期與領用流程。',
    'frontend',
    'https://dressing-inventory.jonaminz.com/',
    true
  )
on conflict (app_id) do update set
  title = excluded.title,
  description = excluded.description,
  group_key = excluded.group_key,
  default_href = excluded.default_href,
  active = excluded.active,
  updated_at = now();

insert into app_cards (
  app_id,
  title,
  subtitle,
  description,
  icon,
  badge
)
values
  (
    'quick-login',
    '醫院系統快速登入',
    'Quick Login',
    '快速開啟常用院內系統。',
    'login',
    null
  ),
  (
    'qr-signin',
    'QR 簽到',
    'QR Sign-in',
    '掃描 QR code 完成簽到流程。',
    'qr',
    null
  ),
  (
    'dressing-inventory',
    '敷料庫存盤點領用系統',
    'Dressing Inventory',
    '管理敷料庫存、批號效期與領用紀錄。',
    'inventory',
    null
  )
on conflict (app_id) do update set
  title = excluded.title,
  subtitle = excluded.subtitle,
  description = excluded.description,
  icon = excluded.icon,
  badge = excluded.badge,
  updated_at = now();

insert into app_environments (
  app_id,
  env,
  href,
  enabled,
  placement,
  sort_order,
  maintenance
)
values
  (
    'quick-login',
    'dev',
    'https://dev-quick-login.jonaminz.com/',
    true,
    'frontend',
    10,
    false
  ),
  (
    'quick-login',
    'prod',
    'https://quick-login.jonaminz.com/',
    true,
    'frontend',
    10,
    false
  ),
  (
    'qr-signin',
    'dev',
    'https://dev-qr-signin.jonaminz.com/',
    true,
    'frontend',
    20,
    false
  ),
  (
    'qr-signin',
    'prod',
    'https://qr-signin.jonaminz.com/',
    true,
    'frontend',
    20,
    false
  ),
  (
    'dressing-inventory',
    'dev',
    'https://dev-dressing-inventory.jonaminz.com/',
    true,
    'frontend',
    30,
    false
  ),
  (
    'dressing-inventory',
    'prod',
    'https://dressing-inventory.jonaminz.com/',
    true,
    'frontend',
    30,
    false
  )
on conflict (app_id, env) do update set
  href = excluded.href,
  enabled = excluded.enabled,
  placement = excluded.placement,
  sort_order = excluded.sort_order,
  maintenance = excluded.maintenance,
  updated_at = now();
