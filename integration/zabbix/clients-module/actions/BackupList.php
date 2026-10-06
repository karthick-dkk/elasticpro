<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use CControllerResponseData;
use Modules\EpClients\Lib\{Backups, Store};

class BackupList extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		$response = new CControllerResponseData(['backups' => Backups::list(), 'store_ok' => Store::writable(), 'store_dir' => Store::dir()]);
		$response->setTitle(_('Client backups'));
		$this->setResponse($response);
	}
}
