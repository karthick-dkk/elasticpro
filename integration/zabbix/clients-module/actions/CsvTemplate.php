<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CControllerResponseData;
use Modules\EpClients\Lib\Csv;

/** The empty CSV templates: clients.csv (a column set per role) or servers.csv (kind=servers). */
class CsvTemplate extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['kind' => 'in clients,servers']);
	}

	protected function doAction(): void {
		$servers = $this->getInput('kind', 'clients') === 'servers';
		$response = new CControllerResponseData(['main_block' => $servers ? Csv::exportServers($this->roles(), []) : Csv::export($this->roles(), []),
			'mime_type' => 'text/csv']);
		$response->setFileName($servers ? 'servers-template.csv' : 'clients-template.csv');
		$this->setResponse($response);
	}
}
