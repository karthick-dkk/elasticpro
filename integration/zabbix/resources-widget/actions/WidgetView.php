<?php declare(strict_types = 0);

namespace Modules\EpResources\Actions;

foreach (['Store', 'Roles', 'ColumnSettings'] as $lib) {
	require_once __DIR__.'/../lib/'.$lib.'.php';
}

use API,
	CControllerDashboardWidgetView,
	CControllerResponseData,
	CCsrfTokenHelper;
use Modules\EpResources\Lib\{Bars, ColumnSettings, Roles};

/**
 * Client resources: one row per client master host; per family (or per role, where the Columns
 * dialog splits a family) servers, CPU, memory and disk — requested, allocated, used. Each client
 * expands into its servers: role, host, IP, whether it answers, and its CPU, memory and disk.
 *
 * The columns come from the roles (the Clients page's Roles), so a role added there appears here
 * without a change to this widget. A figure Zabbix does not have is "—" and an empty cell in the
 * export; a request of 0 is one nobody entered, shown as "not set".
 */
class WidgetView extends CControllerDashboardWidgetView {

	private const GB = 1073741824;
	private const TEMPLATE = 'ElasticPro client master';
	private const RES = ['servers' => 'servers', 'cpu' => 'CPU (cores)', 'mem' => 'memory', 'disk' => 'disk'];

	protected function doAction(): void {
		$roles = Roles::load();
		$settings = ColumnSettings::load('resources');
		$all = $this->columns($roles, $settings['split']);
		$columns = ColumnSettings::apply($all, $settings);

		$data = [
			'name' => $this->getInput('name', $this->widget->getDefaultName()),
			'columns' => $columns,
			'bars' => Bars::styleOf($this->fields_values['bars'] ?? Bars::DEFAULT_VALUE),
			'rows' => [],
			'export' => null,
			'error' => null,
			'meta' => [
				'title' => 'Client resources',
				'report' => 'resources',
				'action' => 'widget.ep_resources.columns',
				'token' => CCsrfTokenHelper::get('widget.ep_resources.columns'),
				'canEdit' => $this->getUserType() == USER_TYPE_SUPER_ADMIN,
				'columns' => array_map(fn($c) => ['id' => $c['id'], 'label' => $c['label'], 'default' => $c['default'], 'hidden' => $c['hidden'],
					'section' => $c['group']], ColumnSettings::apply($all, $settings, true)),
				'families' => array_map(fn($f) => ['id' => $f['id'], 'label' => $f['label'], 'split' => in_array($f['id'], $settings['split'], true)],
					$roles['families'])
			],
			'user' => ['debug_mode' => $this->getDebugMode()]
		];

		$templates = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => self::TEMPLATE]]);
		if (!$templates) {
			$data['error'] = _s('Template "%1$s" is not in Zabbix yet — write it from ElasticPro → Clients.', self::TEMPLATE);
			$this->setResponse(new CControllerResponseData($data));
			return;
		}
		// Disabled clients stay in the report (with a badge), so not only monitored hosts.
		$options = ['output' => ['hostid', 'name', 'maintenance_status'], 'templateids' => [$templates[0]['templateid']], 'preservekeys' => true];
		if ($this->fields_values['groupids']) {
			$options['groupids'] = getSubGroups($this->fields_values['groupids']);
		}
		$masters = API::Host()->get($options);

		$keys = [];
		foreach ($all as $c) {
			foreach (['key', 'vs', 'usageKey'] as $k) {
				if (isset($c[$k])) {
					$keys[$c[$k]] = true;
				}
			}
		}
		$values = [];
		$units = [];
		$macros = [];
		if ($masters) {
			foreach (API::Item()->get(['output' => ['hostid', 'key_', 'lastvalue', 'lastclock', 'units', 'state'],
					'hostids' => array_keys($masters), 'filter' => ['key_' => array_keys($keys)]]) as $it) {
				$units[$it['key_']] = $it['units'];
				$values[$it['hostid']][$it['key_']] = self::known($it) ? (float) $it['lastvalue'] : null;
			}
			foreach (API::UserMacro()->get(['output' => ['hostid', 'macro', 'value'], 'hostids' => array_keys($masters)]) ?: [] as $m) {
				$macros[$m['hostid']][$m['macro']] = (string) ($m['value'] ?? '');
			}
		}

		$clients = [];
		foreach ($masters as $hostid => $master) {
			$m = $macros[$hostid] ?? [];
			// Decommissioned clients leave the report.
			if (($m['{$EP.CLIENT.STATUS}'] ?? 'active') === 'decommissioned') {
				unset($masters[$hostid]);
				continue;
			}
			$clients[$hostid] = [
				'name' => ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : $master['name'],
				'type' => ($m['{$EP.CLIENT.TYPE}'] ?? '') !== '' ? $m['{$EP.CLIENT.TYPE}'] : 'On-Prem',
				'badge' => ($m['{$EP.CLIENT.STATUS}'] ?? 'active') === 'disabled' ? _('disabled') : ((int) ($master['maintenance_status'] ?? 0) === 1 ? _('maintenance') : ''),
				'macros' => $m
			];
		}
		$servers = $this->servers($roles, $clients);

		$headers = array_map(fn($c) => ($c['group'] === 'Client' ? '' : $c['group'].' ').$c['label'].self::suffix(isset($c['key']) ? ($units[$c['key']] ?? '') : ''), $columns);
		$exportRows = [];
		$exportTypes = [];
		$serverRows = [];
		foreach ($masters as $hostid => $master) {
			$client = $clients[$hostid];
			$m = $client['macros'];
			$warn = is_numeric($m['{$EP.USAGE.WARN}'] ?? null) ? (float) $m['{$EP.USAGE.WARN}'] : 80.0;
			$high = is_numeric($m['{$EP.USAGE.HIGH}'] ?? null) ? (float) $m['{$EP.USAGE.HIGH}'] : 90.0;
			$cells = [];
			$export = [];
			foreach ($columns as $c) {
				[$cell, $value] = $this->cell($c, $client, $values[$hostid] ?? [], $units, $warn, $high);
				$cells[] = $cell;
				$export[] = $value;
			}
			$srv = $servers[$client['name']] ?? [];
			foreach ($srv as &$s) {
				$s['classes'] = [
					'cpu' => self::usageClass($s['cpu_used'], $warn, $high),
					'mem' => self::usageClass($s['mem_used'], $warn, $high),
					'disk' => self::usageClass($s['disk_used'], $warn, $high)
				];
				$serverRows[$client['name']][] = [$client['name'], $client['type'], $s['role'], implode(', ', $s['services'] ?? []), $s['host'], $s['ip'], $s['status'],
					$s['cpu_cores'], self::r1($s['cpu_used']), $s['mem_total'] !== null ? round($s['mem_total'] / self::GB, 2) : null, self::r1($s['mem_used']),
					$s['mount'], $s['disk_total'] !== null ? round($s['disk_total'] / self::GB, 2) : null, self::r1($s['disk_used'])];
			}
			unset($s);
			$data['rows'][] = ['client' => $client['name'], 'type' => $client['type'], 'cells' => $cells, 'servers' => $srv];
			$exportRows[] = $export;
			$exportTypes[] = $client['type'];
		}
		$order = array_keys($data['rows']);
		usort($order, fn($a, $b) => strnatcasecmp($data['rows'][$a]['client'], $data['rows'][$b]['client']));
		$data['rows'] = array_map(fn($i) => $data['rows'][$i], $order);
		$servers_out = [];
		foreach ($data['rows'] as $row) {
			$servers_out = array_merge($servers_out, $serverRows[$row['client']] ?? []);
		}
		$data['export'] = [
			'headers' => $headers,
			'rows' => array_map(fn($i) => $exportRows[$i], $order),
			'types' => array_map(fn($i) => $exportTypes[$i], $order),
			'servers' => ['headers' => ['Client', 'Type', 'Roles', 'Services', 'Host', 'IP', 'Status', 'CPU cores', 'CPU used (%)', 'Memory (GB)', 'Memory used (%)',
				'Disks', 'Disk (GB)', 'Fullest disk (%)'], 'rows' => $servers_out, 'types' => array_column($servers_out, 1)]
		];
		$this->setResponse(new CControllerResponseData($data));
	}

	/** Every column the report can show, before the settings: families, or roles where split. */
	private function columns(array $roles, array $split): array {
		$out = [
			['id' => 'client.name', 'group' => 'Client', 'label' => 'Cluster Name', 'source' => 'client'],
			['id' => 'client.type', 'group' => 'Client', 'label' => 'Type', 'source' => 'type'],
			['id' => 'client.url', 'group' => 'Client', 'label' => 'ES URL', 'source' => 'macro', 'macro' => '{$ES.URL}'],
			['id' => 'delay.late', 'group' => 'Log delay', 'label' => 'Devices late', 'key' => 'ep.delay.late'],
			['id' => 'storage.purchased', 'group' => 'ES storage', 'label' => 'Purchased', 'key' => 'ep.es.storage.purchased', 'kind' => 'requested'],
			['id' => 'storage.allocated', 'group' => 'ES storage', 'label' => 'Allocated', 'key' => 'ep.es.storage.allocated', 'vs' => 'ep.es.storage.purchased'],
			['id' => 'storage.used', 'group' => 'ES storage', 'label' => 'Used', 'key' => 'ep.es.storage.used'],
			['id' => 'storage.usage', 'group' => 'ES storage', 'label' => 'Used %', 'key' => 'ep.es.storage.usage', 'usage' => true],
			['id' => 'devices.purchased', 'group' => 'Devices', 'label' => 'Purchased', 'key' => 'ep.devices.purchased', 'kind' => 'requested'],
			['id' => 'devices.seen', 'group' => 'Devices', 'label' => 'Seen', 'key' => 'ep.devices.seen', 'usageKey' => 'ep.devices.usage']
		];
		foreach ($roles['families'] as $f) {
			$units = in_array($f['id'], $split, true)
				? array_map(fn($r) => ['id' => 'r.'.$r['id'], 'label' => $r['label'], 'key' => fn($res, $kind) => 'ep.role.'.$res.'.'.$kind.'['.$r['id'].']'], $f['roles'])
				: [['id' => 'f.'.$f['id'], 'label' => $f['label'], 'key' => fn($res, $kind) => 'ep.'.$f['id'].'.'.$res.'.'.$kind]];
			foreach ($units as $u) {
				foreach ($f['order'] ?? Roles::RESOURCES as $res) {
					$g = $u['label'].' '.self::RES[$res];
					$k = $u['key'];
					$out[] = ['id' => $u['id'].'.'.$res.'.requested', 'group' => $g, 'label' => 'Requested', 'key' => $k($res, 'requested'), 'kind' => 'requested'];
					$out[] = ['id' => $u['id'].'.'.$res.'.allocated', 'group' => $g, 'label' => 'Allocated', 'key' => $k($res, 'allocated'), 'vs' => $k($res, 'requested')];
					if ($res === 'cpu' || $res === 'mem') {
						$out[] = ['id' => $u['id'].'.'.$res.'.usage', 'group' => $g, 'label' => 'Used', 'key' => $k($res, 'usage'), 'usage' => true];
					}
					if ($res === 'disk') {
						$out[] = ['id' => $u['id'].'.'.$res.'.used', 'group' => $g, 'label' => 'Used', 'key' => $k($res, 'used'), 'usageKey' => $k($res, 'usage')];
					}
				}
			}
		}
		return $out;
	}

	/** One cell: [what the table shows, what the export gets]. */
	private function cell(array $c, array $client, array $values, array $units, float $warn, float $high): array {
		$cell = ['text' => '—', 'sub' => '', 'class' => '', 'hint' => '', 'bar' => null];
		switch ($c['source'] ?? 'item') {
			case 'client':
				return [['text' => $client['name'], 'sub' => $client['badge']] + $cell, $client['name']];
			case 'type':
				return [['text' => $client['type'], 'class' => $client['type'] === 'DI' ? 'ep-pill ep-di' : 'ep-pill ep-op'] + $cell, $client['type']];
			case 'macro':
				$v = $client['macros'][$c['macro']] ?? '';
				return [['text' => $v !== '' ? $v : '—'] + $cell, $v];
		}
		$value = $values[$c['key']] ?? null;
		$unit = $units[$c['key']] ?? '';
		if (($c['kind'] ?? '') === 'requested' && $value !== null && $value == 0) {
			return [['text' => _('not set'), 'class' => 'ep-unset'] + $cell, null];
		}
		if ($value !== null) {
			$cell['text'] = convertUnits(['value' => $value, 'units' => $unit, 'decimals' => $unit === '' ? 0 : ($unit === '%' ? 1 : 2)]);
		}
		$usage = !empty($c['usage']) ? $value : (isset($c['usageKey']) ? ($values[$c['usageKey']] ?? null) : null);
		if ($usage !== null) {
			$cell['class'] = self::usageClass($usage, $warn, $high);
			// Same figure as the colour. Null stays null: no bar for something not reported.
			$cell['bar'] = max(0.0, min(100.0, (float) $usage));
			if (isset($c['usageKey']) && $value !== null) {
				$cell['sub'] = '('.round($usage).' %)';
			}
		}
		if (isset($c['vs'])) {
			$req = $values[$c['vs']] ?? null;
			if ($value !== null && $req !== null && $req > 0 && $value < $req) {
				$cell['class'] = trim($cell['class'].' ep-short');
				$cell['hint'] = _s('Below %1$s: %2$s', $c['vs'] === 'ep.es.storage.purchased' ? _('purchased') : _('requested'),
					convertUnits(['value' => $req, 'units' => $units[$c['vs']] ?? $unit]));
			}
		}
		return [$cell, self::exportValue($value, $unit)];
	}

	/** Every client's machines, each with its role, IP, status and CPU, memory and disk. */
	private function servers(array $roles, array $clients): array {
		if (!$clients) {
			return [];
		}
		$names = array_column($clients, 'name');
		$groups = array_column(API::HostGroup()->get(['output' => ['groupid', 'name'], 'filter' => ['name' => $names]]), 'groupid', 'name');
		if (!$groups) {
			return [];
		}
		$hosts = API::Host()->get(['output' => ['hostid', 'name'], 'groupids' => array_values($groups), 'selectHostGroups' => ['name'],
			'selectInterfaces' => ['ip', 'type', 'main', 'available'], 'selectTags' => ['tag', 'value'], 'preservekeys' => true]);
		// Each role's disks: / and its extra mounts, from the client's master host.
		$mounts = [];
		foreach ($clients as $c) {
			foreach (Roles::allRoles($roles) as $r) {
				$mounts[$c['name']][$r['id']] = Roles::diskMounts($c['macros'], $r['id']);
			}
		}
		$out = [];
		$want = [];
		foreach ($hosts as $hostid => $h) {
			$gn = array_column($h['hostgroups'], 'name');
			$client = array_values(array_intersect($names, $gn))[0] ?? null;
			if ($client === null) {
				continue;
			}
			// The same reading of roles as the Clients page: every role whose group the host is in.
			$held = Roles::rolesOfGroups($roles, $gn);
			if (!$held) {
				continue;
			}
			$role = $held[0];
			$ids = array_column($held, 'id');
			$services = [];
			foreach ($h['tags'] ?? [] as $t) {
				if ($t['tag'] === 'ep-service' && !in_array($t['value'], $ids, true)) {
					$services[] = $t['value'];
				}
			}
			$ip = null;
			$avail = 0;
			foreach ($h['interfaces'] as $if) {
				if ($if['type'] == INTERFACE_TYPE_AGENT && $if['main'] == INTERFACE_PRIMARY) {
					$ip = $if['ip'];
					$avail = (int) $if['available'];
				}
			}
			$mine = [];
			foreach ($ids as $rid) {
				foreach ($mounts[$client][$rid] as $m) {
					if (!in_array($m, $mine, true)) {
						$mine[] = $m;
					}
				}
			}
			$out[$client][$hostid] = ['role' => implode(' + ', array_column($held, 'label')), 'roles' => $ids, 'services' => $services,
				'shared' => count($held) > 1, 'single' => (bool) array_filter($held, fn($r) => !empty($r['exclusive'])), 'host' => $h['name'], 'hostid' => $hostid, 'ip' => $ip ?? '',
				'status' => $avail === 1 ? 'up' : ($avail === 2 ? 'down' : 'unknown'), 'mount' => implode(', ', $mine),
				'disks' => array_map(fn($m) => ['mount' => $m, 'total' => null, 'used' => null], $mine),
				'cpu_cores' => null, 'cpu_used' => null, 'mem_total' => null, 'mem_used' => null, 'disk_total' => null, 'disk_used' => null];
			$want[$hostid] = ['system.cpu.num' => 'cpu_cores', 'system.cpu.util' => 'cpu_used', 'vm.memory.size[total]' => 'mem_total',
				'vm.memory.utilization' => 'mem_used'];
			foreach ($mine as $i => $m) {
				$want[$hostid]['vfs.fs.dependent.size['.$m.',total]'] = 'disk.'.$i.'.total';
				$want[$hostid]['vfs.fs.dependent.size['.$m.',pused]'] = 'disk.'.$i.'.used';
			}
		}
		if ($want) {
			$keys = array_unique(array_merge(...array_map('array_keys', array_values($want))));
			foreach (API::Item()->get(['output' => ['hostid', 'key_', 'lastvalue', 'lastclock', 'state'], 'hostids' => array_keys($want),
					'filter' => ['key_' => $keys]]) as $it) {
				$field = $want[$it['hostid']][$it['key_']] ?? null;
				if ($field === null || !self::known($it)) {
					continue;
				}
				foreach ($out as $client => $list) {
					if (!isset($list[$it['hostid']])) {
						continue;
					}
					if (preg_match('/^disk\.(\d+)\.(total|used)$/', $field, $m)) {
						$out[$client][$it['hostid']]['disks'][(int) $m[1]][$m[2]] = (float) $it['lastvalue'];
					}
					else {
						$out[$client][$it['hostid']][$field] = (float) $it['lastvalue'];
					}
				}
			}
		}
		// A server's disk: the sum of the sizes known, and its fullest disk — each only when measured.
		foreach ($out as $client => $list) {
			foreach ($list as $hid => $s) {
				$totals = array_filter(array_column($s['disks'], 'total'), fn($v) => $v !== null);
				$used = array_filter(array_column($s['disks'], 'used'), fn($v) => $v !== null);
				$out[$client][$hid]['disk_total'] = $totals ? array_sum($totals) : null;
				$out[$client][$hid]['disk_used'] = $used ? max($used) : null;
			}
		}
		foreach ($out as $client => $list) {
			$list = array_values($list);
			usort($list, fn($a, $b) => [$a['role'], $a['host']] <=> [$b['role'], $b['host']]);
			$out[$client] = $list;
		}
		return $out;
	}

	private static function known(array $it): bool {
		return $it['state'] == ITEM_STATE_NORMAL && $it['lastclock'] != 0 && $it['lastvalue'] !== '';
	}

	public static function usageClass(?float $v, float $warn, float $high): string {
		return $v === null ? '' : ($v >= $high ? 'ep-high' : ($v >= $warn ? 'ep-warn' : ''));
	}

	private static function r1(?float $v): ?float {
		return $v === null ? null : round($v, 1);
	}

	private static function suffix(string $units): string {
		return $units === 'B' ? ' (GB)' : ($units === '%' ? ' (%)' : '');
	}

	private static function exportValue(?float $value, string $units) {
		if ($value === null) {
			return null;
		}
		return $units === 'B' ? round($value / self::GB, 2) : round($value, $units === '%' ? 1 : 2);
	}
}
