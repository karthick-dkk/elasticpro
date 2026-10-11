<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\{JumpTemplate, Reconciler};

/**
 * Test connection on a client's page: ask Zabbix to run the cluster check (over HTTP, or through
 * the jump host) and every server's agent check now, then read back what they found. Answers
 * JSON. op=start returns the checks and when they were asked; op=read their state since then.
 */
class TestConnection extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'required|string', 'op' => 'required|in start,read', 'since' => 'string']);
	}

	protected function doAction(): void {
		$rec = $this->rec();
		$now = $rec->current(trim((string) $this->getInput('client')));
		$checks = [];
		if ($now['cluster'] !== null) {
			$jump = Reconciler::hasTemplate($now['cluster'], JumpTemplate::name());
			$keys = $jump ? [JumpTemplate::FAST => _('SSH to the jump host and curl.exe'), 'ep.wj.problem[fast]' => _('Elasticsearch answers through it'), 'es.cluster.status' => _('Cluster health')]
				: ['es.cluster.get_health' => _('Elasticsearch answers over HTTP')];
			foreach (API::Item()->get(['output' => ['itemid', 'key_'], 'hostids' => [$now['cluster']['hostid']], 'filter' => ['key_' => array_keys($keys)]]) as $it) {
				$checks[$it['itemid']] = ['label' => $keys[$it['key_']], 'host' => $now['cluster']['name'], 'key' => $it['key_'], 'run' => $it['key_'] !== 'ep.wj.problem[fast]' && $it['key_'] !== 'es.cluster.status'];
			}
		}
		$servers = array_filter($now['machines'], fn($h) => $h['_roles']);
		if ($servers) {
			foreach (API::Item()->get(['output' => ['itemid', 'hostid', 'key_'], 'hostids' => array_keys($servers), 'filter' => ['key_' => 'agent.ping']]) as $it) {
				$checks[$it['itemid']] = ['label' => _('Agent answers'), 'host' => $servers[$it['hostid']]['name'], 'key' => 'agent.ping', 'run' => true];
			}
		}
		if ($this->getInput('op') === 'start') {
			$run = array_keys(array_filter($checks, fn($c) => $c['run']));
			if ($run) {
				API::Task()->create(array_map(fn($id) => ['type' => ZBX_TM_TASK_CHECK_NOW, 'request' => ['itemid' => (string) $id]], $run));
			}
			$out = ['since' => time(), 'checks' => array_map(fn($id, $c) => ['itemid' => (string) $id] + $c, array_keys($checks), $checks)];
		}
		else {
			$since = (int) $this->getInput('since', '0');
			$items = $checks ? API::Item()->get(['output' => ['itemid', 'state', 'error', 'lastclock', 'lastvalue'], 'itemids' => array_keys($checks), 'preservekeys' => true]) : [];
			$out = ['checks' => []];
			foreach ($checks as $id => $c) {
				$it = $items[$id] ?? null;
				$fresh = $it !== null && ((int) $it['lastclock'] >= $since || ($it['state'] == ITEM_STATE_NOTSUPPORTED));
				$ok = $it !== null && $it['state'] == ITEM_STATE_NORMAL && (int) $it['lastclock'] > 0;
				$value = $it['lastvalue'] ?? '';
				if ($c['key'] === 'ep.wj.problem[fast]') {
					$ok = $ok && $value === '';
					$said = $value !== '' ? $value : _('every answer HTTP 200');
				}
				elseif ($c['key'] === 'es.cluster.status') {
					$said = [0 => 'green', 1 => 'yellow', 2 => 'red'][(int) $value] ?? _('unknown');
				}
				elseif ($c['key'] === 'agent.ping') {
					$ok = $ok && $value === '1';
					$said = $ok ? _('answered') : ((string) ($it['error'] ?? '') !== '' ? (string) $it['error'] : _('no answer'));
				}
				else {
					$said = $ok ? _('answered') : (string) ($it['error'] ?? '');
				}
				$out['checks'][] = ['itemid' => (string) $id, 'label' => $c['label'], 'host' => $c['host'], 'done' => $fresh || !$c['run'],
					'ok' => $ok, 'said' => $ok || $it === null ? $said : ((string) $it['error'] !== '' ? (string) $it['error'] : $said)];
			}
		}
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($out)]));
	}
}
