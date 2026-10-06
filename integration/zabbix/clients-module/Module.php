<?php declare(strict_types = 0);

namespace Modules\EpClients;

use APP;
use CController;
use CMenuItem;
use CViewHelper;
use CWebUser;
use Zabbix\Core\CModule as CoreModule;

/**
 * Puts "Cluster Management" (the Clients page) in the ElasticPro menu: for Super admins, and
 * read-only for Admins.
 *
 * Added before each page is drawn rather than at start-up: the ElasticPro menu belongs to
 * another module, which may start after this one. Without that menu, it goes under
 * Data collection instead of disappearing.
 *
 * Zabbix marks the current page's menu entry (and keeps its section open) before modules'
 * onBeforeAction runs, so an entry added here would never be marked: the ElasticPro section
 * closed on every Clients page. The selection is run again once the entry is in.
 */
class Module extends CoreModule {

	private $added = false;

	public function onBeforeAction(CController $action): void {
		// Admins see it read-only; the pages that change anything stay Super admin.
		if ($this->added || !in_array(CWebUser::getType(), [USER_TYPE_SUPER_ADMIN, USER_TYPE_ZABBIX_ADMIN])) {
			return;
		}
		$this->added = true;
		$menu = APP::Component()->get('menu.main');
		$item = (new CMenuItem(_('Cluster Management')))->setAction('ep.clients.list')
			->setAliases(['ep.clients.edit', 'ep.clients.save', 'ep.clients.import', 'ep.clients.backups', 'ep.clients.roles']);
		$home = $menu->find(_('ElasticPro')) ?? $menu->find(_('Data collection'));
		if ($home !== null && $home->hasSubMenu()) {
			$home->getSubMenu()->add($item);
			$menu->setSelectedByAction($action->getAction(), $_REQUEST,
				CViewHelper::loadSidebarMode() != ZBX_SIDEBAR_VIEW_MODE_COMPACT);
		}
	}
}
