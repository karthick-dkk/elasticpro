<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CMessageHelper;
use Exception;

/**
 * Change clients' status — one, or several ticked on the list: disable, enable, decommission,
 * restore, start or end maintenance. One backup first for all of them; each client is changed on
 * its own, so one refusal does not stop the others.
 */
class ClientStatus extends Base {

	private const OPS = ['disable', 'enable', 'decommission', 'restore', 'maintenance', 'end_maintenance'];

	protected function checkInput(): bool {
		return $this->validateInput([
			'op' => 'required|in '.implode(',', self::OPS),
			'client' => 'string', 'clients' => 'array',
			'start' => 'string', 'hours' => 'string', 'collect' => 'in 0,1', 'reason' => 'string'
		]);
	}

	protected function doAction(): void {
		$op = $this->getInput('op');
		$clients = array_values(array_filter(array_map('strval', array_merge(
			$this->hasInput('client') ? [$this->getInput('client')] : [],
			array_keys(array_filter((array) $this->getInput('clients', []), fn($v) => (string) $v === '1'))))));
		if (!$clients) {
			$this->toList(_('Nothing changed'), [], true, _('Tick at least one client.'));
			return;
		}
		$words = ['disable' => _('Disable'), 'enable' => _('Enable'), 'decommission' => _('Decommission'), 'restore' => _('Restore'),
			'maintenance' => _('Maintenance'), 'end_maintenance' => _('End maintenance')];
		try {
			$this->backup($words[$op].' '.implode(', ', $clients));
		}
		catch (Exception $e) {
			$this->toList(_('Nothing changed'), [], true, $e->getMessage());
			return;
		}
		$lines = [];
		$failed = false;
		foreach ($clients as $client) {
			$life = $this->lifecycle();
			try {
				switch ($op) {
					case 'disable': $life->disable($client); break;
					case 'enable': $life->enable($client); break;
					case 'decommission': $life->decommission($client); break;
					case 'restore': $life->restore($client); break;
					case 'end_maintenance': $life->endMaintenance($client); break;
					case 'maintenance':
						$start = trim((string) $this->getInput('start', ''));
						$since = $start === '' || $start === 'now' ? time() : strtotime($start);
						if ($since === false) {
							throw new Exception(_s('"%1$s" is not a start time.', $start));
						}
						$hours = (float) $this->getInput('hours', '4');
						$life->startMaintenance($client, $since, (int) round($hours * 3600), $this->getInput('collect', '1') === '1',
							trim((string) $this->getInput('reason', '')));
						break;
				}
				$how = ['disable' => 'disabled', 'enable' => 'enabled', 'decommission' => 'decommissioned', 'restore' => 'restored to disabled',
					'maintenance' => 'maintenance', 'end_maintenance' => 'maintenance ended'][$op];
				$this->noteChange($client, $how);
				$lines[] = $client.': '.implode(' ', $life->done());
			}
			catch (Exception $e) {
				$failed = true;
				$lines[] = $client.': '.$e->getMessage();
			}
		}
		// Zabbix queues its own "Updated status of host …" for each host; the lines above say it once per client.
		$errors = array_filter(CMessageHelper::getMessages(), fn($m) => ($m['type'] ?? '') === 'error');
		CMessageHelper::clear();
		array_map([CMessageHelper::class, 'addMessage'], array_values($errors));
		$this->toList($failed ? _s('%1$s: done with problems', $words[$op]) : _s('%1$s: done', $words[$op]), $lines, $failed);
	}
}
