/**
 * Config-Management: its nine pages, their tabs, who sees which, where each of yesterday's
 * Config tabs went, and the "Find a setting" index (the approved board of 2026-11-05).
 *
 * Pure: no DOM, no state. The page (pages/settings.js) draws from it, the shell (app.js)
 * routes with it, and tools/unit/config-nav.test.mjs checks it — one definition, so the
 * sidebar, the tab row, a deep link and the search cannot disagree about where a setting is.
 *
 * Three tabs are whole pages of the app that left the page menu: Alerts › Automation
 * (`#/automation`), Requests › Request Centre (`#/requests`) and Accounts (`#/accounts`).
 * They keep their own app page id — so every link, alert "go to" and deep link to them still
 * lands — and the shell draws them inside this frame (`appPage`).
 */

/** Roles, lowest first. A portable build has no accounts: no role there means admin. */
const RANK = { guest: 0, user: 1, operator: 2, admin: 3 };

/**
 * The pages, in the order of the menu. `line` is the one sentence under the page title.
 * A tab with `operator: true` is one an operator may open; every other tab is an admin's,
 * exactly as before the redesign. `needs` names a support flag the core has to report
 * (see visibleConfig); a tab whose flag is false is not drawn at all — never a mock.
 */
export const CFG_PAGES = Object.freeze([
  { id: 'clusters', label: 'Clusters', line: 'Every Elasticsearch cluster ElasticPro watches, where it comes from and how it signs in.',
    tabs: [
      { id: 'clusters', label: 'Clusters', operator: true },
      { id: 'creds', label: 'Credentials' },
      { id: 'trust', label: 'Jump hosts & trust' },
    ] },
  { id: 'accounts', label: 'Accounts', sub: 'People and their roles', line: 'Who may sign in to ElasticPro, with which role, and the users it keeps on the clusters.',
    tabs: [{ id: 'accounts', label: 'Accounts', appPage: 'accounts', needs: 'accounts' }] },
  { id: 'zabbix', label: 'Zabbix', sub: 'Connection · cluster hosts', line: 'Zabbix owns the cluster hosts and their passwords. ElasticPro reads them on a timer and signs people in from Zabbix.',
    tabs: [{ id: 'zabbix', label: 'Zabbix' }] },
  { id: 'alerts', label: 'Alerts', line: 'Switch a built-in rule off to stop it appearing on the Alerts page. Alerts already acknowledged keep their history.',
    tabs: [
      { id: 'triggers', label: 'Triggers' },
      { id: 'automation', label: 'Automation', operator: true, appPage: 'automation' },
    ] },
  { id: 'requests', label: 'Requests', line: 'When the core goes to the clusters, how many requests it sends at once, and whether it sends any at all.',
    tabs: [
      { id: 'policy', label: 'Policy' },
      { id: 'centre', label: 'Request Centre', operator: true, appPage: 'requests' },
    ] },
  { id: 'reports', label: 'Reports', line: 'Which indices count towards volume, the volume report mailed as an .xlsx with the mail server that sends it, and the plan templates.',
    tabs: [
      { id: 'fields', label: 'Indices & volume fields' },
      { id: 'mail', label: 'Mail delivery' },
      { id: 'templates', label: 'Plan templates' },
    ] },
  { id: 'data', label: 'Data', line: 'Where ElasticPro keeps what it records, and the scheduled log-delay measurement.',
    tabs: [
      { id: 'backend', label: 'Backend', needs: 'history' },
      { id: 'schedule', label: 'Scheduled log delay', needs: 'sink' },
    ] },
  { id: 'play', label: 'Play', sub: 'TV displays · watch rules', line: 'Display links for the TVs, the watch rules every display shares, and the clusters left out of Play.',
    tabs: [{ id: 'play', label: 'Play' }] },
  { id: 'system', label: 'System', line: 'Defaults for every cluster, which file is loaded with its earlier versions, and whether the write protection holds.',
    tabs: [
      { id: 'defaults', label: 'Defaults' },
      { id: 'file', label: 'Config file' },
      { id: 'backup', label: 'Backup & restore', needs: 'backup' },
    ] },
]);

/** The app pages drawn as a tab of this frame: app page id → [page, tab]. */
export const HOSTED_TABS = Object.freeze({
  automation: ['alerts', 'automation'],
  requests: ['requests', 'centre'],
  accounts: ['accounts', 'accounts'],
});

/**
 * Yesterday's Config tab ids (intent.settings.section, saved links) → [page, tab]. Every one of
 * the thirteen has a home; Diagnostics merged into System › Config file.
 */
export const LEGACY_SECTIONS = Object.freeze({
  file: ['system', 'file'], creds: ['clusters', 'creds'], clusters: ['clusters', 'clusters'],
  zabbix: ['zabbix', 'zabbix'], trust: ['clusters', 'trust'], alerts: ['alerts', 'triggers'],
  schedule: ['data', 'schedule'], history: ['data', 'backend'], requests: ['requests', 'policy'],
  defaults: ['system', 'defaults'], volume: ['reports', 'fields'], play: ['play', 'play'], diag: ['system', 'file'],
});

/** Whether `role` (null: no accounts, so admin) is an admin's. */
export const isAdminRole = (role) => !role || role === 'admin';
/** Whether `role` reaches Config-Management at all: an operator or an admin. */
export const reachesConfig = (role) => !role || (RANK[role] ?? -1) >= RANK.operator;

/**
 * The pages and tabs this caller sees, in menu order; a page with no visible tab is left out.
 *
 *   role      the signed-in role, or null where there are no accounts (portable: an admin)
 *   supports  { accounts, history, sink, backup }: what the core said it has. A missing or
 *             false flag hides the tab — the core decides, never a guess.
 *
 * An operator gets Clusters › Clusters, Alerts › Automation and Requests › Request Centre and
 * nothing else; a user or a guest gets nothing (they do not reach the page).
 */
export function visibleConfig(role, supports = {}) {
  if (!reachesConfig(role)) return [];
  const admin = isAdminRole(role);
  const out = [];
  for (const p of CFG_PAGES) {
    const tabs = p.tabs.filter((t) => (admin || t.operator) && (!t.needs || supports[t.needs] === true));
    if (tabs.length) out.push({ ...p, tabs });
  }
  return out;
}

/** The sub-line under a menu item: its tabs, or its own words when it is one page. */
export function subLine(page) {
  if (page.tabs.length > 1) return page.tabs.map((t) => t.label).join(' · ');
  return page.sub || page.tabs[0].label;
}

/**
 * Where a route lands among what is visible: `{page, tab}`, falling back to the page's first
 * visible tab and then to the first visible page. Null when nothing is visible.
 */
export function resolveRoute(visible, pageId, tabId) {
  if (!visible.length) return null;
  const page = visible.find((p) => p.id === pageId) || visible[0];
  const tab = page.tabs.find((t) => t.id === tabId) || page.tabs[0];
  return { page: page.id, tab: tab.id };
}

/** `{page, tab}` from what follows `#/settings/`, e.g. 'requests/policy'; also a legacy id ('volume'). */
export function routeOfRest(rest) {
  const [a, b] = String(rest || '').split('?')[0].split('/').filter(Boolean);
  if (!a) return { page: '', tab: '' };
  if (!CFG_PAGES.some((p) => p.id === a) && LEGACY_SECTIONS[a]) {
    const [page, tab] = LEGACY_SECTIONS[a];
    return { page, tab };
  }
  return { page: a, tab: b || '' };
}

/** The hash a tab lives at: its own app page for a hosted tab, else `#/settings/<page>/<tab>`. */
export function tabHash(pageId, tabId) {
  const p = CFG_PAGES.find((x) => x.id === pageId);
  const t = p && p.tabs.find((x) => x.id === tabId);
  if (t && t.appPage) return `#/${t.appPage}`;
  return `#/settings/${pageId}${tabId ? `/${tabId}` : ''}`;
}

/** The app page id that draws a tab: 'settings', or the hosted page's own id. */
export function appPageOf(pageId, tabId) {
  const p = CFG_PAGES.find((x) => x.id === pageId);
  const t = p && p.tabs.find((x) => x.id === tabId);
  return (t && t.appPage) || 'settings';
}

/* ----------------------------------- Find a setting ----------------------------------- */

/**
 * The label index: [page, tab, label, field id (focused on arrival, optional), extra words].
 * The labels are the ones the sections draw, so what is typed is what is on the screen.
 * Pages add rows of their own at run time (each alert rule, for one) through `extra` below.
 */
export const SETTING_INDEX = Object.freeze([
  ['clusters', 'clusters', 'Add cluster', '', 'new cluster url'],
  ['clusters', 'clusters', 'Cluster list', '', 'clusters source zabbix file connection'],
  ['clusters', 'clusters', 'Export cluster list', '', 'csv'],
  ['clusters', 'creds', 'Default credential', '', 'password api key username'],
  ['clusters', 'creds', 'Store in config file (encrypted)', '', 'master password credential'],
  ['clusters', 'creds', 'Sign in to clusters', '', 'credential typed session'],
  ['clusters', 'trust', 'Jump hosts', '', 'ssh tunnel via'],
  ['clusters', 'trust', 'Add jump host', '', 'ssh'],
  ['clusters', 'trust', 'Pinned host keys', '', 'ssh fingerprint untrust'],
  ['clusters', 'trust', 'Pinned certificates', '', 'tls certificate pin forget'],
  ['accounts', 'accounts', 'ElasticPro users', '', 'people roles sign in'],
  ['accounts', 'accounts', 'Cluster users', '', 'elasticsearch users'],
  ['accounts', 'accounts', 'API tokens', '', 'token'],
  ['zabbix', 'zabbix', 'Zabbix URL', 'zl-zurl', 'connection frontend'],
  ['zabbix', 'zabbix', 'API URL', 'zl-api', 'api_jsonrpc'],
  ['zabbix', 'zabbix', 'API token', 'zl-token', 'zabbix token'],
  ['zabbix', 'zabbix', 'Sync interval', 'zl-sync', 'zabbix seconds'],
  ['zabbix', 'zabbix', 'Allowed sources', 'zl-src', 'cidr sso pair'],
  ['zabbix', 'zabbix', 'Verify the Zabbix TLS certificate', 'zl-tls', 'tls'],
  ['zabbix', 'zabbix', 'Pair with Zabbix', '', 'pairing code unpair'],
  ['zabbix', 'zabbix', 'Use ElasticPro credentials for Zabbix clusters', 'zo-useElasticProCredentials', 'vault sync option'],
  ['zabbix', 'zabbix', 'Create Zabbix hosts from this config', 'zo-createHosts', 'sync option template'],
  ['zabbix', 'zabbix', 'Cluster hosts', '', 'zabbix hosts template user groups'],
  ['alerts', 'triggers', 'Alert triggers', '', 'rules switch off thresholds'],
  ['alerts', 'automation', 'Automation rules', '', 'write your own rule'],
  ['requests', 'policy', 'Request policy presets', '', 'client basis automatic background hybrid'],
  ['requests', 'policy', 'Mode', 'pol-mode', 'request policy on-demand'],
  ['requests', 'policy', 'Watch window', 'pol-watch', 'minutes fine-tune'],
  ['requests', 'policy', 'Concurrency — all clusters', 'pol-global', 'fine-tune'],
  ['requests', 'policy', 'Per cluster concurrency', 'pol-per', 'fine-tune'],
  ['requests', 'policy', 'Per jump host concurrency', 'pol-tunnel', 'fine-tune'],
  ['requests', 'policy', 'Request timeout (ms)', 'pol-timeout', 'fine-tune'],
  ['requests', 'policy', 'Dataset intervals', 'pol-iv-health', 'every seconds fine-tune'],
  ['requests', 'policy', 'Minimum gap (duplicate requests)', 'pol-gap', 'seconds'],
  ['requests', 'policy', 'While Play runs', 'pol-play-health', 'tv display intervals'],
  ['requests', 'centre', 'Request Centre', '', 'request log'],
  ['requests', 'centre', 'Emergency stop', '', 'pause resume'],
  ['requests', 'centre', 'ElasticPro health', '', 'memory cpu'],
  ['reports', 'fields', 'Index pattern', 'vf-pattern', 'which indices count volume logstash'],
  ['reports', 'fields', 'Which day a document counts on', '', 'day from index name time field'],
  ['reports', 'fields', 'Volume time field', 'vf-time', '@timestamp'],
  ['reports', 'fields', 'Volume fields', '', 'fields tried ecs override'],
  ['reports', 'fields', 'Index name format', 'vf-index', 'older'],
  ['reports', 'fields', 'Tag field', 'vf-tag', 'volume'],
  ['reports', 'fields', 'Forwarder tag field', 'vf-forwarder', 'volume'],
  ['reports', 'fields', 'Source host field', 'vf-sourceHost', 'volume'],
  ['reports', 'fields', 'Source IP field', 'vf-sourceIp', 'volume'],
  ['reports', 'fields', 'Event size field', 'vf-eventSize', 'event_logsize volume'],
  ['reports', 'fields', 'Sub size field', 'vf-subSize', 'volume'],
  ['reports', 'fields', 'Extra field', 'vf-extra-name', 'dataset volume'],
  ['reports', 'fields', 'Size that counts as volume', 'vf-basis', 'primary total'],
  ['reports', 'fields', 'Top values kept per field', 'vf-top', 'volume'],
  ['reports', 'fields', 'Keep the daily record for (months)', 'vf-keep', 'volume retention'],
  ['reports', 'fields', 'Collect once a day at', 'vf-at', 'volume time'],
  ['reports', 'fields', 'Volume by host and Indices report', '', 'config.txt hosts client id'],
  ['reports', 'mail', 'Volume report by mail', 'rm-enabled', 'xlsx schedule'],
  ['reports', 'mail', 'Send to', 'rm-to', 'mail recipients cc bcc'],
  ['reports', 'mail', 'When the report is mailed', 'rm-when', 'monthly weekly daily'],
  ['reports', 'mail', 'Mail subject', 'rm-subject', 'period'],
  ['reports', 'mail', 'Send report now', '', 'mail'],
  ['reports', 'mail', 'Mail server (SMTP)', 'ms-host', 'smtp host'],
  ['reports', 'mail', 'SMTP port', 'ms-port', 'mail'],
  ['reports', 'mail', 'SMTP security', 'ms-security', 'starttls tls'],
  ['reports', 'mail', 'SMTP password', 'ms-password', 'mail sign in'],
  ['reports', 'mail', 'From address', 'ms-from', 'mail sender'],
  ['reports', 'mail', 'Send a test mail', '', 'smtp'],
  ['reports', 'templates', 'Plan templates', '', 'planning roles sizing'],
  ['reports', 'templates', 'Sizing rules', '', 'planning'],
  ['data', 'backend', 'History store', 'hs-url', 'elasticsearch backend history'],
  ['data', 'backend', 'History index prefix', 'hs-prefix', 'elasticsearch'],
  ['data', 'backend', 'Write history', 'hs-arm', 'history store writes'],
  ['data', 'backend', 'Copy existing history', '', 'backfill'],
  ['data', 'schedule', 'Scheduled log delay', 'sink-enabled', 'timer measurement'],
  ['data', 'schedule', 'Log delay destination', 'sink-destination', 'history cluster'],
  ['data', 'schedule', 'Every (hours)', 'sink-everyHours', 'log delay'],
  ['data', 'schedule', 'Max devices per run', 'sink-maxDevices', 'log delay'],
  ['play', 'play', 'Display links', '', 'tv new display link revoke'],
  ['play', 'play', 'Watch rules', 'pl-yellow', 'delay colours spotlight'],
  ['play', 'play', 'Excluded clusters', '', 'leave out of play'],
  ['system', 'defaults', 'Read-only', 'ce-ro', 'write protection defaults'],
  ['system', 'defaults', 'Auto-refresh', 'ce-ar', 'defaults'],
  ['system', 'defaults', 'Refresh every (s)', 'ce-ri', 'defaults interval'],
  ['system', 'defaults', 'Disk warn %', 'ce-dw', 'defaults disk'],
  ['system', 'defaults', 'Disk critical %', 'ce-dc', 'defaults disk'],
  ['system', 'defaults', 'Snapshot stale (h)', 'ce-ss', 'defaults'],
  ['system', 'defaults', 'Log index pattern', 'ce-lp', 'defaults logstash'],
  ['system', 'defaults', 'Time field', 'ce-tf', 'defaults @timestamp'],
  ['system', 'defaults', 'Certificates', 'ce-dtls', 'tls insecure defaults'],
  ['system', 'defaults', 'Live redraw', 'ce-lr', 'defaults pending'],
  ['system', 'defaults', 'Opens on', 'ce-ds', 'defaults scope'],
  ['system', 'defaults', 'Request timeout (ms)', 'ce-to', 'defaults'],
  ['system', 'file', 'Config file', '', 'reload upload path format'],
  ['system', 'file', 'Earlier versions', '', 'history load this'],
  ['system', 'file', 'Diagnostics', '', 'write protection enforced app version routes'],
  ['system', 'file', 'Forget file & credentials', '', 'danger'],
]);

/** Rows added when the core knows the Zabbix group map (docs/ROLES.md): the page appends them then, never before. */
export const ZABBIX_ROLES_INDEX = Object.freeze([
  ['zabbix', 'zabbix', 'ElasticPro roles from Zabbix user groups', '', 'role map admin operator user guest group chips add group none of these unmapped preview who changes'],
  ['zabbix', 'zabbix', 'Zabbix users', '', 'people role set by hand pinned reset no access last sign-in gone unverifiable lowered at sync'],
]);

/** Rows added when the core routes its records (PING dataRouting.supported): Data › Backend's table. */
export const DATA_ROUTING_INDEX = Object.freeze([
  ['data', 'backend', 'Where each kind of data goes', 'dr-mode-history', 'backend storage routing built-in elasticsearch copy kept in'],
  ['data', 'backend', 'History kept in', 'dr-mode-history', 'volume capacity log delay records built-in elasticsearch copy only'],
  ['data', 'backend', 'Reports kept in', 'dr-mode-reports', 'generated files job history built-in elasticsearch copy only'],
  ['data', 'backend', 'Alerts kept in', 'dr-mode-alerts', 'raised acknowledged silenced cleared built-in elasticsearch copy only'],
  ['data', 'backend', 'Carry the report file', 'dr-reportFiles', 'reports file 2 MB elasticsearch content'],
  ['data', 'backend', 'ElasticPro built-in', '', 'default data directory size free disk backed up'],
  ['data', 'backend', 'Elasticsearch cluster', 'hs-url', 'history store dedicated optional'],
]);

const norm = (s) => String(s || '').toLowerCase().replace(/[—–]/g, '-');

/**
 * The settings matching `query`, best first, among the visible tabs only: every word of the
 * query has to appear in the label, the page, the tab or the extra words. A label that starts
 * with the query ranks first, then one with a word that does, then the rest.
 *
 *   index    rows as SETTING_INDEX (default), plus any a page adds
 *   returns  [{page, tab, label, field, where}] — `where` is "Page › Tab" for the result list
 */
export function findSettings(query, visible, { index = SETTING_INDEX, limit = 8 } = {}) {
  const q = norm(query).trim();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const pages = new Map(visible.map((p) => [p.id, p]));
  const hits = [];
  for (const [pageId, tabId, label, field, extra] of index) {
    const page = pages.get(pageId);
    const tab = page && page.tabs.find((t) => t.id === tabId);
    if (!tab) continue;
    const l = norm(label);
    const hay = `${l} ${norm(page.label)} ${norm(tab.label)} ${norm(extra)}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const rank = l.startsWith(q) ? 0 : l.split(/[\s(/,]+/).some((w) => w.startsWith(words[0])) ? 1 : l.includes(words[0]) ? 2 : 3;
    hits.push({ rank, page: pageId, tab: tabId, label, field: field || '',
      where: page.tabs.length > 1 ? `${page.label} › ${tab.label}` : page.label });
  }
  hits.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const seen = new Set();
  return hits.filter((x) => { const k = `${x.page}/${x.tab}/${x.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}
