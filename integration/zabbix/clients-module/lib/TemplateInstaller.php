<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

use API;
use Exception;

/**
 * Writes the master template (from the roles) and the cluster devices template into Zabbix, and
 * says whether the ones there are current. Items, alerts, graphs and the dashboard page of a
 * removed role go with it; a new role's appear. Item keys stay the same across installs, so
 * history is kept.
 *
 * That last sentence holds within one generation of the product's names only. The rename changed
 * the template names, the uuids and every item key (evp.* became ep.*), so on an install written
 * before it the import creates a second, unrelated set beside the live one instead of updating
 * it. This class recognises the old names so that status() tells the truth about such an install
 * and legacyCollision() can report it; it never writes one of them, and it never takes a template
 * off a host, because that is where the history is.
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

	/**
	 * The names these same templates had before the product was renamed, each against the uuid
	 * seed its template object was written from (MasterTemplate::uuid() / legacyUuid()).
	 *
	 * Legacy values, kept for recognition only. install() writes the current names and nothing
	 * here ever writes one of these. They are needed because a production Zabbix with live
	 * clients still carries the old generation and there will be no migration, so whether an
	 * install is current cannot be decided from the current names alone: without this list
	 * status() answers 'current' or 'missing' about a Zabbix whose real problem is that both
	 * generations are on the same hosts.
	 */
	private const LEGACY_TEMPLATES = [
		'template' => MasterTemplate::LEGACY_NAME,
		'devices/template' => 'ElasticVue Pro cluster devices',
		'jump/template' => 'ElasticVue Pro Elasticsearch via SSH jump host',
		'jump/ulm/template' => 'ElasticVue Pro log archive ES via SSH jump host',
		'cluster/template' => 'Elasticsearch Cluster by HTTP EVP'
	];

	public static function install(array $roles): void {
		// The cluster template first: it is the one the core searches for to find clusters
		// at all, so a site that gets no further than this still has a working sync.
		self::import(ClusterTemplate::export(), ClusterTemplate::name());
		// The devices template next: the master template's figures read its item.
		self::import(DevicesTemplate::export(), DevicesTemplate::name());
		self::import(JumpTemplate::export(), JumpTemplate::name());
		self::import(JumpTemplate::ulmExport(), JumpTemplate::ulmName());
		self::import((new MasterTemplate($roles))->export(), MasterTemplate::name());
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

	/** The names install() writes. A legacy name that is also one of these is not a leftover. */
	private static function currentNames(): array {
		return [MasterTemplate::name(), DevicesTemplate::name(), JumpTemplate::name(), JumpTemplate::ulmName(), ClusterTemplate::name()];
	}

	/**
	 * The legacy names worth looking for: the old ones that are not also a name in use now.
	 *
	 * The subtraction is not theoretical. The cluster template's name is a setting
	 * (Roles::clusterTemplate()), so a site that pointed the Roles page at the pre-rename
	 * 'Elasticsearch Cluster by HTTP EVP' is using that name on purpose — this module writes
	 * that template, it is current, and calling it a leftover would send an administrator to
	 * take the one template the cluster hosts need off them.
	 *
	 * @return array uuid seed => legacy template name
	 */
	private static function legacyTemplates(): array {
		$current = self::currentNames();
		return array_filter(self::LEGACY_TEMPLATES, fn($name) => !in_array($name, $current, true));
	}

	/** 'missing', 'outdated' or 'current'. */
	public static function status(array $roles): string {
		$legacy = array_values(self::legacyTemplates());
		// The legacy names are asked for in the same call as the current ones: a host cannot
		// carry a template that is not in the install, so when none of them is here, neither
		// the install nor any host has one.
		$tpls = API::Template()->get(['output' => ['templateid', 'host'],
			'filter' => ['host' => array_merge(self::currentNames(), $legacy)],
			'selectMacros' => ['macro', 'value']]);
		$by = [];
		foreach ($tpls as $t) {
			$by[$t['host']] = array_column($t['macros'], 'value', 'macro');
		}
		// A template of the old generation is still here, so the install is not current whatever
		// the current templates' macros say. Answered before 'missing' deliberately: 'missing'
		// tells the operator the templates are not in Zabbix yet and to write them before adding
		// clients, which on the install this is written for — seven live clients already running
		// on the old templates — is untrue, and it says nothing about the collision the import
		// has made or is about to make. It stays 'outdated' until a person clears the old
		// generation by hand, which legacyCollision() describes; this module will not do it.
		if (array_intersect($legacy, array_keys($by))) {
			return 'outdated';
		}
		// The cluster template counts as missing too: without it the core finds no clusters
		// at all, which is a louder failure than an out-of-date master template.
		if (!isset($by[MasterTemplate::name()]) || !isset($by[ClusterTemplate::name()])) {
			return 'missing';
		}
		$current = ($by[MasterTemplate::name()]['{$EP.ROLES.HASH}'] ?? '') === Roles::hash($roles)
			&& ($by[DevicesTemplate::name()]['{$EP.DEVICES.VERSION}'] ?? '') === DevicesTemplate::VERSION
			&& ($by[JumpTemplate::name()]['{$EP.JUMP.VERSION}'] ?? '') === JumpTemplate::VERSION
			&& ($by[ClusterTemplate::name()]['{$EP.CLUSTER.VERSION}'] ?? '') === ClusterTemplate::VERSION;
		return $current ? 'current' : 'outdated';
	}

	/**
	 * Which templates of the old generation are in this Zabbix, and which hosts carry them.
	 *
	 * Reporting only. Nothing here unlinks, clears, deletes or re-imports anything, and that is
	 * the point: RULES carries deleteMissing for items, triggers, graphs, discovery rules and
	 * template dashboards, so an unlink-and-clear or a re-import aimed at a legacy template
	 * destroys item history that no backup in this module can give back. The master host is
	 * found whatever generation it is on — it is named <client>-Master, which the rename did not
	 * change — so "Write master template" imports the new template beside the old one and leaves
	 * the host with two full sets of calculated items and two shortfall triggers per role:
	 * double alerts, and two values behind every figure the widgets read.
	 *
	 * What a Super admin should do about a reported collision, in a maintenance window and host
	 * by host rather than template by template: open Data collection → Hosts → the host named
	 * here → Templates, where both generations are listed, and unlink the legacy one — the name
	 * in this report, never 'ElasticPro client master', because the current template is the only
	 * one this module writes and the only one Cluster Management, the widgets and the Client
	 * capacity report read (every item key changed with the rename, evp.es.storage.used became
	 * ep.es.storage.used, so the two sets are unrelated items to Zabbix). Use "Unlink", not
	 * "Unlink and clear": unlink leaves the old evp.* items, their triggers and graphs on the
	 * host as host-level objects with all their history intact and still readable in Latest
	 * data, after which disabling those leftover items and triggers stops the collection and the
	 * second copy of every alert without deleting a single value. "Unlink and clear" ends the
	 * duplicate alerts in one step and deletes every evp.* value along with the items — however
	 * many months of capacity and log-delay history the server's retention held, irrecoverably,
	 * with no undo in Zabbix and nothing in these backups that restores it. Either way nothing
	 * carries across: the ep.* items begin empty at the moment they were linked, so graphs, the
	 * capacity report and the shortfall triggers see only data from that moment on, and the
	 * older series survives only as those host-level leftovers until its retention expires.
	 * Delete the legacy template object itself last, once no host is linked to it and nobody
	 * needs what still hangs off it; and if the report says a legacy-named template was not
	 * written here, leave it alone — it belongs to the site, not to this module.
	 *
	 * Only a Super admin can read templates through the API at all, so a Zabbix Admin gets an
	 * empty report rather than a wrong one — the same blind spot status() has always had, and
	 * harmless here because the remedy above is Super admin work anyway.
	 *
	 * @return array one row per legacy template found: template, templateid, uuid,
	 *               written_here (its uuid is the one this module used to write before the
	 *               rename, so the template is ours and not a site's own with the same name),
	 *               and hosts — hostid, host and also_current, which is true when that host is
	 *               linked to a current-generation template as well and so carries both sets.
	 */
	public static function legacyCollision(): array {
		$legacy = self::legacyTemplates();
		$found = $legacy
			? API::Template()->get(['output' => ['templateid', 'host', 'uuid'], 'filter' => ['host' => array_values($legacy)]])
			: [];
		$seedOf = array_flip($legacy);
		$current = self::currentNames();
		$out = [];
		foreach ($found as $t) {
			$hosts = [];
			// Asked per template rather than for all of them in one call: templateids also
			// matches a host that reaches a template through another template, and a single
			// call could not say which of the legacy templates brought a given host in.
			foreach (API::Host()->get(['output' => ['hostid', 'host'], 'templateids' => [$t['templateid']],
					'selectParentTemplates' => ['host']]) as $h) {
				$hosts[] = ['hostid' => $h['hostid'], 'host' => $h['host'],
					'also_current' => (bool) array_intersect($current, array_column($h['parentTemplates'] ?? [], 'host'))];
			}
			$out[] = ['template' => $t['host'], 'templateid' => $t['templateid'], 'uuid' => $t['uuid'] ?? '',
				'written_here' => ($t['uuid'] ?? '') === MasterTemplate::legacyUuid($seedOf[$t['host']] ?? ''),
				'hosts' => $hosts];
		}
		return $out;
	}
}
