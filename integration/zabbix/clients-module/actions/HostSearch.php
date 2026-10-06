<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\Reconciler;

/**
 * Hosts in Zabbix matching what is typed in the add-server sheet — by IP or by name — with the
 * client each already belongs to, so the sheet can offer the free ones and say why the others
 * cannot be chosen. Answers JSON: {hosts: [{name, ip, client}]}.
 */
class HostSearch extends Base {

	private const LIMIT = 20;

	protected function init(): void {
		// Reads only; the Clients pages' Super admin check still applies.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['q' => 'required|string']);
	}

	protected function doAction(): void {
		$q = trim((string) $this->getInput('q'));
		$hosts = [];
		if (mb_strlen($q) >= 2) {
			$byIp = API::HostInterface()->get(['output' => ['hostid', 'ip'], 'search' => ['ip' => $q], 'startSearch' => true,
				'filter' => ['type' => INTERFACE_TYPE_AGENT], 'limit' => self::LIMIT]);
			$byName = API::Host()->get(['output' => ['hostid'], 'search' => ['name' => $q], 'limit' => self::LIMIT, 'preservekeys' => true]);
			$ids = array_values(array_unique(array_merge(array_column($byIp, 'hostid'), array_keys($byName))));
			$clients = (new Reconciler($this->spec()))->clientGroups();
			foreach ($ids ? API::Host()->get(['output' => ['hostid', 'name'], 'hostids' => $ids, 'selectHostGroups' => ['name'],
					'selectInterfaces' => ['ip', 'type', 'main'], 'selectTags' => ['tag', 'value'], 'sortfield' => 'name']) : [] as $h) {
				$ip = Reconciler::agentIp($h);
				if ($ip === null) {
					continue;
				}
				$owner = array_values(array_intersect(Reconciler::groupNames($h), $clients))[0] ?? (Reconciler::tagValues($h, 'ep-client')[0] ?? '');
				$hosts[] = ['name' => $h['name'], 'ip' => $ip, 'client' => $owner];
			}
		}
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode(['hosts' => array_slice($hosts, 0, self::LIMIT)])]));
	}
}
