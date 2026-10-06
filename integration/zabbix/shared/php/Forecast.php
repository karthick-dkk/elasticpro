<?php declare(strict_types = 0);

namespace EpShared;

/**
 * When a client's ES storage fills, from the master host's `ep.es.storage.full_in` (Zabbix
 * timeleft() over 7 days: seconds, or -1 when usage is flat or falling). One reading of it for
 * Cluster Management, Client capacity and its export.
 *
 * Shared: ../../sync-assets.mjs copies this into each module, under that module's namespace.
 */
class Forecast {

	public const KEY = 'ep.es.storage.full_in';

	/**
	 * null when not measured yet. Otherwise text ("23 days", "not growing"), level (bad under 7
	 * days, warn under 30, flat when it never fills, else ok) and days (null when flat).
	 */
	public static function fullIn(?float $seconds): ?array {
		if ($seconds === null) {
			return null;
		}
		$d = $seconds / 86400;
		if ($d < 0 || $d > 3650) {
			return ['text' => _('not growing'), 'level' => 'flat', 'days' => null];
		}
		$text = $d < 1 ? _('under a day')
			: ($d < 60 ? _n('%1$s day', '%1$s days', (int) floor($d)) : _n('%1$s month', '%1$s months', (int) floor($d / 30)));
		return ['text' => $text, 'level' => $d < 7 ? 'bad' : ($d < 30 ? 'warn' : 'ok'), 'days' => round($d, 1)];
	}
}
