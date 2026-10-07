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
		// The cluster template first: it is the one the core searches for to find clusters
		// at all, so a site that gets no further than this still has a working sync.
		self::import(ClusterTemplate::export(), ClusterTemplate::name());
		// The devices template next: the master template's figures read its item.
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
		$tpls = API::Template()->get(['output' => ['templateid', 'host'], 'filter' => ['host' => [MasterTemplate::NAME, DevicesTemplate::NAME, JumpTemplate::NAME, ClusterTemplate::name()]],
			'selectMacros' => ['macro', 'value']]);
		$by = [];
		foreach ($tpls as $t) {
			$by[$t['host']] = array_column($t['macros'], 'value', 'macro');
		}
		// The cluster template counts as missing too: without it the core finds no clusters
		// at all, which is a louder failure than an out-of-date master template.
		if (!isset($by[MasterTemplate::NAME]) || !isset($by[ClusterTemplate::name()])) {
			return 'missing';
		}
		$current = ($by[MasterTemplate::NAME]['{$EP.ROLES.HASH}'] ?? '') === Roles::hash($roles)
			&& ($by[DevicesTemplate::NAME]['{$EP.DEVICES.VERSION}'] ?? '') === DevicesTemplate::VERSION
			&& ($by[JumpTemplate::NAME]['{$EP.JUMP.VERSION}'] ?? '') === JumpTemplate::VERSION
			&& ($by[ClusterTemplate::name()]['{$EP.CLUSTER.VERSION}'] ?? '') === ClusterTemplate::VERSION;
		return $current ? 'current' : 'outdated';
	}
}
