<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Actions;

require_once __DIR__.'/../lib/Settings.php';
require_once __DIR__.'/../lib/Pairing.php';

use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use Modules\ElasticPro\Lib\Pairing;
use Modules\ElasticPro\Lib\Settings;

/**
 * Administration → ElasticPro: where this Zabbix is connected to ElasticPro.
 * Read-only (GET); every change goes through LinkUpdate, which is CSRF-protected.
 * Super admins only.
 */
class LinkEdit extends CController {

	protected function init(): void {
		// Renders a page and changes nothing; the forms on it post to LinkUpdate, which checks
		// the CSRF token.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		// 'mode' only ever reveals a form on an otherwise read-only page — sanitised in
		// doAction(), not trusted as an enum here, so an unexpected value just falls back
		// to the summary rather than failing the page.
		$ok = $this->validateInput(['mode' => 'string']);
		if (!$ok) {
			$this->setResponse(new CControllerResponseFatal());
		}
		return $ok;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		$mode = (string) $this->getInput('mode', '');
		$response = new CControllerResponseData([
			'status' => Settings::status(),
			'zabbix_url' => Pairing::defaultZabbixUrl(),
			'role_name' => Pairing::spec()['roleName'],
			'user_name' => Pairing::spec()['userName'],
			// Which form GET reveals over the "Current settings" summary once something is
			// configured: '' (summary), 'edit' (manual form) or 'repair' (pairing form).
			'mode' => in_array($mode, ['edit', 'repair'], true) ? $mode : '',
		]);
		$response->setTitle(_('ElasticPro'));
		$this->setResponse($response);
	}
}
