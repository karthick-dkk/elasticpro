<?php declare(strict_types = 0);

namespace Modules\EpResources\Includes;

use Modules\EpResources\Lib\Bars;
use Zabbix\Widgets\CWidgetForm;
use Zabbix\Widgets\Fields\{CWidgetFieldMultiSelectGroup, CWidgetFieldSelect};

/**
 * Which host groups to read master hosts from, and how a figure with a percentage behind it is
 * drawn. Empty groups: every host carrying the "ElasticPro client master" template this user
 * can see.
 */
class WidgetForm extends CWidgetForm {

	/** The default lives with the styles, in Bars, so the two cannot drift apart. */
	public const BARS_DEFAULT = Bars::DEFAULT_STYLE;

	/** How a value with a usage percentage behind it is drawn. */
	public static function barStyles(): array {
		return [
			'under' => _('Bar under the value'),
			'cell' => _('Bar in the cell'),
			'segments' => _('Segments'),
			'none' => _('Numbers only')
		];
	}

	public function addFields(): self {
		return $this
			->addField(new CWidgetFieldMultiSelectGroup('groupids', _('Host groups')))
			->addField((new CWidgetFieldSelect('bars', _('Display'), self::barStyles()))->setDefault(self::BARS_DEFAULT));
	}
}
