<?php declare(strict_types = 0);
/**
 * @var CView $this
 * @var array $data
 */

$url = fn(string $action, array $args = []) => array_reduce(array_keys($args), fn($u, $k) => $u->setArgument($k, $args[$k]),
	(new CUrl('zabbix.php'))->setArgument('action', $action))->getUrl();

$page = (new CHtmlPage())->setTitle(_('Backups'))
	->setControls((new CTag('nav', true, (new CList())->addItem(new CRedirectButton(_('Back to clients'), $url('ep.clients.list'))))));

$page->addItem((new CDiv(_('Taken automatically before every change — import, save, removal, role change, restore. The newest three are kept.')))->addClass('ep-soft'));
if (!$data['store_ok']) {
	$page->addItem((new CDiv(_s('%1$s is missing or not writable: no backups can be kept, and changes are refused.', $data['store_dir'])))->addClass('msg-bad')->addClass('ep-box'));
}

$table = (new CTableInfo())->setHeader([_('Taken'), _('Before'), _('By'), _('Clients'), _('Servers'), _('Actions')])
	->setNoDataMessage(_('No backups yet — the first is taken before the first change.'));
foreach ($data['backups'] as $b) {
	$restore = (new CForm('post', $url('ep.clients.backup.restore')))
		->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.backup.restore'))
		->addVar('id', $b['id'])->addClass('ep-inline')
		->addItem((new CSubmit('restore', _('Restore')))->addClass('btn-link')->onClick('return confirm('.json_encode(_s(
			'Restore the backup of %1$s? Every client goes back to how it was then: settings, servers and roles. Clients added since are removed (only hosts this page made). Hosts deleted since are created again — their history cannot come back. A backup of the present is taken first, so this can be undone.',
			date('d M H:i', $b['taken']))).');'));
	$table->addRow([date('d M Y H:i', $b['taken']), $b['before'], $b['by'], $b['clients'], $b['machines'],
		[new CLink('clients.csv', $url('ep.clients.backup.download', ['id' => $b['id']])), ' · ',
			new CLink('servers.csv', $url('ep.clients.backup.download', ['id' => $b['id'], 'kind' => 'servers'])), ' · ', $restore]]);
}
$page->addItem($table)->show();
?>
<style>
	.ep-inline { display: inline; } .ep-inline .btn-link { padding: 0; }
	.ep-soft { opacity: .85; margin: 0 0 8px; } .ep-box { margin: 10px 0; padding: 10px 12px; }
</style>
