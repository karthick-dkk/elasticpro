<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * Writes the master template (from the roles) and the cluster devices template into Zabbix, and
 * says whether the ones there are current. Items, alerts, graphs and the dashboard page of a
 * removed role go with it; a new role's appear. Item keys stay the same across installs, so
 * history is kept.
 */
class TemplateInstaller {

	private const RULES = [
		'templates' => ['createMissing' => true, 'updateExisting' => true],
		'items' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
		'triggers' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
		'graphs' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
		'discoveryRules' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
		'templateDashboards' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
		'valueMaps' => ['createMissing' => true, 'updateExisting' => true]
	];

	public static function install(array $roles): void {
		// The devices template first: the master template's figures read its item.
		self::import(DevicesTemplate::export(), DevicesTemplate::NAME);
		self::import(JumpTemplate::export(), JumpTemplate::NAME);
		self::import(JumpTemplate::ulmExport(), JumpTemplate::ULM_NAME);
		self::import((new MasterTemplate($roles))->export(), MasterTemplate::NAME);
	}

	private static function import(array $export, string $name): void {
		$ok = API::Configuration()->import([
			'format' => 'json',
			'source' => json_encode($export, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
			'rules' => self::RULES
		]);
		if ($ok === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not import "%1$s": %2$s', $name, implode(' ', $said) ?: _('no reason given')));
		}
	}

	/** 'missing', 'outdated' or 'current'. */
	public static function status(array $roles): string {
		$tpls = API::Template()->get(['output' => ['templateid', 'host'], 'filter' => ['host' => [MasterTemplate::NAME, DevicesTemplate::NAME, JumpTemplate::NAME]],
			'selectMacros' => ['macro', 'value']]);
		$by = [];
		foreach ($tpls as $t) {
			$by[$t['host']] = array_column($t['macros'], 'value', 'macro');
		}
		if (!isset($by[MasterTemplate::NAME])) {
			return 'missing';
		}
		$current = ($by[MasterTemplate::NAME]['{$EP.ROLES.HASH}'] ?? '') === Roles::hash($roles)
			&& ($by[DevicesTemplate::NAME]['{$EP.DEVICES.VERSION}'] ?? '') === DevicesTemplate::VERSION
			&& ($by[JumpTemplate::NAME]['{$EP.JUMP.VERSION}'] ?? '') === JumpTemplate::VERSION;
		return $current ? 'current' : 'outdated';
	}
}
