<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\{ClientSpec, Forecast, History, MasterTemplate, Lifecycle, Registry, Roles, SetupChecks, Store, TemplateInstaller};

/**
 * The clients, by status: each with its type, ES URL, contacts, servers per family, setup checks,
 * open problems, days until its storage fills, hosts removed from Zabbix, and last change. A
 * client whose master host was deleted in Zabbix stays listed from the register, with a way back.
 * Above: whether the templates are current and backups can be kept.
 */
class ClientList extends Base {

	protected const READ_ONLY_OK = true;

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		$roles = $this->roles();
		$byId = Roles::byId($roles);
		$rec = $this->rec();
		$state = $this->state($rec);
		$live = $state->clients();
		$registry = Registry::all();
		$changes = Store::read('changes.json', []);
		$maint = Lifecycle::maintenances(array_keys($live));

		$nows = [];
		$macros = [];
		foreach ($live as $name => $c) {
			$nows[$name] = $rec->current($name);
			$macros[$name] = $c['macros'];
			// First sight of a client the register does not know yet: remember it as it is.
			if (!isset($registry[$name]) && Store::writable() && $this->canWrite()) {
				$this->register($name);
			}
		}
		$registry = Registry::all();
		$exists = $this->existingHosts();
		$checks = SetupChecks::forClients($nows, $macros);

		// Open problems, by severity; when each client's storage fills; how much of what it bought it uses.
		$problems = [];
		$figures = [];
		$masterIds = array_filter(array_map(fn($c) => $c['masterid'], $live));
		foreach ($masterIds ? API::Item()->get(['output' => ['hostid', 'key_', 'lastvalue', 'lastclock', 'state'], 'hostids' => array_values($masterIds),
				'filter' => ['key_' => array_merge([Forecast::KEY], array_values(MasterTemplate::OVER))]]) : [] as $it) {
			$figures[$it['hostid']][$it['key_']] = $it['state'] == ITEM_STATE_NORMAL && (int) $it['lastclock'] > 0 ? (float) $it['lastvalue'] : null;
		}
		foreach ($nows as $name => $now) {
			if ($now['groupid'] === null) {
				continue;
			}
			$sev = [];
			foreach (API::Trigger()->get(['output' => ['priority'], 'groupids' => [$now['groupid']], 'filter' => ['value' => TRIGGER_VALUE_TRUE],
					'monitored' => true, 'skipDependent' => true]) as $t) {
				$sev[(int) $t['priority']] = ($sev[(int) $t['priority']] ?? 0) + 1;
			}
			$problems[$name] = $sev;
		}

		$clients = [];
		foreach ($live as $name => $c) {
			$now = $nows[$name];
			$m = $c['macros'];
			$counts = [];
			foreach ($roles['families'] as $f) {
				$hosts = [];
				foreach ($now['machines'] as $h) {
					foreach ($h['_roles'] as $rid) {
						if (isset($byId[$rid]) && in_array($f['id'], Roles::familiesOf($byId[$rid]), true)) {
							$hosts[$h['hostid']] = true;
						}
					}
				}
				if ($hosts) {
					$counts[] = count($hosts).' '.$f['label'];
				}
			}
			$search = [$name, $m['{$ES.URL}'] ?? ''];
			foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
				$search[] = $h['name'];
				if (!empty($h['_ip'])) {
					$search[] = $h['_ip'];
				}
			}
			$status = Lifecycle::statusOf($m);
			$bucket = $m['{$ULM.S3.BUCKET}'] ?? '';
			// The register knows hosts beyond what a read-only viewer may see: only for Super admins.
			$diff = $this->canWrite() ? Registry::compare($name, $now, $exists) : ['removed' => [], 'changed' => []];
			$fullIn = $figures[$c['masterid']][Forecast::KEY] ?? null;
			$over = [];
			foreach (MasterTemplate::OVER as $basis => $key) {
				$pct = $figures[$c['masterid']][$key] ?? null;
				if ($pct !== null && $pct > 100) {
					$over[$basis] = $pct;
				}
			}
			$clients[] = [
				'name' => $name,
				'masterid' => $c['masterid'],
				'status' => $status,
				'maintenance' => $maint[$name] ?? null,
				'type' => $m['{$EP.CLIENT.TYPE}'] ?? 'On-Prem',
				'es_url' => $m['{$ES.URL}'] ?? '',
				'jump' => ($m['{$EP.MONITORED.BY}'] ?? '') === 'jump' ? ($m['{$EP.JUMP.HOST}'] ?? '') : '',
				'archive' => $bucket !== '' && $bucket !== ClientSpec::UNSET_BUCKET ? $bucket : '',
				'lead' => $m['{$EP.LEAD}'] ?? '',
				'dl' => $m['{$EP.DL}'] ?? '',
				'contract_end' => $m['{$EP.CONTRACT.END}'] ?? '',
				'machines' => $counts ? implode(' · ', $counts) : '—',
				'unassigned' => count($now['unassigned']),
				'shared' => count($now['shared']),
				'removed' => array_values($diff['removed']),
				'changed' => array_values($diff['changed']),
				'checks' => $checks[$name] ?? [],
				'problems' => $problems[$name] ?? [],
				'full_in' => $fullIn,
				'over' => $over,
				'change' => $changes[$name] ?? null,
				'search' => strtolower(implode(' ', $search)),
				'master_missing' => false
			];
		}
		// Recorded but its master host gone from Zabbix: still listed, with a way back.
		foreach ($this->canWrite() ? $registry : [] as $name => $r) {
			if (isset($live[$name])) {
				continue;
			}
			$f = $r['form'] ?? [];
			$clients[] = ['name' => $name, 'masterid' => null, 'status' => 'active', 'maintenance' => null, 'type' => $f['type'] ?? 'On-Prem',
				'es_url' => $f['es_url'] ?? '', 'jump' => '', 'archive' => '', 'lead' => $f['lead_name'] ?? '', 'dl' => $f['cluster_dl'] ?? '',
				'contract_end' => $f['contract_end'] ?? '', 'machines' => '—', 'unassigned' => 0, 'shared' => 0, 'removed' => array_values(array_diff_key($r['hosts'] ?? [], $exists)), 'changed' => array_values(array_intersect_key($r['hosts'] ?? [], $exists)),
				'checks' => [], 'problems' => [], 'full_in' => null, 'over' => [], 'change' => $changes[$name] ?? null, 'search' => strtolower($name), 'master_missing' => true];
		}
		usort($clients, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));

		$response = new CControllerResponseData([
			'clients' => $clients,
			'candidates' => $state->candidates($live),
			'template' => TemplateInstaller::status($roles),
			'store_ok' => Store::writable(),
			'can_write' => $this->canWrite(),
			'store_dir' => Store::dir(),
			'backups' => count(Store::listing('backups'))
		]);
		$response->setTitle(_('ElasticPro — Cluster Management'));
		$this->setResponse($response);
	}
}
