<?php declare(strict_types = 0);

namespace Modules\EpVolume\Actions;

foreach (['Store', 'ColumnSettings'] as $lib) {
	require_once __DIR__.'/../lib/'.$lib.'.php';
}

use API,
	CControllerDashboardWidgetView,
	CControllerResponseData,
	CCsrfTokenHelper;
use Modules\EpVolume\Lib\ColumnSettings;

/**
 * The Volume report's client plan: one row per cluster host.
 *
 * The columns are the "ElasticPro client plan" template's items — label, section (tag
 * `plan`), place (tag `column`) and units — which ElasticPro generates from the same list
 * the Volume report page draws. So this keeps no column list of its own: a column added to
 * the report reaches the widget with the template. The Columns dialog renames, hides and
 * reorders them within their section (one setting for everyone; the export follows it), and a
 * cluster's client type — DI or On-Prem — comes from its client's master host.
 *
 * A figure ElasticPro could not measure is not sent to Zabbix at all; here it is "—" and
 * an empty cell in the export, never 0.
 */
class WidgetView extends CControllerDashboardWidgetView {

	private const TEMPLATE = 'ElasticPro client plan';
	private const LABEL_PREFIX = 'Client plan: ';

	protected function doAction(): void {
		$data = [
			'name' => $this->getInput('name', $this->widget->getDefaultName()),
			'columns' => [],
			'rows' => [],
			'export' => null,
			'error' => null,
			'meta' => null,
			'user' => ['debug_mode' => $this->getDebugMode()]
		];

		$templates = API::Template()->get([
			'output' => ['templateid'],
			'filter' => ['host' => self::TEMPLATE],
			'selectMacros' => ['macro', 'value']
		]);
		if (!$templates) {
			$data['error'] = _s('Template "%1$s" is not imported, or you cannot read it.', self::TEMPLATE);
			$this->setResponse(new CControllerResponseData($data));
			return;
		}
		$template = $templates[0];

		// The columns, from the template's items.
		$columns = [];
		foreach (API::Item()->get([
			'output' => ['key_', 'name', 'units', 'value_type'],
			'templateids' => [$template['templateid']],
			'selectTags' => ['tag', 'value']
		]) as $item) {
			$tags = array_column($item['tags'], 'value', 'tag');
			if (!array_key_exists('column', $tags)) {
				continue;
			}
			$columns[] = [
				'key' => $item['key_'],
				'id' => $item['key_'],
				'label' => strpos($item['name'], self::LABEL_PREFIX) === 0 ? substr($item['name'], strlen(self::LABEL_PREFIX)) : $item['name'],
				'group' => $tags['plan'] ?? '',
				'order' => (int) $tags['column'],
				'units' => $item['units'],
				'numeric' => in_array($item['value_type'], [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64])
			];
		}
		usort($columns, static fn($a, $b) => $a['order'] <=> $b['order']);
		$settings = ColumnSettings::load('volume');
		$all = $columns;
		$columns = ColumnSettings::apply($all, $settings);
		$data['columns'] = $columns;
		$data['meta'] = [
			'title' => 'Volume report',
			'report' => 'volume',
			'action' => 'widget.ep_volume.columns',
			'token' => CCsrfTokenHelper::get('widget.ep_volume.columns'),
			'canEdit' => $this->getUserType() == USER_TYPE_SUPER_ADMIN,
			'columns' => array_map(fn($c) => ['id' => $c['id'], 'label' => $c['label'], 'default' => $c['default'], 'hidden' => $c['hidden'],
				'section' => $c['group']], ColumnSettings::apply($all, $settings, true))
		];

		$options = [
			'output' => ['hostid', 'name'],
			'selectHostGroups' => ['name'],
			'selectTags' => ['tag', 'value'],
			'templateids' => [$template['templateid']],
			'preservekeys' => true
		];
		if ($this->fields_values['groupids']) {
			$options['groupids'] = getSubGroups($this->fields_values['groupids']);
		}
		$hosts = API::Host()->get($options);

		// The thresholds the template's triggers use, per host where a host overrides them.
		$defaults = array_column($template['macros'], 'value', 'macro');
		$host_macros = [];
		$values = [];
		if ($hosts) {
			foreach (API::UserMacro()->get([
				'output' => ['hostid', 'macro', 'value'],
				'hostids' => array_keys($hosts),
				'filter' => ['macro' => ['{$ELASTICPRO.PLAN.LIVE_USED.WARN}', '{$ELASTICPRO.PLAN.LIVE_DAYS.MIN}']]
			]) ?: [] as $macro) {
				$host_macros[$macro['hostid']][$macro['macro']] = $macro['value'];
			}

			$keys = array_merge(array_column($columns, 'key'), ['elasticpro.plan.epoch', 'elasticpro.plan.reachable']);
			foreach (API::Item()->get([
				'output' => ['hostid', 'key_', 'lastvalue', 'lastclock', 'state'],
				'hostids' => array_keys($hosts),
				'filter' => ['key_' => $keys]
			]) as $item) {
				$known = $item['state'] == ITEM_STATE_NORMAL && $item['lastclock'] != 0 && $item['lastvalue'] !== '';
				$values[$item['hostid']][$item['key_']] = $known ? $item['lastvalue'] : null;
			}
		}

		$types = self::clientTypes();

		$headers = [_('Cluster')];
		foreach ($columns as $column) {
			$headers[] = $column['label'].self::exportSuffix($column['units']);
		}

		$export_rows = [];
		foreach ($hosts as $hostid => $host) {
			// Decommissioned clients leave the report.
			if (in_array(['tag' => 'ep-status', 'value' => 'decommissioned'], array_map(fn($t) => ['tag' => $t['tag'], 'value' => $t['value']], $host['tags'] ?? []), true)) {
				continue;
			}
			$mine = $values[$hostid] ?? [];
			$warn = self::macro($host_macros[$hostid] ?? [], $defaults, '{$ELASTICPRO.PLAN.LIVE_USED.WARN}', 85);
			$min_days = self::macro($host_macros[$hostid] ?? [], $defaults, '{$ELASTICPRO.PLAN.LIVE_DAYS.MIN}', 14);

			$epoch = $mine['elasticpro.plan.epoch'] ?? null;
			$type = 'On-Prem';
			foreach ($host['hostgroups'] as $g) {
				if (isset($types[$g['name']])) {
					$type = $types[$g['name']];
				}
			}
			$row = [
				'cluster' => $host['name'],
				'type' => $type,
				'hint' => $epoch !== null ? _s('Updated %1$s ago', zbx_date2age((int) $epoch)) : _('Never updated'),
				'unreachable' => ($mine['elasticpro.plan.reachable'] ?? null) === '0',
				'cells' => []
			];
			$export = [$host['name']];

			foreach ($columns as $column) {
				$raw = $mine[$column['key']] ?? null;
				$cell = ['text' => '—', 'class' => ''];
				if ($raw !== null) {
					$cell['text'] = $column['numeric']
						? convertUnits(['value' => (float) $raw, 'units' => $column['units'], 'decimals' => self::decimals($column['units'])])
						: $raw;
				}

				// Coloured where the template's triggers alarm, at the thresholds they use.
				if ($raw !== null && substr($column['key'], -strlen('[live.used.pct]')) === '[live.used.pct]' && (float) $raw > $warn) {
					$cell['class'] = 'ep-warn';
				}
				if ($raw !== null && substr($column['key'], -strlen('[live.days]')) === '[live.days]' && (float) $raw < $min_days) {
					$cell['class'] = 'ep-high';
				}

				$row['cells'][] = $cell;
				$export[] = $raw === null ? null : ($column['numeric'] ? round((float) $raw, 2) : $raw);
			}
			$data['rows'][] = $row;
			$export_rows[] = $export;
		}

		$order = array_keys($data['rows']);
		usort($order, fn($a, $b) => strnatcasecmp($data['rows'][$a]['cluster'], $data['rows'][$b]['cluster']));
		$data['rows'] = array_map(fn($i) => $data['rows'][$i], $order);
		$data['export'] = ['headers' => $headers, 'rows' => array_map(fn($i) => $export_rows[$i], $order),
			'types' => array_column($data['rows'], 'type')];

		$this->setResponse(new CControllerResponseData($data));
	}

	/** Client host group => DI / On-Prem, from each client's master host. */
	private static function clientTypes(): array {
		$masters = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => 'ElasticPro client master']]);
		if (!$masters) {
			return [];
		}
		$hostids = array_keys(API::Host()->get(['output' => [], 'templateids' => [$masters[0]['templateid']], 'preservekeys' => true]));
		if (!$hostids) {
			return [];
		}
		$by = [];
		foreach (API::UserMacro()->get(['output' => ['hostid', 'macro', 'value'], 'hostids' => $hostids,
				'filter' => ['macro' => ['{$GRP.CLIENT}', '{$EP.CLIENT.TYPE}']]]) ?: [] as $m) {
			$by[$m['hostid']][$m['macro']] = (string) ($m['value'] ?? '');
		}
		$out = [];
		foreach ($by as $m) {
			if (($m['{$GRP.CLIENT}'] ?? '') !== '') {
				$out[$m['{$GRP.CLIENT}']] = ($m['{$EP.CLIENT.TYPE}'] ?? '') !== '' ? $m['{$EP.CLIENT.TYPE}'] : 'On-Prem';
			}
		}
		return $out;
	}

	private static function macro(array $host, array $template, string $name, float $fallback): float {
		$value = $host[$name] ?? $template[$name] ?? null;
		return is_numeric($value) ? (float) $value : $fallback;
	}

	/** "!GB" → " (GB)": the export's numbers are already in the item's own units. */
	private static function exportSuffix(string $units): string {
		$u = ltrim($units, '!');
		return $u === '' ? '' : ' ('.$u.')';
	}

	private static function decimals(string $units): int {
		return in_array(ltrim($units, '!'), ['days', '']) ? 0 : 1;
	}
}
