<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;

/**
 * Clients as they are in Zabbix now, in the form's own terms — what the edit form shows, what an
 * export writes, what a backup keeps and what an import is compared with.
 */
class ClientState {

	/** @var ClientSpec */
	private $spec;
	/** @var Reconciler */
	private $rec;

	public function __construct(ClientSpec $spec, Reconciler $rec) {
		$this->spec = $spec;
		$this->rec = $rec;
	}

	/** Every client (a master host carrying the template), by name. */
	public function clients(): array {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => MasterTemplate::NAME]]);
		// A Zabbix Admin may read the hosts but not the templates: then the master hosts by their tag.
		$masters = $tpl ? API::Host()->get(['output' => ['hostid', 'host'], 'templateids' => [$tpl[0]['templateid']]])
			: API::Host()->get(['output' => ['hostid', 'host'], 'tags' => [['tag' => 'ep-kind', 'value' => 'master', 'operator' => TAG_OPERATOR_EQUAL]]]);
		$out = [];
		foreach ($masters ?: [] as $master) {
			$m = $this->rec->macros($master['hostid']);
			$name = ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : preg_replace('/(-Master| master)$/', '', $master['host']);
			$out[$name] = ['name' => $name, 'masterid' => $master['hostid'], 'macros' => $m];
		}
		ksort($out, SORT_NATURAL | SORT_FLAG_CASE);
		return $out;
	}

	/** Elasticsearch cluster hosts that belong to no client yet, each with the client name it suggests. */
	public function candidates(array $clients): array {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => Reconciler::clusterTemplates()[0]]]);
		if (!$tpl) {
			return [];
		}
		$out = [];
		foreach (API::Host()->get(['output' => ['hostid', 'host'], 'templateids' => [$tpl[0]['templateid']]]) as $host) {
			$m = $this->rec->macros($host['hostid']);
			$name = ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : preg_replace('/(-ES-Cluster| cluster)$/', '', $host['host']);
			if (!isset($clients[$name])) {
				$out[] = ['name' => $name, 'host' => $host['host'], 'es_url' => self::urlFrom($m)];
			}
		}
		return $out;
	}

	public static function urlFrom(array $m): string {
		return ($m['{$ELASTICSEARCH.HOST}'] ?? '') !== ''
			? ($m['{$ELASTICSEARCH.SCHEME}'] ?? 'http').'://'.$m['{$ELASTICSEARCH.HOST}'].':'.($m['{$ELASTICSEARCH.PORT}'] ?? '9200')
			: '';
	}

	/**
	 * The form as it stands for a client: the master host's macros when there is one, else what
	 * its cluster host says; the servers as they are. An IP several hosts share is one server
	 * with all their roles (`_shared` names the hosts, for the merge prompt). `_now` carries what
	 * was read, `_unassigned` the servers in a family's group that have no role yet.
	 */
	public function formFor(string $client): array {
		$form = $this->spec->defaults();
		$form['name'] = $client;
		$now = $this->rec->current($client);

		if ($now['master'] !== null) {
			$m = $this->rec->macros($now['master']['hostid']);
			foreach ($this->spec->macroFields() as $field => $macro) {
				if (array_key_exists($macro, $m)) {
					$form[$field] = $m[$macro];
				}
			}
			// A master host from before extra disks: its one mount, when not /, is disk 2.
			foreach (Roles::allRoles($this->spec->roles()) as $r) {
				$form = ClientSpec::legacyDisk($form, $r['id'], (string) ($m[Roles::macro($r['id'], 'ROOTDISK.FS')] ?? ''));
			}
		}
		elseif ($now['cluster'] !== null) {
			$m = $this->rec->macros($now['cluster']['hostid']);
			$form['es_url'] = self::urlFrom($m);
			$form['es_user'] = $m['{$ELASTICSEARCH.USERNAME}'] ?? $form['es_user'];
			$form['purchased'] = $m['{$ES.VOLUME.CUS.PURCHASED}'] ?? $form['purchased'];
			foreach ($now['cluster']['macros'] ?? [] as $cm) {
				if ($cm['macro'] === '{$ELASTICSEARCH.PASSWORD}' && (int) $cm['type'] === ZBX_MACRO_TYPE_SECRET) {
					$form['es_password_mode'] = 'zabbix';
				}
			}
		}
		if ($form['ulm_bucket'] === ClientSpec::UNSET_BUCKET) {
			$form['ulm_bucket'] = '';
		}
		$servers = [];
		foreach ($now['machines'] as $h) {
			if ($h['_ip'] === null || !$h['_roles']) {
				continue;
			}
			$s = $servers[$h['_ip']] ?? ['ip' => $h['_ip'], 'roles' => [], 'services' => [], 'notes' => '', 'attrs' => []];
			$s['roles'] = array_merge($s['roles'], $h['_roles']);
			$s['services'] = array_merge($s['services'], $h['_services']);
			$s['notes'] = $s['notes'] !== '' ? $s['notes'] : $h['_notes'];
			$s['attrs'] = $s['attrs'] + $h['_attrs'];
			$servers[$h['_ip']] = $s;
		}
		// A merge leaves one host per IP, and a Single node cannot share a server: of hosts that
		// share an IP, an all-in-one role takes the place of the rest.
		foreach ($servers as &$s) {
			$byId = Roles::byId($this->spec->roles());
			$excl = array_values(array_filter($s['roles'], fn($rid) => !empty($byId[$rid]['exclusive'])));
			if ($excl) {
				$s['roles'] = [$excl[0]];
			}
		}
		unset($s);
		$form['servers'] = $this->spec->canonServers(array_values($servers));
		$form['_now'] = $now;
		$form['_unassigned'] = array_map(fn($h) => ['name' => $h['name'], 'ip' => $h['_ip'], 'families' => $h['_families'] ?? []], $now['unassigned']);
		$form['_shared'] = array_map(fn($list) => array_map(fn($h) => $h['name'], $list), $now['shared']);
		return $form;
	}

	/** Only the form's own fields — what a backup keeps and a comparison looks at. */
	public static function plain(array $form): array {
		return array_filter($form, fn($k) => $k[0] !== '_', ARRAY_FILTER_USE_KEY);
	}
}
