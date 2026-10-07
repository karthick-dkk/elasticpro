<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * The template that marks a Zabbix host as an Elasticsearch cluster, and carries the
 * connection to it.
 *
 * This exists because the core finds clusters by template name: a host linked to
 * `Roles::clusterTemplate()` is a cluster, and its macros say where that cluster is and how
 * to sign in (crates/elasticpro-core/src/zabbix_api.rs documents the same table). Until now
 * nothing created that template. It came from an export each site happened to have, so a
 * fresh install paired successfully and then every sync failed with "no template named … in
 * Zabbix" — a dead end whose fix was a file the operator did not have. The module writes it
 * now, alongside the master and devices templates it already writes.
 *
 * It deliberately collects nothing. ElasticPro polls the cluster itself, directly and on its
 * own schedule, so items here would ask the same questions a second time and bill the cluster
 * twice for the answer. What the template is *for* is the link and the macros — which is why
 * its visible name says so, while the technical name stays exactly what the core looks for.
 * A site that also wants Zabbix-side Elasticsearch metrics links its own ES template beside
 * this one; the two do not conflict.
 *
 * The name is whatever `Roles::clusterTemplate()` returns, so the template written here and
 * the name the core searches for cannot drift apart — they are the same setting.
 */
class ClusterTemplate {

	/** Raised when the macro set changes, so the Clients page offers to write it again. */
	public const VERSION = '1';

	public static function name(): string {
		return Roles::clusterTemplate();
	}

	public static function uuid(string $what): string {
		return MasterTemplate::uuid('cluster/'.$what);
	}

	/**
	 * Every macro the core reads, each present but empty.
	 *
	 * Empty rather than absent, and empty rather than guessed: a macro that is on the
	 * template shows up in the host's macro list the moment the host is linked, so whoever
	 * fills it in can see what is wanted without reading documentation first. A plausible
	 * default — localhost, 9200, http — would be worse than nothing, because a host left
	 * half-configured would then point confidently at the wrong cluster rather than failing.
	 */
	private const MACROS = [
		['{$ELASTICSEARCH.SCHEME}', '', 'http or https.'],
		['{$ELASTICSEARCH.HOST}', '', 'Host or IP of the cluster.'],
		['{$ELASTICSEARCH.PORT}', '9200', 'Usually 9200.'],
		['{$ELASTICSEARCH.USERNAME}', '', 'Elasticsearch user. Leave empty for a cluster with security disabled.'],
		// Type is left at TEXT here. A Secret macro cannot be read back through the API by
		// anyone, including the core, so a password stored as one is reported as unreadable
		// rather than used; a Vault macro (mount/path:key) is the supported way to hold it.
		['{$ELASTICSEARCH.PASSWORD}', '', 'A Vault reference, mount/path:key. A Zabbix "Secret text" macro cannot be read back through the API, so it will not work here.'],
		['{$ELASTICSEARCH.JUMPHOST}', '', 'An ElasticPro jump host id, or empty for a direct connection.'],
		['{$GRP.CLIENT}', '', 'The client this cluster belongs to.'],
	];

	public static function export(): array {
		$macros = [];
		foreach (self::MACROS as [$macro, $value, $description]) {
			$macros[] = ['macro' => $macro, 'value' => $value, 'description' => $description];
		}
		$macros[] = ['macro' => '{$EP.CLUSTER.VERSION}', 'value' => self::VERSION,
			'description' => 'Written by ElasticPro so the Clients page can tell whether this template is current.'];

		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [[
				'uuid' => self::uuid('template'),
				// The technical name is the contract with the core: it searches for exactly
				// this string, so it must not be decorated.
				'template' => self::name(),
				'name' => self::name().' (connection for ElasticPro)',
				'description' => "Link this to a host and fill its macros, and ElasticPro treats that host as an Elasticsearch cluster.\n\n"
					."It collects nothing on purpose: ElasticPro polls the cluster directly, so items here would ask the same "
					."questions twice. Link your own Elasticsearch template beside this one if you also want Zabbix-side metrics.\n\n"
					."Written by the ElasticPro Clients module. The name must match the cluster template setting in ElasticPro "
					."(Config -> Zabbix) and the ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE setting on the server.",
				'vendor' => ['name' => 'ElasticPro', 'version' => '7.0-'.self::VERSION],
				'groups' => [['name' => 'Templates/Applications']],
				'macros' => $macros,
			]],
			'template_groups' => [[
				'uuid' => self::uuid('group'),
				'name' => 'Templates/Applications',
			]],
		]];
	}
}
