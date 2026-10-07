<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\Reconciler;

/**
 * Hosts in Zabbix matching what is typed in the add-server sheet — by IP or by name — with the
 * client each already belongs to, so the sheet can offer the free ones and say why the others
 * cannot be chosen. Answers JSON: {hosts: [{name, ip, client, status}]}.
 *
 * status is the Zabbix host status, 0 monitored and 1 not monitored. A not-monitored host is
 * still answered: adoption at save time does not look at the status, so leaving it out would
 * make the sheet say "Not in Zabbix — it will be created" and then adopt that very host.
 */
class HostSearch extends Base {

	/**
	 * How many hosts each of the two candidate queries may return. It is a pre-limit: Zabbix
	 * applies it before the hosts without an agent interface are dropped and before the owner of
	 * each is worked out, so at 20 an install with hundreds of hosts answered an almost arbitrary
	 * twenty and a host the operator knew by name could not be found at all.
	 */
	private const CANDIDATES = 200;

	/** How many are answered, by name; the sheet's dropdown shows the first few of these. */
	private const ANSWER = 20;

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
				'filter' => ['type' => INTERFACE_TYPE_AGENT], 'limit' => self::CANDIDATES]);
			// Sorted, so which CANDIDATES come back is the same answer every time the same thing is typed.
			$byName = API::Host()->get(['output' => ['hostid'], 'search' => ['name' => $q], 'sortfield' => 'name',
				'limit' => self::CANDIDATES, 'preservekeys' => true]);
			$ids = array_values(array_unique(array_merge(array_column($byIp, 'hostid'), array_keys($byName))));
			$clients = (new Reconciler($this->spec()))->clientGroups();
			foreach ($ids ? API::Host()->get(['output' => ['hostid', 'name', 'status'], 'hostids' => $ids, 'selectHostGroups' => ['name'],
					'selectInterfaces' => ['ip', 'type', 'main'], 'selectTags' => ['tag', 'value'], 'sortfield' => 'name']) : [] as $h) {
				$ip = Reconciler::agentIp($h);
				if ($ip === null) {
					continue;
				}
				$owner = array_values(array_intersect(Reconciler::groupNames($h), $clients))[0] ?? (Reconciler::tagValues($h, 'ep-client')[0] ?? '');
				$hosts[] = ['name' => $h['name'], 'ip' => $ip, 'client' => $owner, 'status' => (int) $h['status']];
			}
		}
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode(['hosts' => array_slice($hosts, 0, self::ANSWER)])]));
	}
}
