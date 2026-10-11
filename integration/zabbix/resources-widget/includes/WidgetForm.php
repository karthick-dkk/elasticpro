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

	/** The Display setting stores the position in Bars::STYLES; Zabbix wants an integer here. */
	public const BARS_DEFAULT = Bars::DEFAULT_VALUE;

	public function addFields(): self {
		return $this
			->addField(new CWidgetFieldMultiSelectGroup('groupids', _('Host groups')))
			->addField((new CWidgetFieldSelect('bars', _('Display'), Bars::options()))->setDefault(self::BARS_DEFAULT));
	}
}
