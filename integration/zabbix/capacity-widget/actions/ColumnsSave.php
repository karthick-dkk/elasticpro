<?php declare(strict_types = 0);

namespace Modules\EpCapacity\Actions;

require_once __DIR__.'/../lib/Store.php';
require_once __DIR__.'/../lib/ColumnSettings.php';

use CController;
use CControllerResponseData;
use Modules\EpCapacity\Lib\ColumnSettings;

/**
 * Save or reset a report's column settings (the Columns dialog). Super admins only; one setting
 * for everyone. Answers JSON: {ok: true} or {ok: false, error}.
 *
 * Shared: ../../sync-assets.mjs copies this into each widget module, under its namespace.
 */
class ColumnsSave extends CController {

	protected function checkInput(): bool {
		return $this->validateInput(['report' => 'required|in resources,volume,capacity', 'settings' => 'string', 'reset' => 'in 1']);
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		try {
			$report = (string) $this->getInput('report');
			if ($this->hasInput('reset')) {
				ColumnSettings::reset($report);
			}
			else {
				$in = json_decode((string) $this->getInput('settings', '{}'), true);
				ColumnSettings::save($report, is_array($in) ? $in : [], null);
			}
			$out = ['ok' => true];
		}
		catch (\Throwable $e) {
			$out = ['ok' => false, 'error' => $e->getMessage()];
		}
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($out)]));
	}
}
