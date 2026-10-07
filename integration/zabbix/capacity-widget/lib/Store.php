<?php declare(strict_types = 0);

namespace Modules\EpCapacity\Lib;

/**
 * The one writable place: roles, report column settings, backups, a pending import.
 *
 * Module folders are mounted read-only, so this lives in its own folder — $EP_DATA_DIR, or
 * /var/lib/elasticpro-zabbix. Every write goes to a temporary file first and is renamed into
 * place under a lock: a reader never sees half a file, and two admins saving at once do not
 * interleave.
 *
 * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.
 */
class Store {

	/** Where a fresh install keeps its data, and the folder looked in first when $EP_DATA_DIR is not set. */
	private const DIR = '/var/lib/elasticpro-zabbix';

	/**
	 * Legacy value, kept so an existing install is still recognised: this is the folder the
	 * module used before the product was renamed from ElasticVue to ElasticPro. The production
	 * install was never migrated, so roles.json, templates.json, the columns-*.json settings,
	 * the registry and every backup are still under this name. Without consulting it, writable()
	 * would make the new folder empty beside the real one and read() would hand back default
	 * roles, whose Roles::hash() then no longer matches the live template.
	 */
	private const LEGACY_DIR = '/var/lib/elasticvue-zabbix';

	/**
	 * The files that make a folder this module's own, and so the only ones dir() lets decide
	 * which of the two folders is the live one: the roles, the record of the installed template,
	 * and the backups. They repeat Roles::FILE, Roles::TEMPLATES_FILE and Backups::DIR as
	 * literals on purpose — the widgets' ColumnsSave action loads this class on its own, without
	 * Roles, so naming Roles::FILE here would make that action fatal on a column save. Keep these
	 * names in step with Roles and Backups if either is ever renamed.
	 */
	private const OWN_FILES = ['roles.json', 'templates.json'];
	private const OWN_SUBDIR = 'backups';

	/** Resolved once per request: dir() is called on every path(), and resolving it stats folders. */
	private static $resolved_dir = null;

	/**
	 * $EP_DATA_DIR wins when it is set. Otherwise the new folder is used as soon as it holds
	 * data, and only a new folder with nothing in it defers to the folder of the old name — so
	 * an install that was renamed keeps reading and writing the one set of files it already has,
	 * while a fresh install never touches the old name and never learns that it exists.
	 */
	public static function dir(): string {
		$dir = getenv('EP_DATA_DIR');
		if ($dir !== false && $dir !== '') {
			return rtrim($dir, '/');
		}
		if (self::$resolved_dir === null) {
			self::$resolved_dir = !self::holds_data(self::DIR) && self::holds_data(self::LEGACY_DIR)
				? self::LEGACY_DIR
				: self::DIR;
		}
		return self::$resolved_dir;
	}

	/**
	 * Does a folder already hold the data that belongs to this module? Existing is not enough to
	 * decide it: writable() creates the folder and write() drops a .lock and .tmp-<pid> file in
	 * it, so a folder that only ever got that far holds nothing and must not out-rank an older
	 * folder that holds the live clients.
	 *
	 * Only OWN_FILES and a backup count. The test used to be any .json in the folder or one
	 * level below it, and that version was the dangerous one, because all four modules share
	 * this one folder and each widget writes its own columns-<report>.json into the top of it
	 * from its ColumnsSave action. A folder holding nothing but one widget's column preferences
	 * therefore counted as ours and won; the folder of the old name, the one holding the real
	 * roles.json, was never consulted; Roles::load() handed back the shipped default roles; and
	 * the next template write deleted every per-role item the site's real roles had defined,
	 * because TemplateInstaller::RULES carry deleteMissing for items, triggers, graphs and
	 * discovery rules, from every master host linked to that template. Zabbix item history is
	 * gone for good once the item is, and no backup this module takes can bring it back, so the
	 * decision of which folder is live must rest only on files that say "the clients were
	 * configured here" and never on a file that any module may drop in passing.
	 *
	 * The bookkeeping files — changes.json, history.json, registry.json, pending-import.json —
	 * are deliberately not counted. Each is only ever written into the folder this test has
	 * already picked, so counting them cannot change the answer it gives, and every extra name
	 * here is one more way for an incidental file to win the folder. columns-*.json is left out
	 * for the same reason it caused the fault: it is written by three other modules, and a lost
	 * column preference costs a few clicks, while the wrong folder costs history.
	 */
	private static function holds_data(string $dir): bool {
		if (!is_dir($dir)) {
			return false;
		}
		foreach (self::OWN_FILES as $name) {
			if (is_file($dir.'/'.$name)) {
				return true;
			}
		}
		return (glob($dir.'/'.self::OWN_SUBDIR.'/*.json') ?: []) !== [];
	}

	public static function path(string $name): string {
		return self::dir().'/'.$name;
	}

	/**
	 * Is the folder there and writable? Everything that saves checks this first. A folder that
	 * is missing is made, where its parent lets us — a fresh volume holds only its parent.
	 */
	public static function writable(): bool {
		$dir = self::dir();
		if (!is_dir($dir)) {
			@mkdir($dir, 0770, true);
		}
		return is_dir($dir) && is_writable($dir);
	}

	public static function read(string $name, $default = null) {
		$file = self::path($name);
		if (!is_file($file)) {
			return $default;
		}
		$data = json_decode((string) file_get_contents($file), true);
		return is_array($data) ? $data : $default;
	}

	public static function write(string $name, array $data): void {
		if (!self::writable()) {
			throw new \RuntimeException(sprintf('The data folder %s is missing or not writable — see the Clients module README.', self::dir()));
		}
		$file = self::path($name);
		$dir = dirname($file);
		if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) {
			throw new \RuntimeException(sprintf('Cannot create %s.', $dir));
		}
		$lock = fopen(self::path('.lock'), 'c');
		flock($lock, LOCK_EX);
		try {
			$tmp = $file.'.tmp-'.getmypid();
			if (file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) === false
					|| !rename($tmp, $file)) {
				@unlink($tmp);
				throw new \RuntimeException(sprintf('Cannot write %s.', $file));
			}
		}
		finally {
			flock($lock, LOCK_UN);
			fclose($lock);
		}
	}

	public static function delete(string $name): void {
		$file = self::path($name);
		if (is_file($file)) {
			@unlink($file);
		}
	}

	/** Files in a sub-folder, newest first. */
	public static function listing(string $sub): array {
		$files = glob(self::path($sub).'/*.json') ?: [];
		usort($files, fn($a, $b) => strcmp(basename($b), basename($a)));
		return array_map(fn($f) => $sub.'/'.basename($f), $files);
	}
}
