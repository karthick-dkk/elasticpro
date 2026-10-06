<?php declare(strict_types = 0);
/**
 * Families and roles.
 *
 * @var CView $this
 * @var array $data
 */

$url = fn(string $action, array $args = []) => array_reduce(array_keys($args), fn($u, $k) => $u->setArgument($k, $args[$k]),
	(new CUrl('zabbix.php'))->setArgument('action', $action))->getUrl();
$op = function(string $op, string $label, array $vars = [], string $confirm = '') use ($url) {
	$f = (new CForm('post', $url('ep.clients.role.save')))->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.role.save'))
		->addVar('op', $op)->addClass('ep-inline');
	foreach ($vars as $k => $v) {
		$f->addVar($k, $v);
	}
	$b = (new CSubmit('go', $label))->addClass('btn-link');
	if ($confirm !== '') {
		$b->onClick('return confirm('.json_encode($confirm).');');
	}
	return $f->addItem($b);
};

$page = (new CHtmlPage())->setTitle(_('Roles'))
	->setControls((new CTag('nav', true, (new CList())->addItem(new CRedirectButton(_('Back to clients'), $url('ep.clients.list'))))));
$page->addItem((new CDiv(_('A family (ES, Parser, Forwarder, Engine) groups roles — the kinds of machine. Every machine joins its role\'s host group and its family\'s. A change here rewrites the master template, so it reaches every client\'s figures, alerts and dashboard, the client form, the CSV and the Client resources report. A backup is taken first.')))->addClass('ep-soft'));
if ($data['template'] !== 'current') {
	$page->addItem((new CDiv(_('The master template does not match these roles yet. It is rewritten with the next change here, or from the Clients page.')))->addClass('msg-warning')->addClass('ep-box'));
}

$table = (new CTableInfo())->setHeader(['', _('Family / role'), _('Id'), _('In host names'), _('Host group'), _('Machines'), _('Actions')]);
$families = $data['roles']['families'];
foreach ($families as $fi => $f) {
	$table->addRow([
		[$fi > 0 ? $op('up', '▲', ['id' => $f['id']]) : '', ' ', $fi < count($families) - 1 ? $op('down', '▼', ['id' => $f['id']]) : ''],
		new CTag('b', true, $f['label']), $f['id'], '—', $f['group'], $data['counts'][$f['group']] ?? 0,
		[new CLink(_('Edit'), $url('ep.clients.roles', ['edit' => $f['id']])), ' · ', new CLink(_('Add role'), $url('ep.clients.roles', ['family' => $f['id']])),
			' · ', $op('remove', _('Remove'), ['id' => $f['id']], _s('Remove family "%1$s" and its roles? Only possible when none of them has machines.', $f['label']))]
	]);
	foreach ($f['roles'] as $ri => $r) {
		$table->addRow([
			[$ri > 0 ? $op('up', '▲', ['id' => $r['id']]) : '', ' ', $ri < count($f['roles']) - 1 ? $op('down', '▼', ['id' => $r['id']]) : ''],
			(new CSpan($r['label']))->addClass('ep-indent'), $r['id'], $r['short'], $r['group'], $data['counts'][$r['group']] ?? 0,
			[new CLink(_('Edit'), $url('ep.clients.roles', ['edit' => $r['id']])),
				count($f['roles']) > 1 ? [' · ', $op('remove', _('Remove'), ['id' => $r['id']], _s('Remove role "%1$s"? Only possible when it has no machines.', $r['label']))] : '']
		]);
	}
}
$page->addItem($table);

// The form: edit one, add a role to a family, or add a family.
$editing = null;
foreach ($families as $f) {
	if ($f['id'] === $data['edit']) {
		$editing = ['kind' => 'family'] + $f;
	}
	foreach ($f['roles'] as $r) {
		if ($r['id'] === $data['edit']) {
			$editing = ['kind' => 'role'] + $r;
		}
	}
}
$form = (new CForm('post', $url('ep.clients.role.save')))->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.role.save'))->setId('ep-role-form');
$grid = new CFormGrid();
$field = fn(string $label, string $name, string $value, string $hint = '', bool $ro = false) => [new CLabel($label, 'r-'.$name),
	new CFormField([(new CTextBox($name, $value, $ro))->setId('r-'.$name)->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH), $hint !== '' ? (new CDiv($hint))->addClass('ep-hint') : null])];
if ($editing !== null) {
	$form->addVar('op', $editing['kind'] === 'family' ? 'edit_family' : 'edit_role')->addVar('id', $editing['id']);
	$grid->addItem([(new CTag('h4', true, _s('Edit %1$s', $editing['label']))), new CFormField('')])
		->addItem($field(_('Name'), 'label', $editing['label']));
	if ($editing['kind'] === 'role') {
		$grid->addItem($field(_('In host names'), 'short', $editing['short'], _('Changing it renames this role\'s machines at each client\'s next save.')));
	}
	$grid->addItem($field(_('Host group'), 'group', $editing['group'], _('Machines are moved at each client\'s next save.')));
	if ($editing['kind'] === 'role') {
		$grid->addItem($field(_('Templates'), 'templates', implode(', ', (array) ($editing['templates'] ?? [])), _s('Templates new servers of this role get, comma-separated. Empty: %1$s. Existing servers gain them at the client\'s next save; nothing is unlinked.', $data['templates']['agent'])));
	}
}
elseif ($data['family'] !== '') {
	$form->addVar('op', 'add_role')->addVar('family', $data['family']);
	$grid->addItem([(new CTag('h4', true, _s('Add a role to %1$s', $data['family']))), new CFormField('')])
		->addItem($field(_('Name'), 'label', '', _('e.g. AIML')))
		->addItem($field(_('Id'), 'id', '', _('lower-case, e.g. aiml — used in item keys and CSV columns; cannot be changed later.')))
		->addItem($field(_('In host names'), 'short', '', _('e.g. AIML → example-AIML-1')))
		->addItem($field(_('Host group'), 'group', '', _('Created if it does not exist.')))
		->addItem($field(_('Templates'), 'templates', '', _s('Templates new servers of this role get, comma-separated. Empty: %1$s. Existing servers gain them at the client\'s next save; nothing is unlinked.', $data['templates']['agent'])));
}
else {
	$form->addVar('op', 'add_family');
	$grid->addItem([(new CTag('h4', true, _('Add a family'))), new CFormField('')])
		->addItem($field(_('Name'), 'label', '', _('e.g. SOAR')))
		->addItem($field(_('Id'), 'id', '', _('lower-case, e.g. soar; its first role is created with it.')))
		->addItem($field(_('In host names'), 'short', '', _('e.g. SOAR → example-SOAR-1')))
		->addItem($field(_('Host group'), 'group', '', _('The family\'s group; created if it does not exist.')))
		->addItem($field(_('Macro prefix'), 'macroPrefix', '', _('e.g. SOAR → {$SOAR.CPU.REQUESTED} on the cluster host, as the cluster template names them.')));
}
$grid->addItem([new CLabel(''), new CFormField([new CSubmit('save', $editing !== null ? _('Save') : _('Add')), ' ',
	$editing !== null || $data['family'] !== '' ? new CRedirectButton(_('Cancel'), $url('ep.clients.roles')) : null])]);
$page->addItem($form->addItem($grid));

// Template names. A Zabbix whose templates are called something else — a site's own names, or
// the ones an earlier release shipped — is pointed at them here instead of in PHP.
$tplForm = (new CForm('post', $url('ep.clients.role.save')))->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.role.save'))
	->addVar('op', 'set_templates')->setId('ep-template-form');
$tplGrid = (new CFormGrid())
	->addItem([(new CTag('h4', true, _('Template names'))), new CFormField('')])
	->addItem($field(_('Elasticsearch cluster'), 'cluster_template', $data['templates']['cluster'],
		_s('The template the cluster host is linked to. Empty: %1$s.', \Modules\EpClients\Lib\Roles::DEFAULT_CLUSTER_TEMPLATE)))
	->addItem($field(_('Linux agent'), 'agent_template', $data['templates']['agent'],
		_s('The template a server gets when its role names none. Empty: %1$s.', \Modules\EpClients\Lib\Roles::DEFAULT_TEMPLATE)))
	->addItem([new CLabel(''), new CFormField(new CSubmit('save', _('Save')))]);
$page->addItem($tplForm->addItem($tplGrid))->show();
?>
<style>
	.ep-inline { display: inline; } .ep-inline .btn-link { padding: 0; }
	.ep-soft { opacity: .85; margin: 0 0 8px; max-width: 110ch; } .ep-box { margin: 10px 0; padding: 10px 12px; }
	.ep-indent { padding-left: 18px; } .ep-hint { opacity: .75; margin-top: 3px; }
	#ep-role-form, #ep-template-form { margin-top: 18px; }
</style>
