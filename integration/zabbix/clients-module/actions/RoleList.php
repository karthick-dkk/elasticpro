<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\{Roles, Store, TemplateInstaller};

/** Families and their roles, with how many machines each has across every client. */
class RoleList extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['edit' => 'string', 'family' => 'string']);
	}

	protected function doAction(): void {
		$roles = $this->roles();
		$counts = [];
		foreach (Roles::groups($roles) as $g) {
			$found = API::HostGroup()->get(['output' => ['groupid'], 'filter' => ['name' => $g], 'selectHosts' => API_OUTPUT_COUNT]);
			$counts[$g] = $found ? (int) $found[0]['hosts'] : 0;
		}
		$response = new CControllerResponseData([
			'roles' => $roles,
			'counts' => $counts,
			'edit' => (string) $this->getInput('edit', ''),
			'family' => (string) $this->getInput('family', ''),
			'template' => TemplateInstaller::status($roles),
			'templates' => Roles::templateNames(),
			'store_ok' => Store::writable(),
			'store_dir' => Store::dir()
		]);
		$response->setTitle(_('Client roles'));
		$this->setResponse($response);
	}
}
