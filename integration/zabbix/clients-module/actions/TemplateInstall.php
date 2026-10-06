<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use Exception;
use Modules\EpClients\Lib\{Roles, Store, TemplateInstaller};

/** Write the master and cluster devices templates for the current roles. */
class TemplateInstall extends Base {

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		try {
			TemplateInstaller::install($this->roles());
			// Roles an older version saved are kept upgraded from now on.
			if ((int) (Store::read(Roles::FILE)['version'] ?? 0) < (int) ($this->roles()['version'] ?? 1) && Store::writable()) {
				Roles::save($this->roles());
			}
			$this->toList(_('Master template written for the current roles'), [_('New items show their first values within about ten minutes.')]);
		}
		catch (Exception $e) {
			$this->toList(_('Master template not written'), [], true, $e->getMessage());
		}
	}
}
