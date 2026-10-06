<?php declare(strict_types = 0);

namespace Modules\EpClients\Lib;

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

	public static function dir(): string {
		$dir = getenv('EP_DATA_DIR');
		return rtrim($dir !== false && $dir !== '' ? $dir : '/var/lib/elasticpro-zabbix', '/');
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
