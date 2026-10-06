<?php declare(strict_types = 0);
/**
 * Import clients: choose a file; see what it would do; confirm the changes to existing clients.
 *
 * @var CView $this
 * @var array $data
 */

$url = fn(string $action, array $args = []) => array_reduce(array_keys($args), fn($u, $k) => $u->setArgument($k, $args[$k]),
	(new CUrl('zabbix.php'))->setArgument('action', $action))->getUrl();
$list = function(array $items, string $class = '') {
	$l = (new CList())->addClass($class);
	foreach ($items as $i) {
		$l->addItem($i);
	}
	return $l;
};
$page = (new CHtmlPage())->setTitle($data['file'] !== '' ? _s('Import %1$s', $data['file']) : _('Import clients'));

// The file.
$upload = (new CForm('post', $url('ep.clients.import')))
	->setAttribute('enctype', 'multipart/form-data')
	->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.import'))
	->addItem((new CDiv([
		(new CDiv([
			new CLabel(_('clients.csv'), 'csv'),
			(new CTag('input', false))->setAttribute('type', 'file')->setAttribute('name', 'csv')->setAttribute('accept', '.csv,text/csv')->setId('csv'),
			(new CSpan([new CLink(_('Template'), $url('ep.clients.csv.template')), ' · ', new CLink(_('Export to edit'), $url('ep.clients.csv.export'))]))->addClass('ep-soft'),
			(new CSpan(_('Settings and requested capacity, one row per client.')))->addClass('ep-soft')
		]))->addClass('ep-file'),
		(new CDiv([
			new CLabel(_('servers.csv'), 'servers'),
			(new CTag('input', false))->setAttribute('type', 'file')->setAttribute('name', 'servers')->setAttribute('accept', '.csv,text/csv')->setId('servers'),
			(new CSpan([new CLink(_('Template'), $url('ep.clients.csv.template', ['kind' => 'servers'])), ' · ',
				new CLink(_('Export to edit'), $url('ep.clients.csv.export', ['kind' => 'servers']))]))->addClass('ep-soft'),
			(new CSpan(_('One row per server: client, ip, roles (es_data_hot;es_coord), services, notes. Other columns become attributes.')))->addClass('ep-soft')
		]))->addClass('ep-file'),
		new CSubmit('check', _('Check files'))
	]))->addClass('ep-upload'))
	->addItem((new CDiv(_('Either file may come alone. Every row is checked first; one error and nothing is applied. New clients are added straight away and changes to existing clients wait for your tick below — each after a backup. A clients.csv column left out means "no change"; an empty cell means "clear". A client in servers.csv gets exactly the servers listed for it. Clients missing from the files are not removed.')))->addClass('ep-soft'));
$page->addItem($upload);

if (!$data['store_ok']) {
	$page->addItem((new CDiv(_s('Backups cannot be kept: %1$s is missing or not writable. Imports are refused until it is there.', $data['store_dir'])))->addClass('msg-bad')->addClass('ep-box'));
}
if ($data['error'] !== null) {
	$page->addItem((new CDiv($data['error']))->addClass('msg-bad')->addClass('ep-box'));
}

$plan = $data['plan'];
if ($plan !== null) {
	$rows = $plan['rows'];
	$count = fn($s) => count(array_filter($rows, fn($r) => $r['status'] === $s));
	if ($plan['ignored']) {
		$page->addItem((new CDiv(_s('Columns not recognised and ignored: %1$s.', implode(', ', $plan['ignored']))))->addClass('msg-warning')->addClass('ep-box'));
	}
	if ($data['stage'] === 'errors') {
		$page->addItem((new CDiv([new CTag('b', true, _('Nothing was applied. Correct the file and check it again:')), $list($plan['errors'])]))
			->addClass('msg-bad')->addClass('ep-box'));
	}
	else {
		$added = array_filter($data['added'], fn($a) => !$a['problems']);
		$summary = [];
		if ($data['backup']) {
			$summary[] = new CTag('b', true, _('Backup taken. '));
		}
		$summary[] = $data['added'] ? _n('%1$s new client added: ', '%1$s new clients added: ', count($data['added'])).implode(', ', array_column($data['added'], 'name')).'.'
			: _('No new clients to add straight away.');
		$page->addItem((new CDiv($summary))->addClass('msg-good')->addClass('ep-box'));
		foreach ($data['added'] as $a) {
			$page->addItem((new CDiv([new CTag('b', true, $a['name'].': '), implode(' ', $a['done']), ' ',
				$a['problems'] ? (new CSpan(_('Read back — differs: ').implode(' ', $a['problems'])))->addClass('ep-bad-text') : _('Read back — matches the file.')]))
				->addClass('ep-soft')->addClass('ep-line'));
		}
	}

	$chips = (new CDiv([
		(new CSpan(_s('%1$s new', $count('new'))))->addClass('ep-st ep-new'),
		(new CSpan(_s('%1$s changed', $count('update'))))->addClass('ep-st ep-upd'),
		(new CSpan(_s('%1$s unchanged', $count('same'))))->addClass('ep-st ep-same'),
		(new CSpan(_s('%1$s with errors', $count('error'))))->addClass('ep-st ep-err')
	]))->addClass('ep-chips');
	$page->addItem($chips);

	$warnings = [];
	foreach ($rows as $r) {
		foreach ($r['warnings'] as $w) {
			$warnings[] = $r['name'].': '.$w;
		}
	}
	if ($warnings) {
		$page->addItem((new CDiv([new CTag('b', true, _('Overlaps — check these before confirming:')), $list(array_values(array_unique($warnings)))]))
			->addClass('msg-warning')->addClass('ep-box'));
	}

	if ($data['stage'] === 'done' && $data['pending']) {
		$confirm = (new CForm('post', $url('ep.clients.import.apply')))
			->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('ep.clients.import.apply'))
			->addVar('token', $data['token']);
		$table = (new CTableInfo())->setHeader([_('Apply'), _('Client'), _('What changes'), _('Hosts')]);
		foreach ($data['pending'] as $r) {
			$changes = [];
			foreach ($r['diff']['fields'] ?? [] as $d) {
				$changes[] = [$d['field'], ' ', (new CSpan($d['old'] === '' ? '—' : $d['old']))->addClass('ep-old'), ' → ', (new CSpan($d['new'] === '' ? '—' : $d['new']))->addClass('ep-new-text')];
			}
			if ($r['status'] === 'new') {
				$changes[] = [new CTag('b', true, _('New client')), ' — ', _('held back because of the overlap above.')];
			}
			$hosts = [];
			$deletes = false;
			foreach ($r['diff']['hosts'] ?? [] as $h) {
				switch ($h['change']) {
					case 'add': $hosts[] = (new CSpan('+ '.$h['ip'].' · '.$h['roles']))->addClass('ep-new-text'); break;
					case 'role': $hosts[] = (new CSpan('↻ '.($h['host'] ?? $h['ip']).' · '.(isset($h['was']) ? $h['was'].' → ' : '').$h['roles']))->addClass('ep-soft'); break;
					case 'detail': $hosts[] = (new CSpan('· '.($h['host'] ?? $h['ip']).' — '._('services, notes or attributes')))->addClass('ep-soft'); break;
					case 'delete': $deletes = true; $hosts[] = (new CSpan('− '.$h['host'].' ('.$h['ip'].') — '._('deleted with its history')))->addClass('ep-bad-text'); break;
					default: $hosts[] = (new CSpan('· '.$h['host'].' — '._('made by hand, left as it is')))->addClass('ep-soft');
				}
			}
			// A change that deletes a host, or a new client held back by an overlap, is never ticked for
			// you. Keyed by client: Zabbix's list-table script treats "apply[]" boxes as one and would
			// untick them all together; it finds each box by the id "apply_<key>".
			$box = (new CCheckBox('apply['.$r['name'].']', '1'))->setChecked(!$deletes && $r['status'] !== 'new')->setId('apply_'.$r['name']);
			$table->addRow([$box, [new CTag('b', true, $r['name']), ' ', (new CSpan($r['type']))->addClass($r['type'] === 'DI' ? 'ep-pill ep-di' : ($r['type'] === 'CI' ? 'ep-pill ep-ci' : 'ep-pill ep-op'))],
				$changes ? $list($changes, 'ep-plain') : '—', $hosts ? $list($hosts, 'ep-plain') : '—']);
		}
		$confirm->addItem($table)->addItem((new CDiv([
			(new CSpan(_('Unticked clients stay as they are. A change that deletes a host, and a new client with an overlap, are never ticked for you.')))->addClass('ep-soft ep-grow'),
			new CRedirectButton(_('Cancel changes'), $url('ep.clients.list')), ' ',
			new CSubmit('apply-selected', _('Apply ticked changes'))
		]))->addClass('ep-actions'));
		$page->addItem((new CTag('h4', true, _('Changes to existing clients — confirm each')))->addClass('ep-h'))->addItem($confirm);
	}
	elseif ($data['stage'] === 'done') {
		$page->addItem((new CDiv([_('No changes to existing clients. '), new CLink(_('Back to clients'), $url('ep.clients.list'))]))->addClass('ep-soft'));
	}
}

$page->show();
?>
<style>
	.ep-upload { margin: 0 0 8px; display: grid; gap: 10px; justify-items: start; }
	.ep-file { display: grid; grid-template-columns: 90px auto auto; gap: 4px 12px; align-items: center; }
	.ep-file > .ep-soft:last-child { grid-column: 2 / 4; font-size: 11px; }
	.ep-soft { opacity: .85; }
	.ep-box { margin: 10px 0; padding: 10px 12px; }
	.ep-box ul { margin: 6px 0 0 18px; list-style: disc; }
	.ep-line { margin: 2px 0 2px 12px; }
	.ep-chips { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
	.ep-st { padding: 2px 8px; border-radius: 3px; font-weight: bold; font-size: 11px; }
	.ep-new { background: #e8f5e9; color: #2e7d32; } .ep-upd { background: #fff8e1; color: #8a6d00; }
	.ep-same { background: #eef2f4; color: #52626b; } .ep-err { background: #fdecea; color: #c62828; }
	.ep-old { color: #b71c1c; text-decoration: line-through; } .ep-new-text { color: #1b5e20; font-weight: bold; }
	.ep-bad-text { color: #b71c1c; font-weight: bold; }
	.ep-plain { list-style: none; margin: 0; padding: 0; }
	.ep-h { margin: 18px 0 6px; }
	.ep-actions { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
	.ep-grow { margin-right: auto; }
	.ep-pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: bold; }
	.ep-di { background: #e3f2fd; color: #0d47a1; } .ep-op { background: #ede7f6; color: #4527a0; } .ep-ci { background: #e0f2f1; color: #00695c; }
</style>
