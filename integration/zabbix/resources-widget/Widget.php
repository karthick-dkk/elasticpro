<?php declare(strict_types = 0);

namespace Modules\EpResources;

use Zabbix\Core\CWidget;

class Widget extends CWidget {

	public function getDefaultName(): string {
		return _('Client resources');
	}
}
