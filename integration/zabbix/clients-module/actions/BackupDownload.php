<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CControllerResponseData;
use Modules\EpClients\Lib\{Backups, Csv};

/** A backup's clients as clients.csv, or its servers as servers.csv (kind=servers), as they were then. */
class BackupDownload extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['id' => 'required|string', 'kind' => 'in clients,servers']);
	}

	protected function doAction(): void {
		$servers = $this->getInput('kind', 'clients') === 'servers';
		$b = Backups::get((string) $this->getInput('id'));
		$csv = $b ? ($servers ? Csv::exportServers($b['roles'], array_values($b['clients'])) : Csv::export($b['roles'], array_values($b['clients']))) : '';
		$response = new CControllerResponseData(['main_block' => $csv, 'mime_type' => 'text/csv']);
		$response->setFileName(($servers ? 'servers' : 'clients').'-backup-'.($b['id'] ?? 'missing').'.csv');
		$this->setResponse($response);
	}
}
