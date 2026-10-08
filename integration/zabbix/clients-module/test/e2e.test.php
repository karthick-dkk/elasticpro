<?php
/**
 * End-to-end scenarios for the Clients module, against a fake Zabbix API: connections, host and
 * client names, duplicates, disabled hosts, import/export, and data left behind by the rename.
 *   docker run --rm -v "$PWD":/m -w /m php:8.4-cli-alpine php test/e2e.test.php
 * Exit 0 when every check holds; each failure is printed. A PHP warning is a failure.
 *
 * test/spec.test.php covers the pure parts — the form's rules, the macros, the templates. This
 * file covers what only shows once Zabbix is in the picture: what Reconciler, Lifecycle,
 * ClientState, Backups and Importer do to an install that looks like the live one. The live one
 * is seven clients and some forty hosts that still carry the pre-rename names, which is why most
 * fixtures here are of that generation.
 *
 * The fake is \Zbx below. It is a store of hosts, templates, groups and macros plus the slice of
 * host.get that this module actually asks for, and it is deliberately strict in two ways:
 *   - a resource or method the module asks for and the fake does not know throws, rather than
 *     answering an empty array that would read as "there is nothing there";
 *   - a field is returned only when the call asked for it with the matching select*, because
 *     Reconciler::kindWithoutTemplates() keys off parentTemplates being absent and a fake that
 *     always answered it would hide the Zabbix-Admin case this file is partly about.
 * Nothing here talks to a real Zabbix, so none of it can touch item history.
 */
namespace {
	/*
	 * Zabbix's own constants, with Zabbix 7.0's values. The values matter: the module compares
	 * against them (INTERFACE_TYPE_AGENT on an interface, HOST_STATUS_NOT_MONITORED on a host),
	 * and a fake that invented its own numbers would agree with the module about nothing.
	 */
	foreach ([
		'ZBX_MACRO_TYPE_TEXT' => 0, 'ZBX_MACRO_TYPE_SECRET' => 1, 'ZBX_MACRO_TYPE_VAULT' => 2,
		'INTERFACE_TYPE_AGENT' => 1, 'INTERFACE_PRIMARY' => 1, 'INTERFACE_SECONDARY' => 0,
		'INTERFACE_USE_IP' => 1, 'INTERFACE_USE_DNS' => 0,
		'HOST_STATUS_MONITORED' => 0, 'HOST_STATUS_NOT_MONITORED' => 1,
		'HOST_INVENTORY_DISABLED' => -1, 'HOST_INVENTORY_MANUAL' => 0, 'HOST_INVENTORY_AUTOMATIC' => 1,
		'HOST_MAINTENANCE_STATUS_OFF' => 0,
		'TAG_OPERATOR_LIKE' => 0, 'TAG_OPERATOR_EQUAL' => 1,
		'TAG_EVAL_TYPE_AND_OR' => 0, 'TAG_EVAL_TYPE_OR' => 2,
		'ITEM_STATE_NORMAL' => 0, 'ITEM_STATE_NOTSUPPORTED' => 1,
		'ZBX_MONITORED_BY_SERVER' => 0, 'ZBX_MONITORED_BY_PROXY' => 1, 'ZBX_MONITORED_BY_PROXY_GROUP' => 2,
		'TRIGGER_VALUE_FALSE' => 0, 'TRIGGER_VALUE_TRUE' => 1,
		'USER_TYPE_ZABBIX_USER' => 1, 'USER_TYPE_ZABBIX_ADMIN' => 2, 'USER_TYPE_SUPER_ADMIN' => 3,
		'MEDIA_TYPE_EMAIL' => 0, 'MEDIA_TYPE_STATUS_ACTIVE' => 0, 'MEDIA_STATUS_ACTIVE' => 0,
		'GROUP_GUI_ACCESS_DISABLED' => 3, 'PERM_READ' => 2,
		'EVENT_SOURCE_TRIGGERS' => 0, 'ACTION_STATUS_ENABLED' => 0, 'ACTION_PAUSE_SUPPRESSED_TRUE' => 1,
		'CONDITION_EVAL_TYPE_AND_OR' => 0, 'ZBX_CONDITION_TYPE_HOST_GROUP' => 0, 'CONDITION_OPERATOR_EQUAL' => 0,
		'OPERATION_TYPE_MESSAGE' => 0, 'OPERATION_TYPE_RECOVERY_MESSAGE' => 11,
		'MAINTENANCE_TYPE_NORMAL' => 0, 'MAINTENANCE_TYPE_NODATA' => 1, 'TIMEPERIOD_TYPE_ONETIME' => 3,
		'ZBX_REPORT_PERIOD_WEEK' => 1, 'ZBX_REPORT_CYCLE_WEEKLY' => 1, 'ZBX_REPORT_STATUS_ENABLED' => 0,
		'ZBX_WIDGET_FIELD_TYPE_GROUP' => 2, 'ZBX_TM_TASK_CHECK_NOW' => 6
	] as $k => $v) { define($k, $v); }
	define('API_OUTPUT_COUNT', 'count');

	set_error_handler(function ($no, $msg, $file, $line) { throw new \ErrorException($msg, 0, $no, $file, $line); });
	function _($s) { return $s; }
	/**
	 * Both %N$s and %N$d, because some of the module's own messages use %1$d — the count of
	 * pre-rename macros that stopped a save is one — and a stub that only knew %N$s would leave
	 * the placeholder in the string, so a test asserting what the operator reads would fail for a
	 * reason that has nothing to do with the module.
	 */
	function _s($s, ...$a) {
		foreach ($a as $i => $v) {
			$s = str_replace(['%'.($i + 1).'$s', '%'.($i + 1).'$d'], (string) $v, $s);
		}
		return $s;
	}
	function _n($a, $b, $n) { return str_replace('%1$s', (string) $n, $n == 1 ? $a : $b); }

	/**
	 * Zabbix's own channel for "why the last call failed". Reconciler::api() and
	 * Lifecycle::api() read it after a call answered false, so the fake has to fill it: without
	 * it every refusal would read "no reason given" and the tests below could not tell a
	 * permission refusal from a constraint one.
	 */
	function get_and_clear_messages(): array {
		$out = array_map(fn($m) => ['message' => $m], \Zbx::$messages);
		\Zbx::$messages = [];
		return $out;
	}

	/** The fake Zabbix: its data, and the log of what was asked of it. */
	class Zbx {
		/** @var array hostid => record */
		public static $hosts = [];
		/** @var array templateid => ['host' => name, 'uuid' => string] */
		public static $templates = [];
		/** @var array groupid => name */
		public static $groups = [];
		/** @var array hostmacroid => ['hostid', 'macro', 'value', 'type'] */
		public static $macros = [];
		/** @var array name => ['proxyid' => id, 'lastaccess' => int] */
		public static $proxies = [];
		/** @var array name => ['proxy_groupid' => id, 'state' => int] */
		public static $proxyGroups = [];
		/** @var array every call made: [resource.method, params] */
		public static $calls = [];
		/** @var array every call that changed something */
		public static $wrote = [];
		/** @var array "Host.create" => the reason Zabbix gives for refusing it */
		public static $deny = [];
		/** @var string[] what get_and_clear_messages() will hand back */
		public static $messages = [];
		/** @var bool a read-only token: every write is refused, every read works */
		public static $readOnly = false;
		/**
		 * @var bool what a Zabbix Admin sees: hosts, but no templates at all. template.get
		 * answers an empty list and host.get shows no parentTemplates — the ambiguity the module
		 * must not read as "this install has no templates".
		 */
		public static $hideTemplates = false;
		/** @var int */
		public static $nextId = 1;

		public static function reset(): void {
			self::$hosts = []; self::$templates = []; self::$groups = []; self::$macros = [];
			self::$proxies = []; self::$proxyGroups = [];
			self::$calls = []; self::$wrote = []; self::$deny = []; self::$messages = [];
			self::$readOnly = false; self::$hideTemplates = false; self::$nextId = 1;
		}

		private static function id(): string {
			return (string) self::$nextId++;
		}

		public static function groupId(string $name): string {
			foreach (self::$groups as $id => $have) {
				if ($have === $name) { return (string) $id; }
			}
			$id = self::id();
			self::$groups[$id] = $name;
			return $id;
		}

		/** A template Zabbix holds. A host linked to one implies it exists, so addHost calls this too. */
		public static function addTemplate(string $name, string $uuid = ''): string {
			foreach (self::$templates as $id => $t) {
				if ($t['host'] === $name) {
					if ($uuid !== '') { self::$templates[$id]['uuid'] = $uuid; }
					return (string) $id;
				}
			}
			$id = self::id();
			self::$templates[$id] = ['host' => $name, 'uuid' => $uuid];
			return $id;
		}

		/**
		 * A host. 'macros' is macro => value or macro => [value, type]; it goes into the one
		 * macro store, so host.get's selectMacros and usermacro.get can never disagree about what
		 * a host carries — the disagreement Reconciler::hasStoredPassword() would be caught by.
		 */
		public static function addHost(array $f): string {
			$id = self::id();
			$h = [
				'hostid' => $id,
				'host' => (string) $f['host'],
				'name' => (string) ($f['name'] ?? $f['host']),
				'status' => (string) ($f['status'] ?? HOST_STATUS_MONITORED),
				'monitored_by' => (string) ($f['monitored_by'] ?? ZBX_MONITORED_BY_SERVER),
				'proxyid' => (string) ($f['proxyid'] ?? 0),
				'proxy_groupid' => (string) ($f['proxy_groupid'] ?? 0),
				'inventory_mode' => (string) ($f['inventory_mode'] ?? HOST_INVENTORY_DISABLED),
				'maintenance_status' => (string) HOST_MAINTENANCE_STATUS_OFF,
				'active_available' => '0',
				'hostgroups' => [],
				'parentTemplates' => [],
				'interfaces' => [],
				'tags' => [],
				'inventory' => ['notes' => (string) ($f['notes'] ?? '')]
			];
			foreach ((array) ($f['groups'] ?? []) as $g) {
				$h['hostgroups'][] = ['groupid' => self::groupId($g), 'name' => $g];
			}
			foreach ((array) ($f['templates'] ?? []) as $t) {
				$h['parentTemplates'][] = ['templateid' => self::addTemplate($t), 'host' => $t];
			}
			foreach ((array) ($f['tags'] ?? []) as $t) {
				$h['tags'][] = ['tag' => (string) $t['tag'], 'value' => (string) ($t['value'] ?? '')];
			}
			if (isset($f['ip'])) {
				$h['interfaces'][] = ['interfaceid' => self::id(), 'ip' => (string) $f['ip'], 'dns' => '',
					'type' => (string) INTERFACE_TYPE_AGENT, 'main' => (string) INTERFACE_PRIMARY,
					'available' => (string) ($f['available'] ?? 1)];
			}
			self::$hosts[$id] = $h;
			foreach ((array) ($f['macros'] ?? []) as $macro => $v) {
				self::addMacro($id, (string) $macro, is_array($v) ? (string) $v[0] : (string) $v, is_array($v) ? (int) $v[1] : 0);
			}
			return $id;
		}

		/** A Zabbix proxy, so a client monitored through one can be saved. */
		public static function addProxy(string $name, int $lastaccess = 0): string {
			$id = self::id();
			self::$proxies[$name] = ['proxyid' => $id, 'lastaccess' => $lastaccess];
			return $id;
		}

		public static function addMacro(string $hostid, string $macro, string $value, int $type = 0): string {
			$id = self::id();
			self::$macros[$id] = ['hostmacroid' => $id, 'hostid' => $hostid, 'macro' => $macro, 'value' => $value, 'type' => (string) $type];
			return $id;
		}

		/* ------------------------------ what the tests ask the fake ------------------------------ */

		/** A host by its technical name, or null. */
		public static function byHost(string $host): ?array {
			foreach (self::$hosts as $h) {
				if ($h['host'] === $host) { return $h; }
			}
			return null;
		}

		/** A host's macros as macro => value. */
		public static function macrosOf(string $hostid): array {
			$out = [];
			foreach (self::$macros as $m) {
				if ($m['hostid'] === $hostid) { $out[$m['macro']] = $m['value']; }
			}
			return $out;
		}

		/** A host's tags as "tag=value" strings, sorted — one comparable shape for the checks. */
		public static function tagsOf(string $hostid): array {
			$out = array_map(fn($t) => $t['tag'].'='.$t['value'], self::$hosts[$hostid]['tags'] ?? []);
			sort($out);
			return $out;
		}

		/** Every call of one kind, with its parameters. */
		public static function calls(string $key): array {
			return array_values(array_map(fn($c) => $c[1], array_filter(self::$calls, fn($c) => $c[0] === $key)));
		}

		/* ------------------------------ the API surface ------------------------------ */

		private static function vals($v): array {
			return array_map(fn($x) => (string) $x, is_array($v) ? array_values($v) : [$v]);
		}

		/** A host's templates as the caller would see them — none at all to a Zabbix Admin. */
		private static function shown(array $h): array {
			return self::$hideTemplates ? [] : $h['parentTemplates'];
		}

		private static function matchFilter(array $rec, array $filter): bool {
			foreach ($filter as $k => $v) {
				if (!in_array((string) ($rec[$k] ?? ''), self::vals($v), true)) { return false; }
			}
			return true;
		}

		private static function matchSearch(array $rec, array $search, bool $start): bool {
			foreach ($search as $k => $v) {
				$hay = strtolower((string) ($rec[$k] ?? ''));
				$needle = strtolower((string) $v);
				if ($start ? strpos($hay, $needle) !== 0 : strpos($hay, $needle) === false) { return false; }
			}
			return true;
		}

		/**
		 * host.get's tag filter. The default is "every tag given", which is what made the
		 * two-generation filter match nothing until Reconciler::kindFilter() started passing
		 * evaltype OR; both are implemented here so that mistake would fail a test again.
		 */
		private static function matchTags(array $rec, array $tags, int $evaltype): bool {
			$hits = 0;
			foreach ($tags as $want) {
				foreach ($rec['tags'] as $t) {
					if ($t['tag'] !== $want['tag']) { continue; }
					$v = (string) ($want['value'] ?? '');
					$eq = (int) ($want['operator'] ?? TAG_OPERATOR_LIKE) === TAG_OPERATOR_EQUAL;
					if ($eq ? $t['value'] === $v : ($v === '' || strpos($t['value'], $v) !== false)) { $hits++; break; }
				}
			}
			return $evaltype === TAG_EVAL_TYPE_OR ? $hits > 0 : $hits === count($tags);
		}

		public static function hostGet(array $p): array {
			$out = [];
			foreach (self::$hosts as $id => $h) {
				if (isset($p['hostids']) && !in_array((string) $id, self::vals($p['hostids']), true)) { continue; }
				if (isset($p['groupids']) && !array_intersect(self::vals($p['groupids']), array_column($h['hostgroups'], 'groupid'))) { continue; }
				if (isset($p['templateids']) && !array_intersect(self::vals($p['templateids']), array_column(self::shown($h), 'templateid'))) { continue; }
				if (isset($p['filter']) && !self::matchFilter($h, (array) $p['filter'])) { continue; }
				if (isset($p['search']) && !self::matchSearch($h, (array) $p['search'], !empty($p['startSearch']))) { continue; }
				if (isset($p['tags']) && !self::matchTags($h, (array) $p['tags'], (int) ($p['evaltype'] ?? TAG_EVAL_TYPE_AND_OR))) { continue; }
				// Only what the call asked for: see the note on $hideTemplates.
				$rec = ['hostid' => $h['hostid'], 'host' => $h['host'], 'name' => $h['name'], 'status' => $h['status'],
					'monitored_by' => $h['monitored_by'], 'proxyid' => $h['proxyid'], 'proxy_groupid' => $h['proxy_groupid'],
					'inventory_mode' => $h['inventory_mode'], 'maintenance_status' => $h['maintenance_status'],
					'active_available' => $h['active_available']];
				if (isset($p['selectHostGroups'])) { $rec['hostgroups'] = $h['hostgroups']; }
				if (isset($p['selectParentTemplates'])) { $rec['parentTemplates'] = self::shown($h); }
				if (isset($p['selectInterfaces'])) { $rec['interfaces'] = $h['interfaces']; }
				if (isset($p['selectTags'])) { $rec['tags'] = $h['tags']; }
				if (isset($p['selectInventory'])) { $rec['inventory'] = $h['inventory']; }
				if (isset($p['selectMacros'])) {
					$rec['macros'] = [];
					foreach (self::$macros as $m) {
						if ($m['hostid'] === $h['hostid']) { $rec['macros'][] = ['macro' => $m['macro'], 'type' => $m['type']]; }
					}
				}
				$out[(string) $id] = $rec;
			}
			if (isset($p['sortfield'])) {
				uasort($out, fn($a, $b) => strcmp((string) ($a[$p['sortfield']] ?? ''), (string) ($b[$p['sortfield']] ?? '')));
			}
			if (isset($p['limit'])) { $out = array_slice($out, 0, (int) $p['limit'], true); }
			return empty($p['preservekeys']) ? array_values($out) : $out;
		}

		public static function hostCreate(array $p): array {
			$f = ['host' => $p['host'], 'name' => $p['name'] ?? $p['host'], 'status' => $p['status'] ?? HOST_STATUS_MONITORED,
				'monitored_by' => $p['monitored_by'] ?? ZBX_MONITORED_BY_SERVER, 'proxyid' => $p['proxyid'] ?? 0,
				'proxy_groupid' => $p['proxy_groupid'] ?? 0, 'inventory_mode' => $p['inventory_mode'] ?? HOST_INVENTORY_DISABLED,
				'tags' => $p['tags'] ?? [], 'notes' => $p['inventory']['notes'] ?? ''];
			$f['groups'] = array_map(fn($g) => self::$groups[(string) $g['groupid']], (array) ($p['groups'] ?? []));
			$f['templates'] = array_map(fn($t) => self::$templates[(string) $t['templateid']]['host'], (array) ($p['templates'] ?? []));
			foreach ((array) ($p['interfaces'] ?? []) as $if) {
				if ((string) ($if['ip'] ?? '') !== '') { $f['ip'] = $if['ip']; }
			}
			return ['hostids' => [self::addHost($f)]];
		}

		public static function hostUpdate(array $p): array {
			$id = (string) $p['hostid'];
			foreach (['host', 'name', 'status', 'monitored_by', 'proxyid', 'proxy_groupid', 'inventory_mode'] as $k) {
				if (array_key_exists($k, $p)) { self::$hosts[$id][$k] = (string) $p[$k]; }
			}
			if (array_key_exists('tags', $p)) {
				self::$hosts[$id]['tags'] = array_values(array_map(fn($t) => ['tag' => (string) $t['tag'], 'value' => (string) ($t['value'] ?? '')], (array) $p['tags']));
			}
			if (array_key_exists('inventory', $p)) {
				self::$hosts[$id]['inventory'] = (array) $p['inventory'] + self::$hosts[$id]['inventory'];
			}
			return ['hostids' => [$id]];
		}

		public static function hostMassAdd(array $p): array {
			$ids = array_map(fn($h) => (string) $h['hostid'], (array) ($p['hosts'] ?? []));
			foreach ($ids as $id) {
				foreach ((array) ($p['templates'] ?? []) as $t) {
					$tid = (string) $t['templateid'];
					if (!in_array($tid, array_column(self::$hosts[$id]['parentTemplates'], 'templateid'), true)) {
						self::$hosts[$id]['parentTemplates'][] = ['templateid' => $tid, 'host' => self::$templates[$tid]['host']];
					}
				}
				foreach ((array) ($p['groups'] ?? []) as $g) {
					$gid = (string) $g['groupid'];
					if (!in_array($gid, array_column(self::$hosts[$id]['hostgroups'], 'groupid'), true)) {
						self::$hosts[$id]['hostgroups'][] = ['groupid' => $gid, 'name' => self::$groups[$gid]];
					}
				}
			}
			return ['hostids' => $ids];
		}

		public static function hostMassRemove(array $p): array {
			$ids = self::vals($p['hostids'] ?? []);
			$drop_t = array_merge(self::vals($p['templateids'] ?? []), self::vals($p['templateids_clear'] ?? []));
			$drop_g = self::vals($p['groupids'] ?? []);
			foreach ($ids as $id) {
				self::$hosts[$id]['parentTemplates'] = array_values(array_filter(self::$hosts[$id]['parentTemplates'],
					fn($t) => !in_array($t['templateid'], $drop_t, true)));
				self::$hosts[$id]['hostgroups'] = array_values(array_filter(self::$hosts[$id]['hostgroups'],
					fn($g) => !in_array($g['groupid'], $drop_g, true)));
			}
			return ['hostids' => $ids];
		}

		public static function hostDelete(array $ids): array {
			foreach (self::vals($ids) as $id) {
				unset(self::$hosts[$id]);
				foreach (self::$macros as $mid => $m) {
					if ($m['hostid'] === $id) { unset(self::$macros[$mid]); }
				}
			}
			return ['hostids' => self::vals($ids)];
		}

		public static function groupGet(array $p): array {
			$out = [];
			foreach (self::$groups as $id => $name) {
				$rec = ['groupid' => (string) $id, 'name' => $name, 'hosts' => 0];
				if (isset($p['filter']) && !self::matchFilter($rec, (array) $p['filter'])) { continue; }
				if (isset($p['groupids']) && !in_array((string) $id, self::vals($p['groupids']), true)) { continue; }
				foreach (self::$hosts as $h) {
					if (in_array((string) $id, array_column($h['hostgroups'], 'groupid'), true)) { $rec['hosts']++; }
				}
				$out[] = $rec;
			}
			return $out;
		}

		public static function groupCreate(array $p): array {
			$names = isset($p['name']) ? [$p['name']] : array_column((array) $p, 'name');
			return ['groupids' => array_map(fn($n) => self::groupId((string) $n), $names)];
		}

		public static function interfaceGet(array $p): array {
			$out = [];
			foreach (self::$hosts as $h) {
				foreach ($h['interfaces'] as $if) {
					$rec = ['interfaceid' => $if['interfaceid'], 'hostid' => $h['hostid'], 'ip' => $if['ip'], 'type' => $if['type']];
					if (isset($p['filter']) && !self::matchFilter($rec, (array) $p['filter'])) { continue; }
					if (isset($p['search']) && !self::matchSearch($rec, (array) $p['search'], !empty($p['startSearch']))) { continue; }
					$out[] = $rec;
				}
			}
			return isset($p['limit']) ? array_slice($out, 0, (int) $p['limit']) : $out;
		}

		public static function templateGet(array $p): array {
			if (self::$hideTemplates) { return []; }
			$out = [];
			foreach (self::$templates as $id => $t) {
				$rec = ['templateid' => (string) $id, 'host' => $t['host'], 'uuid' => $t['uuid']];
				if (isset($p['filter']) && !self::matchFilter($rec, (array) $p['filter'])) { continue; }
				// selectHosts, because the mapping table counts the hosts carrying each template
				// and a stub that always answered none would have passed a count that never works.
				if (isset($p['selectHosts'])) {
					$rec['hosts'] = [];
					foreach (self::$hosts as $hid => $h) {
						foreach ((array) ($h['parentTemplates'] ?? []) as $pt) {
							if ((string) ($pt['templateid'] ?? '') === (string) $id) { $rec['hosts'][] = ['hostid' => (string) $hid]; }
						}
					}
				}
				$out[] = $rec;
			}
			if (($p['sortfield'] ?? '') === 'host') { usort($out, fn($a, $b) => strcmp($a['host'], $b['host'])); }
			if (isset($p['limit'])) { $out = array_slice($out, 0, (int) $p['limit']); }
			return $out;
		}

		public static function macroGet(array $p): array {
			$out = [];
			foreach (self::$macros as $m) {
				if (isset($p['hostids']) && !in_array($m['hostid'], self::vals($p['hostids']), true)) { continue; }
				if (isset($p['filter']) && !self::matchFilter($m, (array) $p['filter'])) { continue; }
				$out[] = $m;
			}
			return $out;
		}

		public static function macroCreate(array $p): array {
			$list = isset($p['macro']) ? [$p] : array_values($p);
			$ids = [];
			foreach ($list as $m) {
				$ids[] = self::addMacro((string) $m['hostid'], (string) $m['macro'], (string) ($m['value'] ?? ''), (int) ($m['type'] ?? 0));
			}
			return ['hostmacroids' => $ids];
		}

		public static function macroUpdate(array $p): array {
			$list = isset($p['hostmacroid']) ? [$p] : array_values($p);
			foreach ($list as $m) {
				$id = (string) $m['hostmacroid'];
				foreach (['value', 'type'] as $k) {
					if (array_key_exists($k, $m)) { self::$macros[$id][$k] = (string) $m[$k]; }
				}
			}
			return ['hostmacroids' => array_map(fn($m) => (string) $m['hostmacroid'], $list)];
		}

		public static function proxyGet(array $p): array {
			$out = [];
			foreach (self::$proxies as $name => $px) {
				$rec = ['proxyid' => (string) $px['proxyid'], 'name' => $name, 'lastaccess' => (string) $px['lastaccess']];
				if (isset($p['filter']) && !self::matchFilter($rec, (array) $p['filter'])) { continue; }
				$out[] = $rec;
			}
			return $out;
		}

		public static function proxyGroupGet(array $p): array {
			$out = [];
			foreach (self::$proxyGroups as $name => $pg) {
				$rec = ['proxy_groupid' => (string) $pg['proxy_groupid'], 'name' => $name, 'state' => (string) $pg['state']];
				if (isset($p['filter']) && !self::matchFilter($rec, (array) $p['filter'])) { continue; }
				$out[] = $rec;
			}
			return $out;
		}
	}

	/** One Zabbix API resource. Every call is logged; a write is refused when the test says so. */
	class ZbxResource {
		/** @var string */
		private $res;

		public function __construct(string $res) {
			$this->res = $res;
		}

		public function __call(string $method, array $args) {
			$p = $args[0] ?? [];
			$key = $this->res.'.'.$method;
			\Zbx::$calls[] = [$key, $p];
			if ($method !== 'get') {
				if (\Zbx::$readOnly) {
					// The wording Zabbix itself uses, so a test can tell a permission refusal
					// from a constraint one by reading the message the operator would see.
					\Zbx::$messages[] = 'No permissions to call "'.lcfirst($this->res).'.'.$method.'".';
					return false;
				}
				if (isset(\Zbx::$deny[$key])) {
					\Zbx::$messages[] = \Zbx::$deny[$key];
					return false;
				}
				\Zbx::$wrote[] = $key;
			}
			switch ($key) {
				case 'Host.get': return \Zbx::hostGet((array) $p);
				case 'Host.create': return \Zbx::hostCreate((array) $p);
				case 'Host.update': return \Zbx::hostUpdate((array) $p);
				case 'Host.massAdd': return \Zbx::hostMassAdd((array) $p);
				case 'Host.massRemove': return \Zbx::hostMassRemove((array) $p);
				case 'Host.delete': return \Zbx::hostDelete((array) $p);
				case 'HostGroup.get': return \Zbx::groupGet((array) $p);
				case 'HostGroup.create': return \Zbx::groupCreate((array) $p);
				case 'HostInterface.get': return \Zbx::interfaceGet((array) $p);
				case 'Template.get': return \Zbx::templateGet((array) $p);
				case 'UserMacro.get': return \Zbx::macroGet((array) $p);
				case 'UserMacro.create': return \Zbx::macroCreate((array) $p);
				case 'UserMacro.update': return \Zbx::macroUpdate((array) $p);
				case 'Proxy.get': return \Zbx::proxyGet((array) $p);
				case 'ProxyGroup.get': return \Zbx::proxyGroupGet((array) $p);
				// Asked by SetupChecks on an install with no history yet. Empty is the honest
				// answer here and the module has to read it as "not measured yet", not "broken".
				case 'Item.get': return [];
				case 'Trigger.get': return [];
				case 'Task.create': return ['taskids' => []];
			}
			// Never an empty array for something the fake does not model: that is how a fake
			// starts passing tests for code it is not exercising.
			throw new \RuntimeException('the fake Zabbix was asked '.$key.', which it does not implement');
		}
	}

	class API {
		public static function __callStatic(string $name, array $args) {
			return new \ZbxResource($name);
		}
	}
}
namespace Modules\EpClients\Test {
	foreach (['Store', 'Roles', 'ColumnSettings', 'Forecast', 'ClientTypes', 'MasterTemplate', 'DevicesTemplate', 'JumpTemplate', 'ClusterTemplate', 'ClientSpec', 'Csv', 'Backups', 'Reconciler', 'Lifecycle', 'Registry', 'History', 'SetupChecks', 'AlertRouting', 'ClientState', 'Importer', 'TemplateInstaller', 'TemplateMap'] as $lib) {
		require __DIR__.'/../lib/'.$lib.'.php';
	}
	use Modules\EpClients\Lib\{AlertRouting, Backups, ClientSpec, ClientState, Csv, Importer, JumpTemplate, Lifecycle, MasterTemplate, Reconciler, Roles, SetupChecks, Store, TemplateInstaller, TemplateMap, ClusterTemplate, DevicesTemplate};

	$failed = 0; $passed = 0; $scene = '';
	function check(string $what, bool $ok, $detail = null): void {
		global $failed, $passed, $scene;
		if ($ok) { $passed++; return; }
		$failed++; echo "FAIL: ", $scene !== '' ? $scene.' — ' : '', $what, $detail !== null ? ' — '.json_encode($detail, JSON_UNESCAPED_SLASHES) : '', PHP_EOL;
	}
	$dir = sys_get_temp_dir().'/ep-e2e-'.getmypid();
	mkdir($dir);
	putenv('EP_DATA_DIR='.$dir);

	$roles = Roles::defaults();
	$spec = new ClientSpec($roles);
	$byId = Roles::byId($roles);

	/**
	 * Zabbix's limit on a host's technical and visible name, and on a template name. 128 is not
	 * invented here: Roles::templateNames() already refuses a template name longer than it.
	 */
	$ZBX_NAME_MAX = 128;
	/** Zabbix's limit on a username, which is what AlertRouting::userName() has to stay inside. */
	$ZBX_USERNAME_MAX = 100;

	/**
	 * Every template a save needs present — taken from the module's own definitions rather than
	 * written out here, so renaming a template cannot leave this fixture quietly wrong.
	 */
	$allTemplates = array_values(array_unique(array_merge([MasterTemplate::NAME], Reconciler::clusterTemplates(),
		Reconciler::jumpClusterTemplates(), [Reconciler::ULM_TEMPLATE, JumpTemplate::ULM_NAME, Reconciler::agentTemplate()])));

	$begin = function (string $name) use ($allTemplates): void {
		global $scene;
		$scene = $name;
		\Zbx::reset();
		foreach ($allTemplates as $t) { \Zbx::addTemplate($t); }
	};
	/** A Reconciler per scenario: it caches group ids, so one is never shared across fixtures. */
	$rec = fn() => new Reconciler($spec);
	$state = fn($r) => new ClientState($spec, $r);

	/** A form for client $name. Everything a save needs, nothing a scenario does not care about. */
	$form = function (string $name, array $over = []) use ($spec): array {
		return array_merge($spec->defaults(), [
			'name' => $name, 'type' => 'On-Prem', 'es_url' => 'https://es.'.strtolower($name).'.example:9243',
			'es_password_mode' => 'vault', 'es_password_path' => 'secret/elasticpro/'.strtolower($name).':password',
			'ulm_bucket' => '', 'ulm_region' => '', 'servers' => '[]',
			'es_data_hot_cpu' => '32', 'es_data_hot_mem' => '128', 'es_master_cpu' => '8'
		], $over);
	};
	$client = function (array $f) use ($spec): array {
		['client' => $c, 'errors' => $e] = $spec->fromForm($f);
		if ($e) { check('the fixture form is valid', false, $e); }
		return $c;
	};

	/* ======================================================================================
	 *  ZABBIX CONNECTION
	 * ====================================================================================== */

	/*
	 * The API answers every read and refuses every write: a token with read-only permissions, or
	 * a user whose role lost its write access since the page was opened. The page must not report
	 * a half-success, and must say which call Zabbix refused and what Zabbix said about it.
	 */
	$begin('read-only token');
	$gid = \Zbx::groupId('acme');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP],
		'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EP.CLIENT.TYPE}' => 'On-Prem']]);
	\Zbx::addHost(['host' => 'acme-ES-Cluster', 'groups' => ['acme', Reconciler::CLUSTER_GROUP],
		'templates' => [Roles::clusterTemplate()], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'cluster']]]);
	$r = $rec();
	$now = $r->current('acme');
	check('reads work: the master and cluster hosts are found', $now['master']['hostid'] === $masterid && $now['cluster'] !== null);
	check('reads work: the client is listed', array_keys($state($r)->clients()) === ['acme']);
	$c = $client($form('acme'));
	check('a read-only token is not something problems() can see — it asks Zabbix nothing it would refuse', $r->problems($c, $now) === [], $r->problems($c, $now));
	\Zbx::$readOnly = true;
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('the save stops at the first refused write', $said !== '');
	check('and names the call and quotes what Zabbix said', strpos($said, 'Zabbix would not') === 0 && strpos($said, 'No permissions to call') !== false, $said);
	check('the refusal is not reported as "no reason given"', strpos($said, 'no reason given') === false, $said);

	/*
	 * A Zabbix Admin may read hosts but not templates, so template.get answers an empty list and
	 * every host shows no parentTemplates. That is the same answer a Zabbix with no templates
	 * imported would give, and the two must not be confused: reading it as "there are no clients"
	 * is what showed an operator an empty Cluster Management page, and Backups::take() walks that
	 * same list.
	 */
	$begin('a Zabbix Admin sees hosts but no templates');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP],
		'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EP.CLIENT.TYPE}' => 'DI']]);
	\Zbx::addHost(['host' => 'acme-ES-Cluster', 'groups' => ['acme', Reconciler::CLUSTER_GROUP],
		'templates' => [Roles::clusterTemplate()], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'cluster']]]);
	\Zbx::addHost(['host' => 'acme-ULM', 'groups' => ['acme', Reconciler::ULM_GROUP],
		'templates' => [Reconciler::ULM_TEMPLATE], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'archive']]]);
	\Zbx::addHost(['host' => 'acme-ES-Data-Hot-1', 'ip' => '10.20.0.11', 'groups' => ['acme', 'ES Data Hot', 'ESNodes'],
		'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'server'],
			['tag' => 'ep-role', 'value' => 'es_data_hot']]]);
	\Zbx::$hideTemplates = true;
	$r = $rec();
	check('the module still answers when template.get is empty to it', Reconciler::masterHosts(['output' => ['hostid']]) !== []);
	check('the master host is still found, by its kind tag', count(Reconciler::masterHosts(['output' => ['hostid', 'host']])) === 1);
	$clients = $state($r)->clients();
	check('the client list is not empty — "no templates" is not "no clients"', array_keys($clients) === ['acme'], array_keys($clients));
	$now = $r->current('acme');
	check('master, cluster and archive hosts are told apart by their kind tags', ($now['master']['hostid'] ?? '') === $masterid
		&& ($now['cluster']['host'] ?? '') === 'acme-ES-Cluster' && ($now['ulm']['host'] ?? '') === 'acme-ULM');
	check('the server is recognised by its role group even with no template in sight', count($now['machines']) === 1
		&& array_values($now['machines'])[0]['_roles'] === ['es_data_hot']);
	check('kindWithoutTemplates answers only when there are no templates to go on',
		Reconciler::kindWithoutTemplates(['tags' => [['tag' => 'ep-kind', 'value' => 'master']]]) === 'master'
		&& Reconciler::kindWithoutTemplates(['tags' => [['tag' => 'ep-kind', 'value' => 'master']], 'parentTemplates' => [['host' => 'x']]]) === null);
	check('the guard that keeps one client out of another still has the client groups', $r->clientGroups() === ['acme'], $r->clientGroups());
	$c = $client($form('acme', ['type' => 'DI', 'ulm_bucket' => 'acme-archive', 'ulm_region' => 'ap-south-1']));
	$problems = $r->problems($c, $now);
	check('a save is refused, naming the templates it cannot see', (bool) preg_grep('/Nothing was saved\. These templates are not in Zabbix/', $problems), $problems);
	check('and the master template is among them, so the message is about reading, not about one missing import',
		(bool) preg_grep('/'.preg_quote(MasterTemplate::NAME, '/').'/', $problems));
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('nothing is written: the refusal comes before the first write', \Zbx::$wrote === [] && $said !== '', \Zbx::$wrote);
	// The live install's hosts carry the old spelling of the kind tag, so the fallback has to
	// answer to it too — this is the case the fallback was written for.
	\Zbx::$hosts[$masterid]['tags'] = [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-kind', 'value' => 'master'], ['tag' => 'evp-client', 'value' => 'acme']];
	check('the fallback reads the pre-rename kind tag as well', count(Reconciler::masterHosts(['output' => ['hostid', 'host']])) === 1);
	check('and the client is still listed', array_keys($state($rec())->clients()) === ['acme']);

	/*
	 * Zabbix refuses a write half way through a save. apply() has no transaction, so the client is
	 * left part-written; the point of problems() is that the refusals it can foresee never get
	 * that far. Both halves are asserted: what a refusal costs, and that the foreseeable one is
	 * caught before the first write.
	 */
	$begin('Zabbix refuses a write mid-apply');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP],
		'templates' => [MasterTemplate::NAME], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	$c = $client($form('acme'));
	$r = $rec();
	check('nothing foreseeable is wrong with this save', $r->problems($c, $r->current('acme')) === [], $r->problems($c, $r->current('acme')));
	\Zbx::$deny['Host.create'] = 'Host "acme-ES-Cluster" already exists.';
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('the save throws with what Zabbix said', strpos($said, 'create host') !== false && strpos($said, 'already exists') !== false, $said);
	check('the cluster host was not created', \Zbx::byHost('acme-ES-Cluster') === null);
	check('but the master host had already been written: it carries the client and status tags now',
		in_array('ep-client=acme', \Zbx::tagsOf($masterid), true) && in_array('ep-status=active', \Zbx::tagsOf($masterid), true), \Zbx::tagsOf($masterid));
	check('and its macros had already been written over', array_key_exists('{$EP.CLIENT.TYPE}', \Zbx::macrosOf($masterid)));
	check('so the client is left half-written — which is what problems() exists to prevent', \Zbx::$wrote !== []);
	// The same collision, this time visible to Zabbix before anything is written: a host already
	// has the name apply() would ask for. problems() has to refuse, and refuse before writing.
	$begin('a host already has the name the save would create');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP],
		'templates' => [MasterTemplate::NAME], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	\Zbx::addHost(['host' => 'acme-ES-Cluster', 'groups' => ['Discovered hosts'], 'templates' => []]);
	$r = $rec();
	$problems = $r->problems($c, $r->current('acme'));
	check('problems() names the host and says this page did not recognise it', (bool) preg_grep('/A host called "acme-ES-Cluster" already exists/', $problems), $problems);
	check('and tells the operator the tag that would fix it', (bool) preg_grep('/ep-kind: cluster/', $problems), $problems);
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('the save is refused before the first write', \Zbx::$wrote === [] && $said !== '', \Zbx::$wrote);

	/* ======================================================================================
	 *  HOSTNAMES
	 * ====================================================================================== */

	/*
	 * The field case: a host whose technical name is the machine's own FQDN and whose visible name
	 * is whatever an operator typed. Taking it on renames both, in one update, and keeps its
	 * history, templates and interface.
	 */
	/** A master host of today's generation, with nothing for a save to change on it. */
	$addMaster = function (string $cl): string {
		return \Zbx::addHost(['host' => $cl.'-Master', 'groups' => [$cl, Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'master'],
				['tag' => 'ep-status', 'value' => 'active']], 'macros' => ['{$GRP.CLIENT}' => $cl]]);
	};
	/** One of this page's server hosts, as it looks after a save. */
	$addServer = function (string $cl, array $f): string {
		return \Zbx::addHost($f + ['groups' => [$cl, 'ES Data Hot', 'ESNodes'], 'templates' => [Reconciler::agentTemplate()],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'server'],
				['tag' => 'ep-role', 'value' => 'es_data_hot'], ['tag' => 'ep-service', 'value' => 'es_data_hot'],
				['tag' => 'ep-status', 'value' => 'active']]]);
	};
	/** Every rename a save asked Zabbix for: a host.update that carries a technical name. */
	$renames = fn() => array_values(array_filter(\Zbx::calls('Host.update'), fn($p) => array_key_exists('host', $p)));

	$begin('a hostname that is not our name');
	$addMaster('acme');
	$fqdn = $addServer('acme', ['host' => 'vm-prod-17.acme.internal', 'name' => 'ES hot node (rack 4)', 'ip' => '10.20.0.11']);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.20.0.11', 'roles' => ['es_data_hot']]])]));
	$rr = $rec();
	$rr->apply($c);
	check('the host is renamed, technical and visible name together',
		\Zbx::$hosts[$fqdn]['host'] === 'acme-ES-Data-Hot-1' && \Zbx::$hosts[$fqdn]['name'] === 'acme-ES-Data-Hot-1',
		[\Zbx::$hosts[$fqdn]['host'], \Zbx::$hosts[$fqdn]['name']]);
	check('in one update, so there is no moment where the two names disagree', count($renames()) === 1, $renames());
	check('it is the same host: its interface and its id are untouched, so its history stays',
		\Zbx::$hosts[$fqdn]['interfaces'][0]['ip'] === '10.20.0.11' && \Zbx::$hosts[$fqdn]['hostid'] === $fqdn);
	check('and the save tells the operator what it renamed, by the name they knew it by',
		(bool) preg_grep('/Renamed "vm-prod-17\.acme\.internal" to "acme-ES-Data-Hot-1"/', $rr->done()), $rr->done());

	$begin('a host already named as we would name it');
	$addMaster('acme');
	$same = $addServer('acme', ['host' => 'acme-ES-Data-Hot-1', 'ip' => '10.20.0.11']);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.20.0.11', 'roles' => ['es_data_hot']]])]));
	$rec()->apply($c);
	check('it is not renamed at all', $renames() === [], $renames());
	check('and keeps the name it had', \Zbx::$hosts[$same]['host'] === 'acme-ES-Data-Hot-1' && \Zbx::$hosts[$same]['name'] === 'acme-ES-Data-Hot-1');

	/*
	 * The visible name already reads as ours and the technical name does not. The technical name
	 * is the one Zabbix item keys and host.create go by, so this host still has to be renamed —
	 * and the update has to set both, or the host ends up with two different names.
	 */
	$begin('only the visible name already matches');
	$addMaster('acme');
	$halfway = $addServer('acme', ['host' => 'vm-prod-19.acme.internal', 'name' => 'acme-ES-Data-Hot-1', 'ip' => '10.20.0.11']);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.20.0.11', 'roles' => ['es_data_hot']]])]));
	$rec()->apply($c);
	check('slotOf looks at the technical name, so this host has no number yet',
		ClientSpec::slotOf('vm-prod-19.acme.internal', 'acme', 'ES-Data-Hot') === null);
	check('it is renamed once, and both names are set', count($renames()) === 1
		&& \Zbx::$hosts[$halfway]['host'] === 'acme-ES-Data-Hot-1' && \Zbx::$hosts[$halfway]['name'] === 'acme-ES-Data-Hot-1', $renames());

	/*
	 * Numbers already in use. A host whose name follows the pattern keeps its number; the ones
	 * being taken on get the next free one, because asking Zabbix for a name a host already has
	 * is refused in the middle of the save.
	 */
	$begin('numbers already in use are not handed out twice');
	$addMaster('acme');
	$newcomer = $addServer('acme', ['host' => 'vm-prod-17.acme.internal', 'ip' => '10.20.0.11']);
	$numbered = $addServer('acme', ['host' => 'acme-ES-Data-Hot-2', 'ip' => '10.20.0.12']);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.20.0.11', 'roles' => ['es_data_hot']],
		['ip' => '10.20.0.12', 'roles' => ['es_data_hot']]])]));
	$rec()->apply($c);
	check('the numbered host keeps its number', \Zbx::$hosts[$numbered]['host'] === 'acme-ES-Data-Hot-2');
	check('the one taken on gets the next free number, not the first', \Zbx::$hosts[$newcomer]['host'] === 'acme-ES-Data-Hot-3',
		\Zbx::$hosts[$newcomer]['host']);
	check('so no two hosts share a technical name',
		count(array_unique(array_column(\Zbx::$hosts, 'host'))) === count(\Zbx::$hosts), array_column(\Zbx::$hosts, 'host'));

	/*
	 * Two clients each have a server whose hostname is the same string — a template-built VM name
	 * repeated per environment. They are different machines on different IPs, and both must be
	 * kept; the only thing that must not happen is one client taking the other's host on.
	 */
	$begin('two clients, one hostname');
	foreach (['acme', 'beta'] as $i => $cl) {
		\Zbx::addHost(['host' => $cl.'-Master', 'groups' => [$cl, Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'master'],
				['tag' => 'ep-status', 'value' => 'active']], 'macros' => ['{$GRP.CLIENT}' => $cl]]);
		\Zbx::addHost(['host' => $cl.'-Parser-1', 'name' => 'siem-parser-01', 'ip' => '10.'.(30 + $i).'.0.5',
			'groups' => [$cl, 'Parser', 'Parsers'], 'templates' => [Reconciler::agentTemplate()],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'server'],
				['tag' => 'ep-role', 'value' => 'parser']]]);
	}
	$r = $rec();
	check('each client sees its own server only', count($r->current('acme')['machines']) === 1 && count($rec()->current('beta')['machines']) === 1);
	check('both client groups are known, so neither host looks unowned', $r->clientGroups() === ['acme', 'beta'], $r->clientGroups());
	$taken = $rec()->outsiders('acme', ['10.31.0.5'])['taken'];
	check('beta\'s server is refused to acme by IP, and the message names the owner',
		isset($taken['10.31.0.5']) && $taken['10.31.0.5']['client'] === 'beta' && $taken['10.31.0.5']['name'] === 'siem-parser-01', $taken);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.30.0.5', 'roles' => ['parser']], ['ip' => '10.31.0.5', 'roles' => ['parser']]])]));
	$r = $rec();
	$problems = $r->problems($c, $r->current('acme'));
	check('and a save that lists it is refused, saying an IP belongs to one client only',
		(bool) preg_grep('/10\.31\.0\.5 is already "siem-parser-01", a server of client beta/', $problems), $problems);

	/*
	 * Names at and over the limits. The form caps a client name at 48 characters; the names built
	 * from it have to stay inside Zabbix's 128.
	 */
	$begin('names at the length limits');
	$n48 = str_repeat('a', 48);
	check('a 48-character client name is accepted', $spec->fromForm($form($n48, ['es_url' => '']))['errors'] === []);
	check('49 is refused, and the message says what is allowed',
		(bool) preg_grep('/may hold only/', $spec->fromForm($form(str_repeat('a', 49), ['es_url' => '']))['errors']));
	check('a client name of one character is accepted', $spec->fromForm($form('a', ['es_url' => '']))['errors'] === []);
	$wide = Roles::serverBase($roles, ['es_data_hot', 'es_coord', 'es_master', 'parser', 's3_parser']);
	check('so does a five-role server of one', strlen(ClientSpec::machineName($n48, $wide, 99)) <= $ZBX_NAME_MAX,
		[$wide, strlen(ClientSpec::machineName($n48, $wide, 99))]);
	// The widest name the shipped roles can produce: every role that may share a server, on one
	// server, numbered. A client name of 41 characters or fewer keeps even that inside 128.
	$everyRole = array_keys(array_filter($byId, fn($r) => empty($r['exclusive'])));
	$widest = Roles::serverBase($roles, $everyRole);
	check('a 41-character client name fits whatever roles one server holds',
		strlen(ClientSpec::machineName(str_repeat('a', 41), $widest, 99)) <= $ZBX_NAME_MAX,
		[$widest, strlen(ClientSpec::machineName(str_repeat('a', 41), $widest, 99))]);
	check('the widest base is built from every non-exclusive role, each family word written once',
		substr_count($widest, 'ES') === 1 && substr_count($widest, 'Forwarder') === 1, $widest);
	$tooLong = false;
	try { Roles::saveTemplateNames(['agent' => str_repeat('x', 129)]); } catch (\InvalidArgumentException $e) { $tooLong = true; }
	check('a template name over Zabbix 128 characters is refused rather than silently cut, and nothing is saved',
		$tooLong && Roles::templateNames()['agent'] === Roles::DEFAULT_TEMPLATE && !is_file($dir.'/templates.json'));

	/*
	 * Case and whitespace. A client name is trimmed before it is checked, because an operator
	 * pasting from a ticket brings the spaces with them; but case is never folded, because the
	 * host names are built from the name and Zabbix tells "ACME-Master" from "acme-Master".
	 */
	$begin('case and whitespace in names');
	/** The form's own verdict on a client name, with nothing else in the form to complain about. */
	$nameOf = fn(string $name) => $spec->fromForm($form($name, ['es_url' => '', 'es_password_path' => '']))['client']['name'];
	$err = fn(string $name) => $spec->fromForm($form($name, ['es_url' => '', 'es_password_path' => '']))['errors'];
	check('a name is trimmed before it is checked', $nameOf('  acme  ') === 'acme' && $err('  acme  ') === []);
	check('an inner space is still refused', (bool) preg_grep('/may hold only/', $err('acme eu')));
	check('a tab is refused too', (bool) preg_grep('/may hold only/', $err("acme\teu")));
	check('case is kept, not folded', $nameOf('ACME') === 'ACME' && $err('ACME') === []);
	check('a server name of another case does not count as ours',
		ClientSpec::slotOf('ACME-ES-Data-Hot-1', 'acme', 'ES-Data-Hot') === null
		&& ClientSpec::slotOf('acme-ES-Data-Hot-1', 'acme', 'ES-Data-Hot') === 1);
	check('nor does one whose base differs only in case', ClientSpec::slotOf('acme-es-data-hot-1', 'acme', 'ES-Data-Hot') === null);
	check('a slot number must be a positive integer', ClientSpec::slotOf('acme-Parser-0', 'acme', 'Parser') === null
		&& ClientSpec::slotOf('acme-Parser-01', 'acme', 'Parser') === 1 && ClientSpec::slotOf('acme-Parser-1x', 'acme', 'Parser') === null);

	/*
	 * A host whose technical name follows this page's pattern but which this page did not make:
	 * an operator built it by hand, or it is left over from a client that was removed. It must
	 * never be deleted, and its number must not be handed out again — host.create would be
	 * refused in the middle of a save.
	 */
	$begin('a host that looks like ours and is not');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'master'],
			['tag' => 'ep-status', 'value' => 'active']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	// In the client's group and in a family group, so current() sees it; no role group, no
	// managed-by marker: it is nobody's server.
	$lookalike = \Zbx::addHost(['host' => 'acme-Parser-3', 'ip' => '10.40.0.3', 'groups' => ['acme', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()], 'tags' => []]);
	$r = $rec();
	$now = $r->current('acme');
	check('it is read as a host with no role, not as a server', count($now['unassigned']) === 1
		&& $now['machines'][$lookalike]['_roles'] === []);
	check('isManaged says no', !Reconciler::isManaged($now['machines'][$lookalike]));
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.40.0.9', 'roles' => ['parser']]])]));
	check('a save that does not list its IP never plans to delete it', $r->plannedDeletes($c, $now) === [], $r->plannedDeletes($c, $now));
	$rr = $rec();
	$rr->apply($c);
	check('it is still there afterwards, under its own name', isset(\Zbx::$hosts[$lookalike]) && \Zbx::$hosts[$lookalike]['host'] === 'acme-Parser-3');
	check('and the save says why it was left alone', (bool) preg_grep('/has no role and is left as it is/', $rr->done()), $rr->done());
	check('its number was not handed out again: the new server is Parser-4', \Zbx::byHost('acme-Parser-4') !== null
		&& \Zbx::byHost('acme-Parser-4')['interfaces'][0]['ip'] === '10.40.0.9');

	/* ======================================================================================
	 *  CLIENT NAMES
	 * ====================================================================================== */

	$begin('what a client may be called');
	$err = fn(string $name) => $spec->fromForm($form($name, ['es_url' => '', 'es_password_path' => '']))['errors'];
	check('letters, digits, hyphen and underscore are allowed', $err('acme-eu_2') === [], $err('acme-eu_2'));
	check('a dot is refused: the name is a host-name part', (bool) preg_grep('/may hold only/', $err('acme.eu')));
	check('so is a slash, a colon and a brace', $err('acme/eu') !== [] && $err('acme:eu') !== [] && $err('acme{eu}') !== []);
	check('it may not start with a hyphen or an underscore', $err('-acme') !== [] && $err('_acme') !== []);
	check('unicode is refused', $err('acmé') !== [] && $err('アクメ') !== []);
	check('an empty name says why it is required', (bool) preg_grep('/its host group and every host are named after it/', $err('')));
	check('a name of only spaces is read as empty, not as a bad name', (bool) preg_grep('/is required/', $err('   ')));

	/*
	 * One client's name being the start of another's. Every match this page makes on a name has to
	 * be exact: "acme" must not claim "acme-eu"'s hosts, and the slot logic must not read
	 * "acme-eu-Parser-1" as acme's parser number 1 — renaming it would take it away from acme-eu.
	 */
	$begin('a client name that is a prefix of another');
	check('the client hosts never collide', ClientSpec::masterName('acme') !== ClientSpec::masterName('acme-eu')
		&& ClientSpec::clusterName('acme') !== ClientSpec::clusterName('acme-eu')
		&& ClientSpec::ulmName('acme') !== ClientSpec::ulmName('acme-eu'));
	check('slotOf cannot cross-match the two ways round',
		ClientSpec::slotOf('acme-eu-Parser-1', 'acme', 'Parser') === null
		&& ClientSpec::slotOf('acme-eu-Parser-1', 'acme-eu', 'Parser') === 1
		&& ClientSpec::slotOf('acme-Parser-1', 'acme-eu', 'Parser') === null);
	check('nor through the base: "Parser" is not "Parser-S3-Parser"',
		ClientSpec::slotOf('acme-Parser-S3-Parser-1', 'acme', 'Parser') === null);
	foreach (['acme', 'acme-eu'] as $i => $cl) {
		\Zbx::addHost(['host' => $cl.'-Master', 'groups' => [$cl, Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'master'],
				['tag' => 'ep-status', 'value' => 'active']], 'macros' => ['{$GRP.CLIENT}' => $cl]]);
		\Zbx::addHost(['host' => $cl.'-Parser-1', 'ip' => '10.5'.$i.'.0.1', 'groups' => [$cl, 'Parser', 'Parsers'],
			'templates' => [Reconciler::agentTemplate()],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => $cl], ['tag' => 'ep-kind', 'value' => 'server'],
				['tag' => 'ep-role', 'value' => 'parser'], ['tag' => 'ep-service', 'value' => 'parser'],
				['tag' => 'ep-status', 'value' => 'active']]]);
	}
	$clients = $state($rec())->clients();
	check('both are listed, each under its own name', array_keys($clients) === ['acme', 'acme-eu'], array_keys($clients));
	check('acme\'s group holds only acme\'s hosts', count($rec()->current('acme')['machines']) === 1
		&& count($rec()->current('acme-eu')['machines']) === 1);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.50.0.1', 'roles' => ['parser']]])]));
	$r = $rec();
	check('saving acme plans to delete nothing of acme-eu\'s', $r->plannedDeletes($c, $r->current('acme')) === []);
	$rr = $rec();
	$rr->apply($c);
	check('and acme-eu\'s parser keeps its name', \Zbx::byHost('acme-eu-Parser-1') !== null);
	check('the DL user names do not collide either', AlertRouting::userName('acme') !== AlertRouting::userName('acme-eu'));

	$begin('the DL account name');
	check('it is ep-dl- and the client name', AlertRouting::userName('acme') === 'ep-dl-acme');
	check('the pre-rename spelling is still recognised, and is asked for second',
		AlertRouting::userNames('acme') === ['ep-dl-acme', 'evp-dl-acme']);
	check('characters a username may not hold become one hyphen', AlertRouting::userName('acmé') === 'ep-dl-acm-'
		&& AlertRouting::userName('a  b') === 'ep-dl-a-b');
	check('dots, hyphens and underscores are kept', AlertRouting::userName('a.c-m_e') === 'ep-dl-a.c-m_e');
	$long = AlertRouting::userName(str_repeat('c', 200));
	check('the name is capped at 90 characters after the prefix', strlen($long) === 96 && strlen($long) <= $ZBX_USERNAME_MAX, strlen($long));
	check('a client name the form would accept is nowhere near the cap', strlen(AlertRouting::userName(str_repeat('a', 48))) === 54);
	check('two long names that differ only past the cap would collide, so the cap must stay above what the form allows',
		AlertRouting::userName(str_repeat('c', 95).'x') === AlertRouting::userName(str_repeat('c', 95).'y'));

	/* ======================================================================================
	 *  DUPLICATES
	 * ====================================================================================== */

	/*
	 * Several hosts on one IP: the usual cause is a host built by hand beside one this page made,
	 * or a VM rebuilt under a new name. A save must refuse until the operator says which way, and
	 * a merge must name every host it would delete before it deletes one.
	 */
	$begin('two hosts, one IP');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'master'],
			['tag' => 'ep-status', 'value' => 'active']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	$keep = \Zbx::addHost(['host' => 'acme-Parser-1', 'ip' => '10.60.0.7', 'groups' => ['acme', 'Parser', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'server'],
			['tag' => 'ep-role', 'value' => 'parser'], ['tag' => 'ep-service', 'value' => 'parser'], ['tag' => 'ep-status', 'value' => 'active']]]);
	$twin = \Zbx::addHost(['host' => 'acme-Parser-2', 'ip' => '10.60.0.7', 'groups' => ['acme', 'Parser', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'server'],
			['tag' => 'ep-role', 'value' => 'parser'], ['tag' => 'ep-service', 'value' => 'parser'], ['tag' => 'ep-status', 'value' => 'active']]]);
	$r = $rec();
	$now = $r->current('acme');
	check('the shared IP is reported, oldest host first', array_keys($now['shared']) === ['10.60.0.7']
		&& array_column($now['shared']['10.60.0.7'], 'hostid') === [$keep, $twin]);
	$servers = json_encode([['ip' => '10.60.0.7', 'roles' => ['parser']]]);
	$c = $client($form('acme', ['es_url' => '', 'servers' => $servers]));
	$problems = $r->problems($c, $now);
	check('without the merge tick the save is refused, naming both hosts',
		(bool) preg_grep('/2 hosts share 10\.60\.0\.7 \("acme-Parser-1", "acme-Parser-2"\)/', $problems), $problems);
	check('and nothing is planned for deletion while it is refused', $r->plannedDeletes($c, $now) === [], $r->plannedDeletes($c, $now));
	$merged = $client($form('acme', ['es_url' => '', 'servers' => $servers, 'merge' => '10.60.0.7']));
	check('with the tick the save is allowed', $rec()->problems($merged, $rec()->current('acme')) === []);
	check('and names the host it will delete: all but the first', $rec()->plannedDeletes($merged, $rec()->current('acme')) === [$twin => 'acme-Parser-2']);
	$rr = $rec();
	$rr->apply($merged);
	check('after the merge the oldest host is the one left, with its history', isset(\Zbx::$hosts[$keep]) && !isset(\Zbx::$hosts[$twin]));
	// A duplicate an operator built by hand is not this page's to delete, tick or no tick.
	$begin('a hand-made host shares the IP');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	\Zbx::addHost(['host' => 'acme-Parser-1', 'ip' => '10.60.0.7', 'groups' => ['acme', 'Parser', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-role', 'value' => 'parser']]]);
	\Zbx::addHost(['host' => 'parser-by-hand', 'ip' => '10.60.0.7', 'groups' => ['acme', 'Parser', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()], 'tags' => []]);
	$r = $rec();
	$problems = $r->problems($merged, $r->current('acme'));
	check('the merge is refused, and says to remove it by hand first',
		(bool) preg_grep('/"parser-by-hand" shares 10\.60\.0\.7 but was made by hand/', $problems), $problems);
	check('it is never in the planned deletions', $rec()->plannedDeletes($merged, $rec()->current('acme')) === [],
		$rec()->plannedDeletes($merged, $rec()->current('acme')));

	/*
	 * A visible name a host in another client already carries. Zabbix refuses a collision on
	 * either name, so nameClashes() asks about both — a clash found only on the visible name is
	 * still a save that would fail half way through.
	 */
	$begin('a duplicate visible name across clients');
	\Zbx::addHost(['host' => 'beta-Master', 'groups' => ['beta', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']], 'macros' => ['{$GRP.CLIENT}' => 'beta']]);
	// A beta host whose visible name is the name acme's master host would be created under.
	\Zbx::addHost(['host' => 'beta-old-box', 'name' => 'acme-Master', 'groups' => ['beta'], 'templates' => []]);
	$c = $client($form('acme', ['es_url' => '']));
	$r = $rec();
	$problems = $r->problems($c, $r->current('acme'));
	check('the clash is found by the visible name', (bool) preg_grep('/A host called "beta-old-box" already exists/', $problems), $problems);
	check('and it is named as the master host of acme', (bool) preg_grep('/the master host of client "acme"/', $problems), $problems);
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('so nothing is written', \Zbx::$wrote === [] && $said !== '', \Zbx::$wrote);

	/*
	 * The twin case: one logical object carrying both generations of a name at once, which is what
	 * a migration stopped half way leaves behind. Nothing may be counted twice, and today's value
	 * wins wherever the two disagree.
	 */
	$begin('one object under both the old and the new name');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP, Reconciler::LEGACY_MASTERS_GROUP],
		'templates' => [MasterTemplate::NAME, MasterTemplate::LEGACY_NAME],
		'tags' => [Reconciler::MANAGED, Reconciler::LEGACY_MANAGED, ['tag' => 'ep-kind', 'value' => 'master'],
			['tag' => 'evp-kind', 'value' => 'master'], ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'evp-client', 'value' => 'acme']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EP.CLIENT.TYPE}' => 'DI', '{$EVP.CLIENT.TYPE}' => 'On-Prem']]);
	check('the master host is listed once, not twice', count(Reconciler::masterHosts(['output' => ['hostid']])) === 1);
	check('the client is listed once', array_keys($state($rec())->clients()) === ['acme']);
	$r = $rec();
	$now = $r->current('acme');
	check('current() picks one master host', $now['master']['hostid'] === $masterid);
	check('the two spellings of a tag are read as one value, not two',
		Reconciler::tagValues($now['master'], 'ep-client') === ['acme']);
	check('the masters\' group is not read as a client of its own', $r->clientGroups() === ['acme'], $r->clientGroups());
	check('where both generations of a macro disagree, today\'s wins',
		ClientSpec::canonicalMacros(\Zbx::macrosOf($masterid))['{$EP.CLIENT.TYPE}'] === 'DI'
		&& ClientSpec::macroOf(\Zbx::macrosOf($masterid), '{$EP.CLIENT.TYPE}') === 'DI');
	check('and AlertRouting reads it the same way — the two must keep agreeing',
		AlertRouting::canonical(\Zbx::macrosOf($masterid))['{$EP.CLIENT.TYPE}'] === 'DI');
	check('the form opens on today\'s value', $state($rec())->formFor('acme')['type'] === 'DI');
	// Both spellings of the Elasticsearch template name, where a site pointed the Roles page at
	// the old one: it is one name, and must be filtered on once.

	/* ======================================================================================
	 *  DISABLED HOSTS
	 * ====================================================================================== */

	/*
	 * A host an operator switched off. It is still offered when a server is added — leaving it out
	 * would have the sheet say "not in Zabbix, it will be created" and then adopt that very host —
	 * and adoption must not switch it on behind their back.
	 */
	$begin('adopting a host that is Not monitored');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master'], ['tag' => 'ep-status', 'value' => 'active']],
		'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	$off = \Zbx::addHost(['host' => 'spare-vm-04', 'ip' => '10.70.0.4', 'status' => HOST_STATUS_NOT_MONITORED,
		'groups' => ['Discovered hosts'], 'templates' => [Reconciler::agentTemplate()], 'tags' => []]);
	$free = $rec()->outsiders('acme', ['10.70.0.4'])['free'];
	check('a Not monitored host is still offered as free to take on', isset($free['10.70.0.4'][$off]));
	check('and its status comes back, so the sheet can show it',
		(int) \Zbx::hostGet(['hostids' => [$off]])[0]['status'] === HOST_STATUS_NOT_MONITORED);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.70.0.4', 'roles' => ['parser']]])]));
	$rr = $rec();
	$rr->apply($c);
	check('it was taken on, renamed, and the save says its history stays',
		\Zbx::$hosts[$off]['host'] === 'acme-Parser-1' && (bool) preg_grep('/Took on the existing host/', $rr->done()), $rr->done());
	check('adoption did not switch it on', (int) \Zbx::$hosts[$off]['status'] === HOST_STATUS_NOT_MONITORED);
	check('no update of it asked for a status at all',
		array_filter(\Zbx::calls('Host.update'), fn($p) => (string) $p['hostid'] === $off && array_key_exists('status', $p)) === []);
	$checks = SetupChecks::forClients(['acme' => $rec()->current('acme')], ['acme' => \Zbx::macrosOf(\Zbx::byHost('acme-Master')['hostid'])]);
	$labels = array_column($checks['acme'], 0);
	check('and the client list says so rather than blaming the agent',
		in_array('Servers are monitored', $labels, true), $labels);
	$monitored = array_values(array_filter($checks['acme'], fn($ck) => $ck[0] === 'Servers are monitored'));
	check('the check fails and names the host', $monitored !== [] && $monitored[0][1] === false
		&& strpos($monitored[0][2], 'acme-Parser-1') !== false, $monitored);
	check('and it is not asked of a client that is disabled, where every host being off is the point',
		!in_array('Servers are monitored', array_column(SetupChecks::forClients(['acme' => $rec()->current('acme')],
			['acme' => [Lifecycle::MACRO => 'disabled']])['acme'], 0), true));

	/*
	 * A client disabled before the rename. Its status is under the pre-rename macro name, and if
	 * that is not read the client shows as active: Enable would refuse it, Disable would try to
	 * disable it again, and AlertRouting would keep alerting on a client that was switched off.
	 */
	$begin('a client disabled before the rename');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'status' => HOST_STATUS_NOT_MONITORED,
		'groups' => ['acme', Reconciler::LEGACY_MASTERS_GROUP], 'templates' => [MasterTemplate::LEGACY_NAME],
		'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-kind', 'value' => 'master'], ['tag' => 'evp-status', 'value' => 'disabled']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EVP.CLIENT.STATUS}' => 'disabled']]);
	$onBefore = \Zbx::addHost(['host' => 'acme-Parser-1', 'ip' => '10.80.0.1', 'status' => HOST_STATUS_NOT_MONITORED,
		'groups' => ['acme', 'Parser', 'Parsers'], 'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-role', 'value' => 'parser'], ['tag' => 'evp-status', 'value' => 'disabled']]]);
	// The one an operator had deliberately left off before the client was disabled, marked under
	// the old spelling. Enable() must leave exactly this one off.
	$offBefore = \Zbx::addHost(['host' => 'acme-Parser-2', 'ip' => '10.80.0.2', 'status' => HOST_STATUS_NOT_MONITORED,
		'groups' => ['acme', 'Parser', 'Parsers'], 'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-role', 'value' => 'parser'], ['tag' => 'evp-status', 'value' => 'disabled'],
			['tag' => 'evp-was-off', 'value' => '1']]]);
	check('the legacy macro is read as a status', Lifecycle::statusOf(\Zbx::macrosOf($masterid)) === 'disabled');
	check('an empty macro of today does not mask it',
		Lifecycle::statusOf(['{$EP.CLIENT.STATUS}' => '', '{$EVP.CLIENT.STATUS}' => 'decommissioned']) === 'decommissioned');
	check('nor does an unrecognised one',
		Lifecycle::statusOf(['{$EP.CLIENT.STATUS}' => 'paused', '{$EVP.CLIENT.STATUS}' => 'disabled']) === 'disabled');
	check('where both are recognised, today\'s wins',
		Lifecycle::statusOf(['{$EP.CLIENT.STATUS}' => 'active', '{$EVP.CLIENT.STATUS}' => 'disabled']) === 'active');
	$life = new Lifecycle($rec());
	check('the page reads it as disabled', $life->status('acme') === 'disabled');
	$life->enable('acme');
	check('enabling switches on the host that was on before', (int) \Zbx::$hosts[$onBefore]['status'] === HOST_STATUS_MONITORED);
	check('and leaves off the one an operator had left off, marked under the old name',
		(int) \Zbx::$hosts[$offBefore]['status'] === HOST_STATUS_NOT_MONITORED);
	check('the status is written under today\'s macro name', \Zbx::macrosOf($masterid)['{$EP.CLIENT.STATUS}'] === 'active');
	check('and the stale one is left where it is, because deleting a macro cannot be undone',
		\Zbx::macrosOf($masterid)['{$EVP.CLIENT.STATUS}'] === 'disabled');
	check('every host carries today\'s status tag and neither spelling twice',
		\Zbx::tagsOf($onBefore) === ['ep-status=active', 'evp-role=parser', 'managed-by=elasticvue-clients'], \Zbx::tagsOf($onBefore));
	// The marker is spent once it has been read: the next disable records the state as it is then,
	// and a leftover marker under either spelling would keep this host off for good.
	check('the was-off marker is taken off once it has been honoured, under the old spelling too',
		!preg_grep('/was-off/', \Zbx::tagsOf($offBefore)), \Zbx::tagsOf($offBefore));
	check('and the host it belonged to still reads as active, not as something half-enabled',
		in_array('ep-status=active', \Zbx::tagsOf($offBefore), true), \Zbx::tagsOf($offBefore));

	/*
	 * Disable then enable, within one generation: the record of which hosts were already off is
	 * what makes the pair safe to repeat.
	 */
	$begin('disable then enable leaves the already-off hosts off');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	$on = \Zbx::addHost(['host' => 'acme-Parser-1', 'ip' => '10.90.0.1', 'groups' => ['acme', 'Parser', 'Parsers'],
		'templates' => [Reconciler::agentTemplate()], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-role', 'value' => 'parser']]]);
	$wasOff = \Zbx::addHost(['host' => 'acme-Parser-2', 'ip' => '10.90.0.2', 'status' => HOST_STATUS_NOT_MONITORED,
		'groups' => ['acme', 'Parser', 'Parsers'], 'templates' => [Reconciler::agentTemplate()],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-role', 'value' => 'parser']]]);
	$life = new Lifecycle($rec());
	$life->disable('acme');
	check('every host is Not monitored', (int) \Zbx::$hosts[$on]['status'] === HOST_STATUS_NOT_MONITORED
		&& (int) \Zbx::$hosts[$masterid]['status'] === HOST_STATUS_NOT_MONITORED);
	check('the one that was already off is marked as such', in_array('ep-was-off=1', \Zbx::tagsOf($wasOff), true), \Zbx::tagsOf($wasOff));
	check('the one that was on is not', !in_array('ep-was-off=1', \Zbx::tagsOf($on), true), \Zbx::tagsOf($on));
	check('the count reported is of hosts actually switched off', (bool) preg_grep('/2 hosts set to Not monitored/', $life->done()), $life->done());
	$life2 = new Lifecycle($rec());
	$life2->enable('acme');
	check('enable puts back only what it switched off', (int) \Zbx::$hosts[$on]['status'] === HOST_STATUS_MONITORED
		&& (int) \Zbx::$hosts[$wasOff]['status'] === HOST_STATUS_NOT_MONITORED);
	check('decommission and restore move between two disabled states and keep the marker',
		(function () use ($rec, $wasOff) {
			$l = new Lifecycle($rec());
			$l->disable('acme');
			(new Lifecycle($rec()))->decommission('acme');
			$kept = in_array('ep-was-off=1', \Zbx::tagsOf($wasOff), true) && (new Lifecycle($rec()))->status('acme') === 'decommissioned';
			(new Lifecycle($rec()))->restore('acme');
			return $kept && (new Lifecycle($rec()))->status('acme') === 'disabled' && in_array('ep-was-off=1', \Zbx::tagsOf($wasOff), true);
		})());
	check('a save of a disabled client does not strip the was-off marker',
		(function () use ($rec, $spec, $client, $form, $wasOff) {
			$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.90.0.1', 'roles' => ['parser']], ['ip' => '10.90.0.2', 'roles' => ['parser']]])]));
			$rr = $rec();
			$rr->apply($c);
			return in_array('ep-was-off=1', \Zbx::tagsOf($wasOff), true) && in_array('ep-status=disabled', \Zbx::tagsOf($wasOff), true);
		})(), \Zbx::tagsOf($wasOff));

	/* ======================================================================================
	 *  IMPORT / EXPORT
	 * ====================================================================================== */

	/*
	 * Export then import has to be a round trip, or an operator who exports to edit one column
	 * silently changes every other one.
	 */
	$begin('CSV round trip');
	$servers = [['ip' => '10.100.0.11', 'roles' => ['es_data_hot'], 'services' => ['nginx'], 'notes' => 'rack 4', 'attrs' => ['rack' => 'R4']],
		['ip' => '10.100.0.12', 'roles' => ['parser', 's3_parser'], 'services' => [], 'notes' => '', 'attrs' => []]];
	$original = $form('acme', ['type' => 'DI', 'ulm_bucket' => 'acme-archive', 'ulm_region' => 'ap-south-1',
		'lead_name' => 'Asha Rao', 'cluster_dl' => 'soc-acme@corp.example', 'contract_end' => '2027-03-31',
		'servers' => $spec->canonServers($servers), 'purchased_by' => 'storage', 'purchased' => '40960']);
	$before = $client($original);
	$csv = Csv::export($roles, [$original]);
	$parsed = Csv::parse($csv, $roles);
	check('the export parses with no errors and no unknown columns', $parsed['errors'] === [] && $parsed['ignored'] === [], [$parsed['errors'], $parsed['ignored']]);
	check('one row, and its client column is the name', count($parsed['rows']) === 1 && $parsed['rows'][0]['client'] === 'acme');
	$backForm = Csv::toForm($parsed['rows'][0], $spec->defaults(), $roles);
	// array_merge, not +: $backForm already carries a 'servers' key from the defaults, and + keeps
	// the left-hand value, so the servers would silently stay empty and the comparison below
	// would pass while comparing the wrong thing.
	$after = $client(array_merge($backForm, ['servers' => $original['servers']]));
	check('every settings field survives the round trip', $before['fields'] === $after['fields'],
		array_diff_assoc($before['fields'], $after['fields']));
	$scsv = Csv::exportServers($roles, [$original]);
	$sparsed = Csv::parseServers($scsv, $roles);
	check('the servers export parses too', $sparsed['errors'] === [], $sparsed['errors']);
	['servers' => $backServers, 'errors' => $se] = $spec->parseServers(json_encode(array_map(
		fn($s) => array_diff_key($s, ['_line' => 1]), $sparsed['clients']['acme'])));
	check('and the servers come back identical, roles, services, notes and attributes',
		$se === [] && ClientSpec::encodeServers($backServers) === $original['servers'], [$se, ClientSpec::encodeServers($backServers)]);
	check('a role written by its label imports as the same role',
		Csv::parseServers("client,ip,roles\nacme,10.1.1.1,ES Data Hot\n", $roles)['clients']['acme'][0]['roles'] === ['es_data_hot']);
	check('a cell a spreadsheet would run as a formula is written as text and read back whole',
		strpos(Csv::export($roles, [$form('acme', ['lead_name' => '=cmd|calc'])]), "'=cmd|calc") !== false
		&& Csv::parse(Csv::export($roles, [$form('acme', ['lead_name' => '=cmd|calc'])]), $roles)['rows'][0]['soc_lead'] === '=cmd|calc');

	/*
	 * An import whose server list is shorter than what Zabbix holds. Deleting a host deletes its
	 * history, so the import may not do it quietly: with no servers.csv at all the servers are not
	 * touched, and with a short servers.csv every host that would go is named in the plan for the
	 * operator to tick.
	 */
	$begin('an import with a short server list');
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EP.CLIENT.TYPE}' => 'On-Prem', '{$ES.URL}' => 'https://es.acme.example:9243']]);
	foreach ([1 => '10.110.0.1', 2 => '10.110.0.2', 3 => '10.110.0.3'] as $n => $ip) {
		\Zbx::addHost(['host' => 'acme-Parser-'.$n, 'ip' => $ip, 'groups' => ['acme', 'Parser', 'Parsers'],
			'templates' => [Reconciler::agentTemplate()],
			'tags' => [Reconciler::MANAGED, ['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'ep-kind', 'value' => 'server'],
				['tag' => 'ep-role', 'value' => 'parser'], ['tag' => 'ep-service', 'value' => 'parser'], ['tag' => 'ep-status', 'value' => 'active']]]);
	}
	$r = $rec();
	$st = $state($r);
	$importer = new Importer($spec, $st);
	check('Zabbix holds three servers', count(json_decode($st->formFor('acme')['servers'], true)) === 3);
	// clients.csv alone: it carries no server column at all, so the servers must be left as they are.
	$onlyClients = Csv::parse("client,type\nacme,On-Prem\n", $roles);
	$plan = $importer->analyze($onlyClients, null);
	check('a clients.csv with no servers.csv is read without error', $plan['errors'] === [], $plan['errors']);
	check('and keeps all three servers — nothing is removed', count(json_decode($plan['rows'][0]['form']['servers'], true)) === 3,
		$plan['rows'][0]['form']['servers']);
	check('so there is nothing to delete in its plan',
		array_filter($plan['rows'][0]['diff']['hosts'] ?? [], fn($h) => $h['change'] === 'delete') === []);
	// A short servers.csv does change the list, and every host that would go has to be named.
	$short = Csv::parseServers("client,ip,roles\nacme,10.110.0.1,parser\n", $roles);
	$plan2 = (new Importer($spec, $state($rec())))->analyze(Csv::parse("client,type\nacme,On-Prem\n", $roles), $short);
	check('a short servers.csv is read without error', $plan2['errors'] === [], $plan2['errors']);
	check('it is an update, not something applied straight away', $plan2['rows'][0]['status'] === 'update');
	$deletes = array_values(array_filter($plan2['rows'][0]['diff']['hosts'], fn($h) => $h['change'] === 'delete'));
	check('and both hosts that would go are named, by host name and IP', count($deletes) === 2
		&& array_column($deletes, 'host') === ['acme-Parser-2', 'acme-Parser-3'], $deletes);
	check('the import itself changed nothing — checking a file is a read', \Zbx::$wrote === [], \Zbx::$wrote);
	check('a servers.csv for a client that is not one yet is an error, not a new client',
		(bool) preg_grep('/which is not a client yet/', (new Importer($spec, $state($rec())))->analyze(null, Csv::parseServers("client,ip,roles\nnobody,10.1.1.1,parser\n", $roles))['errors']));
	check('the same client twice in clients.csv is an error, whatever the case',
		(bool) preg_grep('/is in clients\.csv twice/', (new Importer($spec, $state($rec())))->analyze(Csv::parse("client,type\nacme,On-Prem\nACME,DI\n", $roles), null)['errors']));

	/*
	 * A backup of an empty client list. Only three backups are kept, so a backup of nothing is not
	 * harmless: three of them push every real copy out. An empty list is far likelier to be a
	 * lookup that missed — the clients are found by a template name and a tag that both changed in
	 * the rename — than a site whose clients have all gone.
	 */
	$begin('a backup taken while the client list is empty');
	foreach (glob($dir.'/backups/*.json') ?: [] as $f) { unlink($f); }
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EP.CLIENT.TYPE}' => 'DI', '{$EP.LEAD}' => 'Asha Rao']]);
	$good = Backups::take('a real save', 'tester', $state($rec()), $roles);
	check('a backup of a client that is there holds it', count(Backups::get($good)['clients']) === 1
		&& Backups::get($good)['clients']['acme']['lead_name'] === 'Asha Rao');
	// Now the lookup misses: no master template, no kind tag — exactly what reading one generation
	// of the names did on the live install.
	\Zbx::$hosts[$masterid]['parentTemplates'] = [];
	\Zbx::$hosts[$masterid]['tags'] = [];
	check('the list really does come back empty', $state($rec())->clients() === []);
	$code = 0; $why = '';
	try { Backups::take('a save that must not happen', 'tester', $state($rec()), $roles); }
	catch (\RuntimeException $e) { $code = $e->getCode(); $why = $e->getMessage(); }
	check('the backup is refused with its own code, so a caller can tell this apart from an unwritable folder',
		$code === Backups::REFUSED_EMPTY);
	check('and says nothing was changed and what to check', strpos($why, 'Nothing has been changed and no backup was taken') !== false
		&& strpos($why, 'Open Cluster Management and check that it lists its clients') !== false, $why);
	check('the backup that holds the client is still there', count(Backups::list()) === 1 && Backups::list()[0]['clients'] === 1);
	// Three refusals in a row must not wear the real copies down.
	for ($i = 0; $i < 3; $i++) {
		try { Backups::take('again', 'tester', $state($rec()), $roles); } catch (\RuntimeException $e) { }
	}
	check('three refused saves leave the real copy untouched', count(Backups::list()) === 1 && Backups::list()[0]['clients'] === 1, Backups::list());
	// The restore is the one caller allowed to snapshot an empty present, because that snapshot is
	// the only way back from a restore that turns out to be the wrong one.
	$empty = Backups::take('before restoring', 'tester', $state($rec()), $roles, true);
	check('a restore may take its snapshot even so', $empty !== '' && count(Backups::get($empty)['clients']) === 0);
	check('and that snapshot does not push out the copy that holds clients',
		count(array_filter(Backups::list(), fn($b) => $b['clients'] > 0)) === 1, Backups::list());

	/*
	 * Restoring a backup from before the rename: schema 1, one disk per role, IPs held per role
	 * rather than per server. It has to come back in today's terms or the restore writes a client
	 * with no servers.
	 */
	$begin('restoring a pre-rename backup');
	foreach (glob($dir.'/backups/*.json') ?: [] as $f) { unlink($f); }
	$oldId = gmdate('Ymd-His').'-abcd';
	Store::write(Backups::DIR.'/'.$oldId.'.json', ['id' => $oldId, 'schema' => 1, 'taken' => time(), 'by' => 'old version',
		'before' => 'a save on 2.7.1', 'roles' => $roles, 'machines' => 3, 'clients' => ['acme' => [
			'name' => 'acme', 'type' => 'DI', 'es_url' => 'https://es.acme.example:9243', 'lead_name' => 'Asha Rao',
			'ulm_bucket' => 'acme-archive', 'ulm_region' => 'ap-south-1',
			'ips_es_data_hot' => "10.120.0.11 10.120.0.12", 'ips_parser' => '10.120.0.21',
			'es_data_hot_disk_fs' => '/data', 'es_data_hot_disk' => '4096', 'ulm_tags' => 'dropped', 'es_jumphost' => 'dropped']]]);
	$old = Backups::get($oldId);
	check('it is read, and brought up to today\'s schema', $old !== null && (int) $old['schema'] === Backups::SCHEMA);
	$f = $old['clients']['acme'];
	check('the per-role IP lists become servers', count(json_decode($f['servers'], true)) === 3, $f['servers']);
	check('each server carries the role its list named', json_decode($f['servers'], true)[0]['roles'] === ['es_data_hot']
		&& json_decode($f['servers'], true)[2]['roles'] === ['parser'], $f['servers']);
	check('a role\'s one disk on a mount that is not / becomes its second disk, and / is not claimed',
		$f['es_data_hot_disk2_fs'] === '/data' && $f['es_data_hot_disk2'] === '4096' && $f['es_data_hot_disk'] === '0');
	check('fields the form no longer has are dropped', !array_key_exists('ulm_tags', $f) && !array_key_exists('es_jumphost', $f)
		&& !array_key_exists('ips_parser', $f));
	check('the settings it did keep are still there', $f['type'] === 'DI' && $f['lead_name'] === 'Asha Rao' && $f['ulm_bucket'] === 'acme-archive');
	check('and every field of today\'s form has a value, so a restore cannot write a blank it never meant',
		array_diff(array_keys($spec->defaults()), array_keys($f)) === [], array_diff(array_keys($spec->defaults()), array_keys($f)));
	check('the restored form is valid as it stands', $spec->fromForm($f)['errors'] === [], $spec->fromForm($f)['errors']);
	check('an id that is not an id is refused rather than read as a path', Backups::get('../../etc/passwd') === null
		&& Backups::get('20260101-000000-zzzz') === null);

	/* ======================================================================================
	 *  STALE DATA
	 * ====================================================================================== */

	/*
	 * The live install: a master host whose every setting is under a {$EVP.…} macro. The form has
	 * to read the real values, and the save has to be refused until the migration has run —
	 * saving would write the shipped defaults over requested CPU, memory and disk per role, the
	 * client type, the jump-host fields, the lead and the cluster DL, record the destroyed version
	 * as the backup, and have the alert routing conclude the client wants no alerts and delete its
	 * action, DL group, DL account and weekly report.
	 */
	$begin('a master host still on the pre-rename macros');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::LEGACY_MASTERS_GROUP],
		'templates' => [MasterTemplate::LEGACY_NAME],
		'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-client', 'value' => 'acme'], ['tag' => 'evp-kind', 'value' => 'master']],
		'macros' => ['{$GRP.CLIENT}' => 'acme', '{$EVP.CLIENT.TYPE}' => 'DI', '{$EVP.LEAD}' => 'Asha Rao',
			'{$EVP.DL}' => 'soc-acme@corp.example', '{$EVP.CONTRACT.END}' => '2027-03-31',
			'{$EVP.ES_DATA_HOT.CPU.REQUESTED}' => '64', '{$EVP.ES_DATA_HOT.MEMORY.REQUESTED}' => '256',
			'{$EVP.ES_DATA_HOT.ROOTDISK.REQUESTED}' => '8192', '{$EVP.ES_MASTER.CPU.REQUESTED}' => '16',
			'{$EVP.MONITORED.BY}' => 'proxy:dc-proxy', '{$ES.URL}' => 'https://es.acme.example:9243',
			'{$ULM.S3.BUCKET}' => 'acme-archive', '{$ULM.S3.REGION}' => 'ap-south-1']]);
	\Zbx::addHost(['host' => 'acme-ES-Cluster', 'groups' => ['acme', Reconciler::CLUSTER_GROUP],
		'templates' => [Reconciler::LEGACY_CLUSTER_TEMPLATE], 'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-kind', 'value' => 'cluster']]]);
	\Zbx::addHost(['host' => 'acme-ULM', 'groups' => ['acme', Reconciler::ULM_GROUP],
		'templates' => [Reconciler::LEGACY_ULM_TEMPLATE], 'tags' => [Reconciler::LEGACY_MANAGED, ['tag' => 'evp-kind', 'value' => 'archive']]]);
	\Zbx::addProxy('dc-proxy', time());
	$r = $rec();
	$now = $r->current('acme');
	check('the client, its cluster host and its archive host are all recognised',
		$now['master']['hostid'] === $masterid && $now['cluster'] !== null && $now['ulm'] !== null);
	$f = $state($rec())->formFor('acme');
	$defaults = $spec->defaults();
	check('the form shows the real client type, not the shipped default', $f['type'] === 'DI' && $defaults['type'] !== 'DI');
	check('the real requested CPU, memory and disk', $f['es_data_hot_cpu'] === '64' && $f['es_data_hot_mem'] === '256'
		&& $f['es_data_hot_disk'] === '8192' && $f['es_master_cpu'] === '16',
		[$f['es_data_hot_cpu'], $f['es_data_hot_mem'], $f['es_data_hot_disk'], $f['es_master_cpu']]);
	check('the real contacts and contract end', $f['lead_name'] === 'Asha Rao' && $f['cluster_dl'] === 'soc-acme@corp.example'
		&& $f['contract_end'] === '2027-03-31');
	check('the real proxy', $f['monitored_by'] === 'proxy:dc-proxy');
	check('macros that never carried the product name are read as they always were',
		$f['es_url'] === 'https://es.acme.example:9243' && $f['ulm_bucket'] === 'acme-archive');
	check('not one field of the form fell back to its default where the host says otherwise',
		$f['es_data_hot_cpu'] !== $defaults['es_data_hot_cpu'] && $f['lead_name'] !== $defaults['lead_name']);
	// And the refusal: the form reading correctly is not enough, because a field whose fallback
	// was missed is invisible. legacyMacrosIn() is a blanket scan of the prefix for that reason.
	$legacy = ClientSpec::legacyMacrosIn(\Zbx::macrosOf($masterid));
	check('every pre-rename macro on the host is named, sorted, and only those', count($legacy) === 9
		&& $legacy[0] === '{$EVP.CLIENT.TYPE}' && in_array('{$EVP.MONITORED.BY}', $legacy, true)
		&& !in_array('{$ES.URL}', $legacy, true) && !in_array('{$ULM.S3.BUCKET}', $legacy, true), $legacy);
	check('a host of today\'s generation carries none', ClientSpec::legacyMacrosIn(['{$EP.LEAD}' => 'x', '{$ES.URL}' => 'y']) === []);
	$c = $client(array_merge($f, ['es_password_mode' => 'vault']));
	$problems = $rec()->problems($c, $now);
	check('the save is refused, and names the migration to run',
		(bool) preg_grep('/still stores its settings under the previous names.*python3 setup\/zbx_rename\.py --apply/', $problems), $problems);
	check('and names some of the macros that stopped it', (bool) preg_grep('/\{\$EVP\.CLIENT\.TYPE\}/', $problems), $problems);
	check('with a count for the rest, rather than all nine', (bool) preg_grep('/and 5 more/', $problems), $problems);
	$said = '';
	try { $rec()->apply($c); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('nothing is written: not one macro, not one tag', \Zbx::$wrote === [] && $said !== '', \Zbx::$wrote);
	check('the host still carries its real values afterwards', \Zbx::macrosOf($masterid)['{$EVP.ES_DATA_HOT.CPU.REQUESTED}'] === '64');

	/*
	 * A host carrying both generations of the same tag with different values — a migration run
	 * half way, or a host touched by both releases. Both values are readable, and one save brings
	 * the host onto today's spelling without inventing a value.
	 */
	$begin('both generations of a tag, with different values');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	// In the family group but in no role group, and showing no templates, so the roles can only
	// come from its ep-role tags — which is where the two generations disagree.
	$srv = \Zbx::addHost(['host' => 'acme-Parser-1', 'ip' => '10.130.0.1', 'groups' => ['acme', 'Parsers'],
		'templates' => [],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-role', 'value' => 'parser'], ['tag' => 'evp-role', 'value' => 's3_parser'],
			['tag' => 'ep-client', 'value' => 'acme'], ['tag' => 'evp-client', 'value' => 'acme-old'],
			['tag' => 'inv:rack', 'value' => 'R4']]]);
	$now = $rec()->current('acme');
	$host = $now['machines'][$srv];
	check('both values of the role tag are readable, today\'s first',
		Reconciler::tagValues($host, 'ep-role') === ['parser', 's3_parser'], Reconciler::tagValues($host, 'ep-role'));
	check('both values of the client tag too — a disagreement is visible, not hidden',
		Reconciler::tagValues($host, 'ep-client') === ['acme', 'acme-old'], Reconciler::tagValues($host, 'ep-client'));
	check('with no role group to go on, the tags give the roles', $host['_roles'] === ['parser', 's3_parser'], $host['_roles']);
	check('an inv: tag is not one of ours and is read as an attribute', $host['_attrs'] === ['rack' => 'R4']);
	$c = $client($form('acme', ['es_url' => '', 'servers' => json_encode([['ip' => '10.130.0.1', 'roles' => ['parser'], 'attrs' => ['rack' => 'R5']]])]));
	$rec()->apply($c);
	$after = \Zbx::tagsOf($srv);
	check('after a save the host carries one spelling of each of our tags', !preg_grep('/^evp-/', $after), $after);
	check('today\'s values are what is left', in_array('ep-client=acme', $after, true) && in_array('ep-role=parser', $after, true)
		&& !in_array('ep-role=s3_parser', $after, true), $after);
	check('and the managed-by marker is brought forward, not doubled',
		count(preg_grep('/^managed-by=/', $after)) === 1 && in_array('managed-by=elasticpro-clients', $after, true), $after);
	check('the attribute given replaces its inv: tag; it is not left there twice',
		in_array('inv:rack=R5', $after, true) && !in_array('inv:rack=R4', $after, true), $after);

	/*
	 * A cluster host still linked to the pre-rename jump host template. Both generations carry the
	 * same item keys, so Zabbix refuses to link both to one host, and it refuses in the middle of
	 * the save. This page will not unlink it on the operator's behalf: which generation of items
	 * the host keeps afterwards is a decision about item history, and item history does not come
	 * back.
	 */
	$begin('a cluster host still on the pre-rename jump template');
	$masterid = \Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme', Reconciler::MASTERS_GROUP], 'templates' => [MasterTemplate::NAME],
		'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'master']], 'macros' => ['{$GRP.CLIENT}' => 'acme']]);
	$clusterid = \Zbx::addHost(['host' => 'acme-ES-Cluster', 'groups' => ['acme', Reconciler::CLUSTER_GROUP],
		'templates' => [JumpTemplate::LEGACY_NAME], 'tags' => [Reconciler::MANAGED, ['tag' => 'ep-kind', 'value' => 'cluster']],
		'macros' => [Reconciler::ES_PASSWORD_MACRO => ['kept', ZBX_MACRO_TYPE_SECRET]]]);
	$r = $rec();
	$now = $r->current('acme');
	check('the cluster host is recognised by the pre-rename jump template', ($now['cluster']['hostid'] ?? '') === $clusterid);
	// The form says "reached directly", because the macros a jump-host client keeps are the ones
	// the rename moved: on a host like this throughJump() can only return the shipped default.
	// The guard has to read the TEMPLATE on the host, which is readable whatever the macros say.
	$direct = $client($form('acme', ['monitored_by' => '']));
	check('the form reads as reached directly, which is the shipped default', !$spec->throughJump($direct));
	$problems = $r->problems($direct, $now);
	check('the clash is still refused', (bool) preg_grep('/is still linked to "'.preg_quote(JumpTemplate::LEGACY_NAME, '/').'"/', $problems), $problems);
	check('and the message says Unlink, never Unlink and clear, and why',
		(bool) preg_grep('/"Unlink", never "Unlink and clear", which deletes those items and every value they hold/', $problems), $problems);
	check('it names the host to go to and the template that takes over',
		(bool) preg_grep('/'.preg_quote(JumpTemplate::NAME, '/').'/', $problems) && (bool) preg_grep('/acme-ES-Cluster/', $problems), $problems);
	$said = '';
	try { $rec()->apply($direct); } catch (\Exception $e) { $said = $e->getMessage(); }
	check('nothing is written, so the host keeps both its items and its history', \Zbx::$wrote === [] && $said !== '', \Zbx::$wrote);
	check('the legacy template is still linked: this page does not unlink it for them',
		in_array(JumpTemplate::LEGACY_NAME, array_column(\Zbx::$hosts[$clusterid]['parentTemplates'], 'host'), true));
	// A client that really is asked through a jump host hits the same guard, for the same reason.
	$viaJump = $client($form('acme', ['monitored_by' => 'jump', 'jump_host' => 'jump-win.acme.internal', 'jump_user' => 'jump-user',
		'es_apikey_path' => 'secret/elasticpro/acme:apikey']));
	check('and so does a client the form does say is reached through one', $spec->throughJump($viaJump)
		&& (bool) preg_grep('/is still linked to/', $rec()->problems($viaJump, $rec()->current('acme'))));
	// Without the legacy template there is nothing to refuse: the guard is about the host, and it
	// must stay quiet when the host is clean.
	\Zbx::hostMassRemove(['hostids' => [$clusterid], 'templateids' => array_column(\Zbx::$hosts[$clusterid]['parentTemplates'], 'templateid')]);
	\Zbx::hostMassAdd(['hosts' => [['hostid' => $clusterid]], 'templates' => [['templateid' => \Zbx::addTemplate(JumpTemplate::NAME)]]]);
	check('a cluster host on today\'s jump template is not refused',
		!preg_grep('/is still linked to/', $rec()->problems($viaJump, $rec()->current('acme'))),
		$rec()->problems($viaJump, $rec()->current('acme')));
	// TemplateInstaller spells out the procedure, and says whether the leftover template is one
	// this page wrote — an operator must not be told to unlink a template a site imported itself.
	$begin('the procedure for a leftover template');
	// The uuid seed is the key TemplateInstaller::LEGACY_TEMPLATES holds the master template
	// under, which is how it tells a template it wrote itself from one a site imported.
	$tid = \Zbx::addTemplate(MasterTemplate::LEGACY_NAME, MasterTemplate::legacyUuid('template'));
	\Zbx::addHost(['host' => 'acme-Master', 'groups' => ['acme'], 'templates' => [MasterTemplate::LEGACY_NAME, MasterTemplate::NAME]]);
	$collisions = TemplateInstaller::legacyCollision();
	check('the leftover template is found, with the hosts still on it', count($collisions) === 1
		&& $collisions[0]['template'] === MasterTemplate::LEGACY_NAME && count($collisions[0]['hosts']) === 1, $collisions);
	check('and it says the host is on today\'s template as well', $collisions[0]['hosts'][0]['also_current'] === true);
	check('and that this page wrote it, so it is safe to say unlink', $collisions[0]['written_here'] === true);

	/* ---------------- the template mapping, against what Zabbix really has ---------------- */
	// The mapping's job is to make a naming problem visible on the page instead of letting it
	// fail silently later, so what matters is what each row reports about this Zabbix.
	$scene = 'template mapping';
	Roles::saveTemplateNames([]);
	$rows = TemplateMap::rows();
	check('every slot gets a row', array_keys($rows) === array_keys(Roles::TEMPLATE_SLOTS), array_keys($rows));
	check('an unmapped row shows the shipped name and is not marked mapped',
		$rows['master']['name'] === Roles::TEMPLATE_SLOTS['master'][0] && $rows['master']['mapped'] === false);

	// A template this page wrote: recognised as ours by uuid, not by its name.
	\Zbx::addTemplate('ACME master', MasterTemplate::uuid('template'));
	Roles::saveTemplateNames(['master' => 'ACME master']);
	$row = TemplateMap::rows()['master'];
	check('a mapped name that exists and carries our uuid is reported as ours',
		$row['found'] === true && $row['ours'] === true && $row['problem'] === '', $row);

	// The same name owned by a template this page did not write is the one mapping that cannot
	// work: configuration.import matches by uuid and refuses a name that belongs to another
	// object, so the page has to say so before the operator leaves it.
	\Zbx::addTemplate('Someone elses template', 'ffffffffffffffffffffffffffffffff');
	Roles::saveTemplateNames(['master' => 'Someone elses template']);
	$row = TemplateMap::rows()['master'];
	check('a written slot mapped onto a foreign template is refused in words',
		$row['found'] === true && $row['ours'] === false && str_contains($row['problem'], 'already exists'), $row);
	check('and the sentence names the template, so it can be found in Zabbix',
		str_contains($row['problem'], 'Someone elses template'), $row['problem']);

	// A slot this page only looks for: a name nothing answers to finds nothing, which is the
	// exact failure an operator cannot see from the form alone.
	Roles::saveTemplateNames(['plan' => 'No such plan template']);
	$row = TemplateMap::rows()['plan'];
	check('a look-for slot mapped to a name Zabbix has not got says so',
		$row['found'] === false && str_contains($row['problem'], 'No template on this Zabbix is called'), $row);
	check('and names the name that found nothing', str_contains($row['problem'], 'No such plan template'), $row['problem']);

	// The same absence on a slot this page writes is the normal state before install, so it is
	// reported as pending and not as a fault — a column that cried wolf would stop being read.
	Roles::saveTemplateNames(['devices' => 'Devices template not installed yet']);
	$row = TemplateMap::rows()['devices'];
	check('a written slot Zabbix has not got yet is not called a problem',
		$row['found'] === false && $row['problem'] === '', $row);

	// The extra names, which are recognised and never written.
	Roles::saveTemplateNames(['cluster' => 'ACME cluster', 'cluster_also' => "An older cluster name\nAnother missing one"]);
	\Zbx::addTemplate('An older cluster name');
	$row = TemplateMap::rows()['cluster'];
	check('an extra name that exists is listed without complaint',
		count($row['aliases']) === 2 && $row['aliases'][0]['found'] === true, $row['aliases']);
	check('an extra name nothing answers to is flagged', $row['aliases'][1]['found'] === false);
	check('the extra names are recognised but never written',
		in_array('An older cluster name', Reconciler::esClusterTemplates(), true) && ClusterTemplate::name() === 'ACME cluster');

	// Regression: ISSUE-001 — an extra name equal to the mapped name was hidden from the form.
	// Found by /qa on 2026-10-08. The form posts back what it shows, so the next Save dropped
	// the hidden name from the store, and moving the slot away then lost it for good.
	// Report: .gstack/qa-reports/qa-report-192-168-64-13-2026-10-08.md
	Roles::saveTemplateNames(['cluster' => 'ACME cluster', 'cluster_also' => 'ACME cluster']);
	$row = TemplateMap::rows()['cluster'];
	check('an extra name equal to the mapped name is still shown, so a Save cannot drop it',
		array_column($row['aliases'], 'name') === ['ACME cluster'], $row['aliases']);
	check('and the store still holds it', Roles::templateAliases()['cluster'] === ['ACME cluster']);
	check('recognition lists it once, not twice',
		count(array_keys(Reconciler::esClusterTemplates(), 'ACME cluster', true)) === 1,
		Reconciler::esClusterTemplates());
	// What the form round-trip does: post back exactly the names the page displayed.
	Roles::saveTemplateNames(['cluster' => 'ACME cluster',
		'cluster_also' => implode("\n", array_column(TemplateMap::rows()['cluster']['aliases'], 'name'))]);
	check('a Save that changes nothing keeps the extra name',
		Roles::templateAliases()['cluster'] === ['ACME cluster'], Roles::templateAliases()['cluster']);
	// And moving the slot away must leave the name still recognised.
	Roles::saveTemplateNames(['cluster_also' => 'ACME cluster']);
	check('moving the slot away leaves the extra name recognised',
		in_array('ACME cluster', Reconciler::esClusterTemplates(), true));
	Roles::saveTemplateNames([]);

	$choices = TemplateMap::choices();
	check('the picker offers the template names this Zabbix has, sorted',
		in_array('ACME cluster', $choices['names'], true) === false || $choices['names'] === array_values($choices['names']));
	check('and says whether it listed them all', is_bool($choices['complete']));
	Roles::saveTemplateNames([]);

	/* ---------------- tidy up ---------------- */
	foreach (glob($dir.'/backups/*.json') ?: [] as $f) { unlink($f); }
	if (is_dir($dir.'/backups')) { rmdir($dir.'/backups'); }
	foreach (array_diff(scandir($dir), ['.', '..']) as $fn) { unlink($dir.'/'.$fn); }
	rmdir($dir);

	$scene = '';
	echo "$passed passed, $failed failed", PHP_EOL;
	exit($failed ? 1 : 0);
}
