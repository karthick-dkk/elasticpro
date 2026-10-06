<?php declare(strict_types = 0);
/**
 * Volume report widget view: sections over their columns, as the Volume report page lays
 * the client plan out.
 *
 * @var CView $this
 * @var array $data
 */

$view = new CWidgetView($data);

if ($data['error'] !== null) {
	$view->addItem((new CTableInfo())->setNoDataMessage($data['error']));
	$view->show();
	return;
}

$toolbar = (new CDiv([
	(new CSpan(_n('%1$s cluster', '%1$s clusters', count($data['rows']))))->addClass('ep-vol-count')->setAttribute('data-ep-count', '')
		->setAttribute('data-template', _('%n clusters')),
	new CLabel(_('Type')), ' ',
	(new CTag('select', true, [
		(new CTag('option', true, _('All')))->setAttribute('value', ''),
		(new CTag('option', true, 'DI'))->setAttribute('value', 'DI'),
		(new CTag('option', true, 'On-Prem'))->setAttribute('value', 'On-Prem')
	]))->setAttribute('data-ep-type-filter', '')->setAttribute('aria-label', _('Client type')),
	(new CSimpleButton(_('Columns')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-columns', ''),
	(new CSimpleButton(_('Export CSV')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'csv'),
	(new CSimpleButton(_('Export Excel')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'xlsx')
]))->addClass('ep-vol-toolbar');

// Two header rows: each section once over its columns, then the columns.
$groups = [];
foreach ($data['columns'] as $i => $column) {
	if ($groups && $groups[count($groups) - 1]['name'] === $column['group']) {
		$groups[count($groups) - 1]['span']++;
	}
	else {
		$groups[] = ['name' => $column['group'], 'span' => 1, 'first' => $i];
	}
}
$starts = array_column($groups, 'first');

$group_row = (new CTag('tr', true))->addItem(
	(new CTag('th', true, ''))->addClass('ep-vol-first')
);
foreach ($groups as $g) {
	$group_row->addItem(
		(new CTag('th', true, $g['name']))
			->setAttribute('colspan', $g['span'])
			->addClass('ep-vol-group')
			->addClass('ep-vol-start')
	);
}
$label_row = (new CTag('tr', true))->addItem((new CTag('th', true, _('Cluster')))->addClass('ep-vol-first'));
foreach ($data['columns'] as $i => $column) {
	$label_row->addItem(
		(new CTag('th', true, $column['label']))->addClass(in_array($i, $starts) ? 'ep-vol-start' : null)
	);
}

$body = new CTag('tbody', true);
foreach ($data['rows'] as $row) {
	$tr = (new CTag('tr', true))->addClass($row['unreachable'] ? 'ep-vol-unreachable' : null)->setAttribute('data-type', $row['type']);
	$tr->addItem(
		(new CTag('td', true, $row['cluster']))
			->addClass('ep-vol-first')
			->setAttribute('title', $row['unreachable'] ? _('Cluster unreachable — figures are the last measured').' · '.$row['hint'] : $row['hint'])
	);
	foreach ($row['cells'] as $i => $cell) {
		$tr->addItem(
			(new CTag('td', true, $cell['text']))
				->addClass($cell['class'] !== '' ? $cell['class'] : null)
				->addClass(in_array($i, $starts) ? 'ep-vol-start' : null)
		);
	}
	$body->addItem($tr);
}

$table = (new CTag('table', true))
	->addClass(ZBX_STYLE_LIST_TABLE)
	->addClass('ep-vol-table')
	->addItem((new CTag('thead', true))->addItem($group_row)->addItem($label_row))
	->addItem($body);

$view
	->addItem($toolbar)
	// With nothing to list, say so where it can be seen: centred across this many columns, an
	// empty table row puts the message far off to the right.
	->addItem($data['rows']
		? (new CDiv($table))->addClass('ep-vol-scroll')
		: (new CDiv(_('No cluster hosts with the "ElasticPro client plan" template yet — clusters appear here once ElasticPro sends their plan, and export is enabled.')))->addClass('ep-empty'))
	->setVar('export', $data['export'])
	->setVar('ep_meta', $data['meta'])
	->show();
