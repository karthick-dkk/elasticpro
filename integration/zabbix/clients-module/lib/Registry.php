<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * What the page last saw of each client: its form and its hosts (id, name, IP, what it is). Kept
 * in the data folder and updated after every change, so a host deleted in Zabbix by someone else
 * shows as "removed from Zabbix" instead of silently vanishing — and so a client whose master
 * host was deleted stays on the list with a way back.
 */
class Registry {

	public const FILE = 'registry.json';

	public static function all(): array {
		return Store::read(self::FILE, []);
	}

	/** Record a client as it is now. */
	public static function record(string $client, array $form, array $now): void {
		$hosts = [];
		foreach (['master', 'cluster', 'ulm'] as $kind) {
			if ($now[$kind] !== null) {
				$hosts[$now[$kind]['hostid']] = ['name' => $now[$kind]['name'], 'ip' => null, 'kind' => $kind, 'roles' => []];
			}
		}
		foreach ($now['machines'] as $h) {
			$hosts[$h['hostid']] = ['name' => $h['name'], 'ip' => $h['_ip'], 'kind' => 'server', 'roles' => $h['_roles']];
		}
		$all = self::all();
		$all[$client] = ['form' => $form, 'hosts' => $hosts, 'at' => time()];
		Store::write(self::FILE, $all);
	}

	public static function forget(string $client): void {
		$all = self::all();
		unset($all[$client]);
		Store::write(self::FILE, $all);
	}

	/** Accept that these hosts are gone: they leave the client's record. */
	public static function accept(string $client, array $hostids): void {
		$all = self::all();
		foreach ($hostids as $id) {
			unset($all[$client]['hosts'][$id]);
		}
		Store::write(self::FILE, $all);
	}

	/** The hosts recorded for a client that Zabbix no longer has at all: hostid => {name, ip, kind, roles}. */
	public static function removed(string $client, array $now, array $exists): array {
		return self::compare($client, $now, $exists)['removed'];
	}

	/**
	 * The client's recorded hosts against Zabbix. `removed`: the host id is gone. `changed`: the host
	 * is there but renamed, or moved out of the client's group (so the page no longer sees it) —
	 * each with `why` (renamed|moved) and `now` (its name in Zabbix). A moved host is never
	 * "removed": re-creating it would make a second host on the same IP.
	 *
	 * @param array $exists hostid => visible name, for the recorded hosts Zabbix still has
	 */
	public static function compare(string $client, array $now, array $exists): array {
		$have = [];
		foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
			$have[$h['hostid']] = $h['name'];
		}
		$out = ['removed' => [], 'changed' => []];
		foreach (self::all()[$client]['hosts'] ?? [] as $id => $h) {
			if (!array_key_exists($id, $exists)) {
				$out['removed'][$id] = $h;
			}
			elseif (!array_key_exists($id, $have)) {
				$out['changed'][$id] = $h + ['why' => 'moved', 'now' => $exists[$id]];
			}
			elseif ($have[$id] !== $h['name']) {
				$out['changed'][$id] = $h + ['why' => 'renamed', 'now' => $have[$id]];
			}
		}
		return $out;
	}

	/** Every recorded host id, for one lookup of which still exist. */
	public static function hostIds(): array {
		$ids = [];
		foreach (self::all() as $r) {
			$ids = array_merge($ids, array_map('strval', array_keys($r['hosts'] ?? [])));
		}
		return array_values(array_unique($ids));
	}
}
