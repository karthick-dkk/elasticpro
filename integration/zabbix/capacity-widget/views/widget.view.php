<?php declare(strict_types = 0);
/**
 * Client capacity widget view.
 *
 * @var CView $this
 * @var array $data
 */

$view = new CWidgetView($data);

if ($data['error'] !== null) {
	$view->addItem((new CTableInfo())->setNoDataMessage($data['error']));
}
else {
	$toolbar = (new CDiv([
		(new CSpan(_n('%1$s client', '%1$s clients', count($data['rows']))))->addClass('ep-cap-count')->setAttribute('data-ep-count', '')
			->setAttribute('data-template', _('%n clients')),
		new CLabel(_('Type')), ' ',
		(new CTag('select', true, [
			(new CTag('option', true, _('All')))->setAttribute('value', ''),
			(new CTag('option', true, 'DI'))->setAttribute('value', 'DI'),
			(new CTag('option', true, 'On-Prem'))->setAttribute('value', 'On-Prem')
		]))->setAttribute('data-ep-type-filter', '')->setAttribute('aria-label', _('Client type')),
		(new CSimpleButton(_('Columns')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-columns', ''),
		(new CSimpleButton(_('Export CSV')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'csv'),
		(new CSimpleButton(_('Export Excel')))->addClass(ZBX_STYLE_BTN_ALT)->setAttribute('data-ep-export', 'xlsx')
	]))->addClass('ep-cap-toolbar');

	$header = [];
	foreach ($data['columns'] as $i => $column) {
		$header[] = (new CColHeader($column['label']))->addClass($i === 0 ? 'ep-cap-first' : null);
	}

	$table = (new CTableInfo())
		->addClass('ep-cap-table')
		->setHeader($header)
		->setNoDataMessage(_('No client master hosts. Link "ElasticPro client master" to a host and set its macros.'));

	foreach ($data['rows'] as $row) {
		$cols = [];
		foreach ($row['cells'] as $i => $cell) {
			$col = (new CCol($cell['text']))->addClass($cell['class'] !== '' ? $cell['class'] : null);
			if ($i === 0) {
				$col->addClass('ep-cap-first');
			}
			if ($cell['hint'] !== '') {
				$col->setAttribute('title', $cell['hint']);
			}
			$cols[] = $col;
		}
		$table->addRow((new CRow($cols))->setAttribute('data-type', $row['type']));
	}

	// With nothing to list, say so where it can be seen. Centred across two dozen columns, the table's
	// own empty row puts the message far off to the right of a widget this wide.
	$content = $data['rows']
		? (new CDiv($table))->addClass('ep-cap-scroll')
		: (new CDiv(_('No client master hosts yet. Create a host with the "ElasticPro client master" template and set its macros — clients appear here, and export is enabled.')))->addClass('ep-empty');

	$view
		->addItem($toolbar)
		->addItem($content)
		->setVar('export', $data['export'])
		->setVar('ep_meta', $data['meta']);
}

$view->show();
