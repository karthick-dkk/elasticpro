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

/**
 * Zabbix's own template picker, so a template is chosen and never typed. The same template may
 * be picked for as many roles as you like: Roles::templatesOf() already returns each one once,
 * so a server in two roles that name the same template is linked to it a single time.
 *
 * $missing are stored names this Zabbix has not got. The picker works in template ids and
 * cannot hold them, so they ride along in a hidden field and are shown underneath — without
 * that, opening a role and pressing Save would quietly drop a template that had merely been
 * renamed outside this page.
 */
$templatePicker = function (string $name, string $formId, array $known, array $missing, string $hint = '') {
	$ms = (new CMultiSelect([
		'name' => $name.'[]',
		'object_name' => 'templates',
		'data' => $known,
		'popup' => ['parameters' => [
			'srctbl' => 'templates', 'srcfld1' => 'hostid', 'dstfrm' => $formId, 'dstfld1' => $name.'_'
		]]
	]))->setId($name.'_')->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH);
	$items = [$ms];
	if ($missing) {
		$items[] = (new CDiv(_s('Kept as they are, because this Zabbix has no template by these names: %1$s', implode(', ', $missing))))
			->addClass('ep-hint')->addClass('ep-keep');
		$items[] = new CVar($name.'_keep', implode("\n", $missing));
	}
	if ($hint !== '') {
		$items[] = (new CDiv($hint))->addClass('ep-hint');
	}
	return [new CLabel(_('Templates'), $name.'_'), new CFormField($items)];
};
if ($editing !== null) {
	$form->addVar('op', $editing['kind'] === 'family' ? 'edit_family' : 'edit_role')->addVar('id', $editing['id']);
	$grid->addItem([(new CTag('h4', true, _s('Edit %1$s', $editing['label']))), new CFormField('')])
		->addItem($field(_('Name'), 'label', $editing['label']));
	if ($editing['kind'] === 'role') {
		$grid->addItem($field(_('In host names'), 'short', $editing['short'], _('Changing it renames this role\'s machines at each client\'s next save.')));
	}
	$grid->addItem($field(_('Host group'), 'group', $editing['group'], _('Machines are moved at each client\'s next save.')));
	if ($editing['kind'] === 'role') {
		$pick = \Modules\EpClients\Lib\TemplateMap::pick((array) ($editing['templates'] ?? []));
		$grid->addItem($templatePicker('templates', 'ep-role-form', $pick['known'], $pick['missing'],
			_s('Templates new servers of this role get. Empty: %1$s. One template may be given to as many roles as you like. Existing servers gain them at the client\'s next save; nothing is unlinked.', $data['templates']['agent'])));
	}
}
elseif ($data['family'] !== '') {
	$form->addVar('op', 'add_role')->addVar('family', $data['family']);
	$grid->addItem([(new CTag('h4', true, _s('Add a role to %1$s', $data['family']))), new CFormField('')])
		->addItem($field(_('Name'), 'label', '', _('e.g. AIML')))
		->addItem($field(_('Id'), 'id', '', _('lower-case, e.g. aiml — used in item keys and CSV columns; cannot be changed later.')))
		->addItem($field(_('In host names'), 'short', '', _('e.g. AIML → example-AIML-1')))
		->addItem($field(_('Host group'), 'group', '', _('Created if it does not exist.')))
		->addItem($templatePicker('templates', 'ep-role-form', [], [],
			_s('Templates new servers of this role get. Empty: %1$s. One template may be given to as many roles as you like.', $data['templates']['agent'])));
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

// Template mapping. A Zabbix whose templates are called something else — a site's own names, or
// the ones an earlier release shipped — is pointed at them here instead of in PHP. Every name is
// looked up as the page is drawn, so a name that matches nothing says so here rather than
// failing silently later; see TemplateMap.
$slotLabels = [
	'cluster' => _('Elasticsearch cluster'),
	'agent' => _('Linux agent'),
	'master' => _('Client master'),
	'devices' => _('Cluster devices'),
	'jump' => _('Elasticsearch via SSH jump host'),
	'jump_ulm' => _('Log archive via SSH jump host'),
	'ulm' => _('Log archive (S3)'),
	'plan' => _('Client plan'),
	'alerts' => _('Alerts'),
	'delay' => _('Log delay')
];
$tplForm = (new CForm('post', $url('ep.clients.role.save')))->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.role.save'))
	->addVar('op', 'set_templates')->setId('ep-template-form');
$tplForm->addItem(new CTag('h4', true, _('Template mapping')));
$tplForm->addItem((new CDiv(_('What each template this page uses is called on this Zabbix. Leave a row empty to use the name ElasticPro ships. "Also recognise" names extra spellings that are found but never written — use it when hosts already carry an older name and new ones should get the mapped one.')))->addClass('ep-soft'));
if (!$data['choices']['complete']) {
	$tplForm->addItem((new CDiv(_s('The picker lists the first %1$s template names only; this Zabbix has more. A name not offered can still be typed.',
		\Modules\EpClients\Lib\TemplateMap::PICK_LIMIT)))->addClass('ep-hint'));
}
$tbl = (new CTableInfo())->setHeader([_('Template'), _('Name on this Zabbix'), _('Also recognise'), _('Found')]);
foreach ($data['map'] as $slot => $row) {
	$label = $slotLabels[$slot] ?? $slot;
	// Chosen, never typed. The list is every template on this Zabbix, plus the name ElasticPro
	// ships for this slot — which for a slot the Clients page writes may not exist yet, and is
	// the one name that has to be offerable before it does.
	$opts = $data['choices']['names'];
	if (!in_array($row['shipped'], $opts, true)) {
		$opts[] = $row['shipped'];
	}
	// A name already mapped that this Zabbix no longer has stays on the list, or opening this
	// page and pressing Save would silently repoint the slot at something else.
	if ($row['mapped'] && !in_array($row['name'], $opts, true)) {
		$opts[] = $row['name'];
	}
	sort($opts, SORT_NATURAL | SORT_FLAG_CASE);
	$choices = [$row['shipped'] => _s('%1$s  (the name ElasticPro ships)', $row['shipped'])];
	foreach ($opts as $o) {
		if ($o !== $row['shipped']) {
			$choices[$o] = $o;
		}
	}
	$name = (new CSelect($slot.'_template'))
		->setId('tpl-'.$slot)
		->setValue($row['name'])
		->addOptions(CSelect::createOptionsFromArray($choices))
		->setWidth(360);
	$aliasPick = \Modules\EpClients\Lib\TemplateMap::pick(array_column($row['aliases'], 'name'));
	$also = [(new CMultiSelect([
		'name' => $slot.'_also[]',
		'object_name' => 'templates',
		'data' => $aliasPick['known'],
		'popup' => ['parameters' => [
			'srctbl' => 'templates', 'srcfld1' => 'hostid', 'dstfrm' => 'ep-template-form', 'dstfld1' => $slot.'_also_'
		]]
	]))->setId($slot.'_also_')->setWidth(240)];
	if ($aliasPick['missing']) {
		$also[] = (new CDiv(_s('kept: %1$s', implode(', ', $aliasPick['missing']))))->addClass('ep-hint');
		$also[] = new CVar($slot.'_also_keep', implode("\n", $aliasPick['missing']));
	}
	// What Zabbix has, said plainly: a template this page writes and Zabbix has not got yet is
	// not a fault, so it reads as pending rather than missing.
	if ($row['found']) {
		$state = (new CSpan(_n('%1$s host', '%1$s hosts', $row['hosts'])))->addClass($row['ours'] === false && $row['writes'] ? 'red' : 'green');
		$note = $row['ours'] === false ? _('not written by this page') : ($row['writes'] ? _('written by this page') : '');
	}
	elseif ($row['writes']) {
		$state = (new CSpan(_('not installed yet')))->addClass('grey');
		$note = _('the Clients page writes it under this name');
	}
	else {
		$state = (new CSpan(_('no such template')))->addClass('red');
		$note = '';
	}
	$cell = [$state];
	if ($note !== '') {
		$cell[] = (new CDiv($note))->addClass('ep-hint');
	}
	foreach ($row['aliases'] as $a) {
		if (!$a['found']) {
			$cell[] = (new CDiv(_s('"%1$s" is not on this Zabbix', $a['name'])))->addClass('ep-hint');
		}
	}
	if ($row['problem'] !== '') {
		$cell[] = (new CDiv($row['problem']))->addClass('msg-warning')->addClass('ep-box');
	}
	$tbl->addRow([[new CSpan($label), (new CDiv($row['shipped']))->addClass('ep-hint')], $name, $also, $cell]);
}
$tplForm->addItem($tbl);
$tplForm->addItem((new CDiv(new CSubmit('save', _('Save mapping'))))->addClass('ep-indent'));
$page->addItem($tplForm)->show();
?>
<style>
	.ep-inline { display: inline; } .ep-inline .btn-link { padding: 0; }
	.ep-soft { opacity: .85; margin: 0 0 8px; max-width: 110ch; } .ep-box { margin: 10px 0; padding: 10px 12px; }
	.ep-indent { padding-left: 18px; } .ep-hint { opacity: .75; margin-top: 3px; }
	#ep-role-form, #ep-template-form { margin-top: 18px; }
</style>
