<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CControllerResponseData;
use Modules\EpClients\Lib\{ClientState, Csv};

/** Every client as it is now: clients.csv, or servers.csv (kind=servers) — edit in Excel and import back. */
class CsvExport extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['kind' => 'in clients,servers']);
	}

	protected function doAction(): void {
		$servers = $this->getInput('kind', 'clients') === 'servers';
		$state = $this->state();
		$forms = [];
		$names = [];
		foreach ($state->clients() as $name => $_) {
			$form = $state->formFor($name);
			foreach ($form['_now']['machines'] as $h) {
				if ($h['_ip'] !== null) {
					$names[$name][$h['_ip']] = $h['name'];
				}
			}
			$forms[] = ClientState::plain($form);
		}
		$csv = $servers ? Csv::exportServers($this->roles(), $forms, $names) : Csv::export($this->roles(), $forms);
		$response = new CControllerResponseData(['main_block' => $csv, 'mime_type' => 'text/csv']);
		$response->setFileName(($servers ? 'servers-' : 'clients-').date('Y-m-d').'.csv');
		$this->setResponse($response);
	}
}
