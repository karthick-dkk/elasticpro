<?php declare(strict_types = 0);
/**
 * Client resources widget view: sections over their columns, a row per client that expands into
 * its servers.
 *
 * @var CView $this
 * @var array $data
 */

$view = new CWidgetView($data);

if ($data['error'] !== null) {
	$view->addItem((new CDiv($data['error']))->addClass('ep-empty'));
	$view->show();
	return;
}

$toolbar = (new CDiv([
	(new CSpan(_n('%1$s client', '%1$s clients', count($data['rows']))))->addClass('ep-res-count')->setAttribute('data-ep-count', '')
		->setAttribute('data-template', _('%n clients')),
	new CLabel(_('Type')), ' ',
	(new CTag('select', true, [
		(new CTag('option', true, _('All')))->setAttribute('value', ''),
		(new CTag('option', true, 'DI'))->setAttribute('value', 'DI'),
		(new CTag('option', true, 'On-Prem'))->setAttribute('value', 'On-Prem')
	]))->setAttribute('data-ep-type-filter', '')->setAttribute('aria-label', _('Client type')),
	(new CSimpleButton(_('Expand all')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-expand-all', ''),
	(new CSimpleButton(_('Columns')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-columns', ''),
	(new CSimpleButton(_('Export CSV')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'csv'),
	(new CSimpleButton(_('Export servers CSV')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'csv-servers'),
	(new CSimpleButton(_('Export Excel')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'xlsx')
]))->addClass('ep-res-toolbar');

if (!$data['rows']) {
	$view->addItem($toolbar)
		->addItem((new CDiv(_('No client master hosts yet. Add clients in ElasticPro → Clients — they appear here, and export is enabled.')))->addClass('ep-empty'))
		->setVar('export', $data['export'])->setVar('ep_meta', $data['meta'])->show();
	return;
}

// Sections: a run of columns with one group is one section.
$groups = [];
foreach ($data['columns'] as $i => $c) {
	if ($groups && $groups[count($groups) - 1]['name'] === $c['group']) {
		$groups[count($groups) - 1]['span']++;
	}
	else {
		$groups[] = ['name' => $c['group'], 'span' => 1, 'first' => $i];
	}
}
$starts = array_column($groups, 'first');

$group_row = (new CTag('tr', true))->addItem((new CTag('th', true, ''))->addClass('ep-res-toggle'));
foreach ($groups as $g) {
	$group_row->addItem((new CTag('th', true, $g['name'] === 'Client' ? '' : $g['name']))->setAttribute('colspan', $g['span'])
		->addClass('ep-res-group')->addClass('ep-res-start'));
}
$label_row = (new CTag('tr', true))->addItem((new CTag('th', true, ''))->addClass('ep-res-toggle'));
foreach ($data['columns'] as $i => $c) {
	$label_row->addItem((new CTag('th', true, $c['label']))->addClass($i === 0 ? 'ep-res-first' : null)
		->addClass(in_array($i, $starts, true) ? 'ep-res-start' : null));
}

$pct = fn($v) => $v === null ? '—' : round($v, 1).' %';
$body = new CTag('tbody', true);
foreach ($data['rows'] as $n => $row) {
	$id = 'c'.$n;
	$tr = (new CTag('tr', true))->setAttribute('data-type', $row['type'])->setAttribute('data-row', $id);
	$tr->addItem((new CTag('td', true, $row['servers']
		? (new CTag('button', true, '▸'))->setAttribute('type', 'button')->addClass('ep-expand')->setAttribute('data-ep-expand', $id)
			->setAttribute('aria-expanded', 'false')->setAttribute('aria-label', _s('Servers of %1$s', $row['client']))
		: ''))->addClass('ep-res-toggle'));
	foreach ($row['cells'] as $i => $cell) {
		$content = $cell['sub'] !== '' ? [$cell['text'], ' ', (new CSpan($cell['sub']))->addClass('ep-res-sub')] : $cell['text'];
		$content = \Modules\EpResources\Lib\Bars::cell($content, $cell['bar'] ?? null, $data['bars'] ?? 'under', $cell['class']);
		$td = (new CTag('td', true, $i === 0 ? new CTag('b', true, $content) : $content))
			->addClass($cell['class'] !== '' ? $cell['class'] : null)
			->addClass(($cell['bar'] ?? null) !== null && ($data['bars'] ?? 'under') !== 'none' ? 'ep-barcell' : null)
			->addClass($i === 0 ? 'ep-res-first' : null)
			->addClass(in_array($i, $starts, true) ? 'ep-res-start' : null);
		if ($cell['hint'] !== '') {
			$td->setAttribute('title', $cell['hint']);
		}
		$tr->addItem($td);
	}
	$body->addItem($tr);

	if ($row['servers']) {
		$head = new CTag('tr', true);
		foreach ([_('Role'), _('Host'), _('IP'), _('Status'), _('CPU cores'), _('CPU used'), _('Memory'), _('Memory used'), _('Disks'), _('Fullest disk')] as $h) {
			$head->addItem(new CTag('th', true, $h));
		}
		$sb = new CTag('tbody', true);
		foreach ($row['servers'] as $s) {
			$roleCell = [$s['role']];
			foreach ($s['services'] ?? [] as $svc) {
				$roleCell[] = ' ';
				$roleCell[] = (new CSpan($svc))->addClass('ep-svc');
			}
			if (!empty($s['single'])) {
				$roleCell[] = ' ';
				$roleCell[] = (new CSpan(_('single node')))->addClass('ep-mark');
			}
			elseif (!empty($s['shared'])) {
				$roleCell[] = ' ';
				$roleCell[] = (new CSpan(_('shared')))->addClass('ep-mark');
			}
			$sb->addItem((new CTag('tr', true))
				->addItem(new CTag('td', true, $roleCell))
				->addItem(new CTag('td', true, new CLink($s['host'],
					(new CUrl('zabbix.php'))->setArgument('action', 'latest.view')->setArgument('hostids', [$s['hostid']])->getUrl())))
				->addItem(new CTag('td', true, $s['ip'] !== '' ? $s['ip'] : '—'))
				->addItem((new CTag('td', true, new CSpan($s['status'] === 'up' ? _('up') : ($s['status'] === 'down' ? _('down') : _('no data')))))->addClass('ep-st-'.$s['status']))
				->addItem(new CTag('td', true, $s['cpu_cores'] === null ? '—' : (string) (int) $s['cpu_cores']))
				->addItem((new CTag('td', true, $pct($s['cpu_used'])))->addClass($s['classes']['cpu'] !== '' ? $s['classes']['cpu'] : null))
				->addItem(new CTag('td', true, $s['mem_total'] === null ? '—' : convertUnits(['value' => $s['mem_total'], 'units' => 'B'])))
				->addItem((new CTag('td', true, $pct($s['mem_used'])))->addClass($s['classes']['mem'] !== '' ? $s['classes']['mem'] : null))
				->addItem(new CTag('td', true, array_map(fn($d) => (new CDiv([(new CSpan($d['mount']))->addClass('ep-mount'), ' ',
					$d['total'] === null ? '—' : convertUnits(['value' => $d['total'], 'units' => 'B']),
					$d['used'] === null ? '' : ' · '.round($d['used']).' %']))->addClass('ep-disk-line'), $s['disks'] ?? [])))
				->addItem((new CTag('td', true, $pct($s['disk_used'])))->addClass($s['classes']['disk'] !== '' ? $s['classes']['disk'] : null)));
		}
		$srv = (new CTag('table', true))->addClass('ep-servers')->addItem((new CTag('thead', true))->addItem($head))->addItem($sb);
		$body->addItem((new CTag('tr', true))->addClass('ep-sub')->setAttribute('data-parent', $id)->setAttribute('hidden', 'hidden')
			->addItem((new CTag('td', true, ''))->addClass('ep-res-toggle'))
			->addItem((new CTag('td', true, (new CDiv($srv))->addClass('ep-servers-wrap')))->setAttribute('colspan', count($data['columns']))));
	}
}

$table = (new CTag('table', true))
	->addClass(ZBX_STYLE_LIST_TABLE)
	->addClass('ep-res-table')
	->addItem((new CTag('thead', true))->addItem($group_row)->addItem($label_row))
	->addItem($body);

$view
	->addItem($toolbar)
	->addItem((new CDiv($table))->addClass('ep-res-scroll'))
	->setVar('export', $data['export'])
	->setVar('ep_meta', $data['meta'])
	->show();
