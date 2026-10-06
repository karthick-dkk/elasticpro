<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use Exception;
use Modules\EpClients\Lib\{ClientSpec, ClientState, Registry};

/**
 * Hosts deleted in Zabbix behind the page's back: re-create them as they were (roles, groups,
 * templates; new history), or accept that they are gone. A client whose master host was deleted
 * comes back whole from what the page last recorded. Hosts renamed or moved out of the client's
 * group in Zabbix are put back (name, group) instead: they still exist.
 */
class ClientRecreate extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'required|string', 'op' => 'required|in recreate,accept,putback']);
	}

	protected function doAction(): void {
		$client = trim((string) $this->getInput('client'));
		$record = Registry::all()[$client] ?? null;
		if ($record === null) {
			$this->toList(_('Nothing to do'), [], true, _s('Nothing is recorded for "%1$s".', $client));
			return;
		}
		$rec = $this->rec();
		$now = $rec->current($client);
		$diff = Registry::compare($client, $now, $this->existingHosts());
		$gone = $diff['removed'];
		try {
			if ($this->getInput('op') === 'putback') {
				$gid = $rec->groupId($client, false);
				$lines = [];
				foreach ($diff['changed'] as $id => $h) {
					if ($h['why'] === 'moved' && $gid !== null) {
						API::Host()->massAdd(['hosts' => [['hostid' => (string) $id]], 'groups' => [['groupid' => $gid]]]);
						$lines[] = _s('"%1$s" is back in group %2$s.', $h['now'], $client);
					}
					if ($h['now'] !== $h['name']) {
						API::Host()->update(['hostid' => (string) $id, 'host' => $h['name'], 'name' => $h['name']]);
						$lines[] = _s('"%1$s" is named "%2$s" again.', $h['now'], $h['name']);
					}
				}
				$this->noteChange($client, 'put back');
				$this->toList(_s('Put back what was changed outside for "%1$s"', $client), $lines ?: [_('Nothing was changed outside.')]);
				return;
			}
			if ($this->getInput('op') === 'accept') {
				if ($now['master'] === null) {
					Registry::forget($client);
					$this->toList(_s('"%1$s" forgotten', $client), [_('Its master host is gone from Zabbix; the client is no longer listed.')]);
					return;
				}
				Registry::accept($client, array_keys($gone));
				$this->noteChange($client, 'removal accepted');
				$this->toList(_s('Removal accepted for "%1$s"', $client), array_map(fn($h) => _s('"%1$s" leaves the client.', $h['name']), $gone));
				return;
			}
			// What Zabbix has now, plus the servers it lost; or, with no master, the last record.
			$spec = $this->spec();
			$form = $now['master'] !== null ? ClientState::plain($this->state($rec)->formFor($client)) : $spec->upgradeForm($record['form']);
			$servers = (array) json_decode((string) $form['servers'], true);
			$have = array_column($servers, 'ip');
			foreach ((array) json_decode((string) ($record['form']['servers'] ?? '[]'), true) as $s) {
				foreach ($gone as $h) {
					if ($h['kind'] === 'server' && $h['ip'] === $s['ip'] && !in_array($s['ip'], $have, true)) {
						$servers[] = $s;
					}
				}
			}
			$form['servers'] = $spec->canonServers($servers);
			['client' => $c, 'errors' => $errors] = $spec->fromForm($form);
			if ($errors) {
				throw new Exception(implode(' ', $errors));
			}
			$this->backup('Re-create '.$client);
			$rec->apply($c);
			$this->noteChange($client, 're-created');
			$this->toList(_s('Re-created what Zabbix lost for "%1$s"', $client), $rec->done());
		}
		catch (Exception $e) {
			$this->toList(_s('"%1$s" not re-created', $client), $rec->done(), true, $e->getMessage());
		}
	}
}
