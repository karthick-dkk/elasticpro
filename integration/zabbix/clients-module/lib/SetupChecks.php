<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;

/**
 * Is each part of a client working? Read from what Zabbix already has — item states, errors and
 * last values, interface availability — so a rejected password or an agent that never answered
 * shows on the list the day it happens. Only the checks that apply to a client are counted.
 */
class SetupChecks {

	/**
	 * @param array $nows client name => Reconciler::current() of it
	 * @param array $macros client name => its master host's macros
	 * @return array client name => [[label, ok (bool|null = not yet known), detail]]
	 */
	public static function forClients(array $nows, array $macros): array {
		$hostids = [];
		foreach ($nows as $now) {
			foreach (['cluster', 'ulm'] as $k) {
				if ($now[$k] !== null) {
					$hostids[] = $now[$k]['hostid'];
				}
			}
		}
		$keys = ['es.cluster.get_health', JumpTemplate::FAST, 'ep.wj.problem[fast]', DevicesTemplate::KEY, 'ulm.check', 'ulm.error'];
		$items = [];
		$tags1 = [];
		if ($hostids) {
			foreach (API::Item()->get(['output' => ['hostid', 'key_', 'state', 'error', 'lastclock', 'lastvalue'], 'hostids' => $hostids,
					'filter' => ['key_' => $keys]]) as $it) {
				$items[$it['hostid']][$it['key_']] = $it;
			}
			foreach (API::Item()->get(['output' => ['hostid'], 'hostids' => $hostids, 'search' => ['key_' => 'ulm.tag.missing['], 'startSearch' => true]) as $it) {
				$tags1[$it['hostid']] = ($tags1[$it['hostid']] ?? 0) + 1;
			}
		}
		$proxies = [];
		foreach (API::Proxy()->get(['output' => ['name', 'lastaccess']]) ?: [] as $p) {
			$proxies[$p['name']] = (int) $p['lastaccess'];
		}
		$groups = [];
		foreach (API::ProxyGroup()->get(['output' => ['name', 'state']]) ?: [] as $g) {
			$groups[$g['name']] = (int) $g['state'];
		}
		$out = [];
		foreach ($nows as $client => $now) {
			$m = $macros[$client] ?? [];
			$checks = [];
			if ($now['cluster'] !== null) {
				$c = $items[$now['cluster']['hostid']] ?? [];
				if (isset($c[JumpTemplate::FAST])) {
					$checks[] = self::item($c[JumpTemplate::FAST], _('SSH to the jump host'));
					$p = $c['ep.wj.problem[fast]'] ?? null;
					$checks[] = [_('Elasticsearch answers'), $p === null || (int) $p['lastclock'] === 0 ? null : ($p['lastvalue'] === ''),
						$p !== null && $p['lastvalue'] !== '' ? $p['lastvalue'] : ''];
				}
				else {
					$h = $c['es.cluster.get_health'] ?? null;
					$check = self::item($h, _('Elasticsearch answers'));
					if ($check[1] === false && preg_match('/\b(401|403)\b/', $check[2])) {
						$check[2] = _('password rejected').' ('.$check[2].')';
					}
					$checks[] = $check;
				}
				$checks[] = self::item($c[DevicesTemplate::KEY] ?? null, _('Devices counted'));
			}
			$servers = array_filter($now['machines'], fn($h) => $h['_roles']);
			if ($servers) {
				$up = 0;
				$down = [];
				foreach ($servers as $h) {
					$avail = 0;
					foreach ($h['interfaces'] ?? [] as $if) {
						if ($if['type'] == INTERFACE_TYPE_AGENT && $if['main'] == INTERFACE_PRIMARY) {
							$avail = (int) $if['available'];
						}
					}
					$avail === 1 ? $up++ : $down[] = $h['name'];
				}
				$checks[] = [_('Agents answer'), $down ? false : true, $down ? _s('%1$s of %2$s answer; not: %3$s', $up, count($servers), implode(', ', array_slice($down, 0, 3))) : ''];
			}
			if ($now['ulm'] !== null) {
				$u = $items[$now['ulm']['hostid']] ?? [];
				$err = $u['ulm.error'] ?? null;
				$ran = $u['ulm.check'] ?? null;
				$checks[] = [_('Log archive check ran'), $ran === null || (int) $ran['lastclock'] === 0 ? null : ($err === null || $err['lastvalue'] === ''),
					$err !== null && $err['lastvalue'] !== '' ? $err['lastvalue'] : ''];
				$checks[] = [_('tag1 values discovered'), isset($tags1[$now['ulm']['hostid']]) ? true : null, ''];
			}
			[$kind, $target] = ClientSpec::monitoredBy((string) ($m['{$EP.MONITORED.BY}'] ?? '')) ?? ['server', ''];
			if ($kind === 'proxy') {
				$checks[] = self::proxy($proxies[$target] ?? null, time());
			}
			elseif ($kind === 'group') {
				$checks[] = self::proxyGroup($groups[$target] ?? null);
			}
			$out[$client] = $checks;
		}
		return $out;
	}

	/** The proxy check, from its last access (null: no such proxy). Marked 'proxy' so the list can say "proxy down". */
	public static function proxy(?int $seen, int $now): array {
		return [_('Proxy answers'), $seen === null ? false : $now - $seen < 300,
			$seen === null ? _('proxy not in Zabbix') : ($seen ? _s('last seen %1$s', date('d M H:i', $seen)) : _('never seen')), 'proxy'];
	}

	/** A proxy group by its state (Zabbix 7.0: 0 unknown, 1 offline, 2 recovering, 3 online, 4 degrading). */
	public static function proxyGroup(?int $state): array {
		$words = [0 => _('state not known yet'), 1 => _('offline: no proxy of the group answers'), 2 => _('recovering'), 3 => _('online'), 4 => _('degrading: some proxies do not answer')];
		return [_('Proxy group answers'), $state === null ? false : ($state === 0 ? null : in_array($state, [2, 3], true)),
			$state === null ? _('proxy group not in Zabbix') : ($words[$state] ?? (string) $state), 'proxy'];
	}

	/** Whether a client's checks say its proxy (or proxy group) is down. */
	public static function proxyDown(array $checks): ?string {
		foreach ($checks as $c) {
			if (($c[3] ?? '') === 'proxy' && $c[1] === false) {
				return $c[2];
			}
		}
		return null;
	}

	/** An item as a check: working (true), failing (false, with Zabbix's error), or not measured yet (null). */
	private static function item(?array $it, string $label): array {
		if ($it === null) {
			return [$label, null, _('no such check yet')];
		}
		if ($it['state'] == ITEM_STATE_NOTSUPPORTED) {
			return [$label, false, mb_substr((string) $it['error'], 0, 160)];
		}
		return [$label, (int) $it['lastclock'] > 0 ? true : null, ''];
	}
}
