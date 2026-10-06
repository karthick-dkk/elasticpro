<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

/**
 * Who changed what, and when — saves, imports, status changes, maintenance, restores — each with
 * the backup taken before it. Kept in the data folder, the newest thousand entries.
 */
class History {

	public const FILE = 'history.json';
	private const KEEP = 1000;

	public static function add(string $client, string $what, string $by, ?string $backup = null, string $detail = ''): void {
		$all = Store::read(self::FILE, []);
		$all[] = ['client' => $client, 'at' => time(), 'by' => $by, 'what' => $what, 'backup' => $backup, 'detail' => mb_substr($detail, 0, 500)];
		Store::write(self::FILE, array_slice($all, -self::KEEP));
	}

	/** A client's entries, newest first. */
	public static function of(string $client, int $limit = 50): array {
		$out = array_values(array_filter(Store::read(self::FILE, []), fn($e) => $e['client'] === $client));
		return array_slice(array_reverse($out), 0, $limit);
	}
}
