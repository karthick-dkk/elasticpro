<?php declare(strict_types = 0);

namespace EpShared;

/**
 * A client's type — one list for Cluster Management and Host Inventory. DI needs the log archive
 * (S3); CI and On-Prem do not.
 *
 * Shared: ../../sync-assets.mjs copies this into each module, under that module's namespace.
 */
class ClientTypes {

	public const ALL = ['CI', 'DI', 'On-Prem'];
	public const DEFAULT = 'On-Prem';

	/** "di", "on prem", "On_Prem", "onpremise" … → the canonical spelling; anything else unchanged. */
	public static function normalize(string $v): string {
		$k = strtolower(str_replace([' ', '_', '-'], '', trim($v)));
		return ['ci' => 'CI', 'di' => 'DI', 'onprem' => 'On-Prem', 'onpremise' => 'On-Prem', 'onpremises' => 'On-Prem'][$k] ?? trim($v);
	}
}
