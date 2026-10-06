<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Lib;

use APP;
use CEncryptHelper;

/**
 * Where the module finds ElasticPro, and the secret it signs with. The one resolver:
 * the sign-in (SsoClient), the settings page and the pairing all read through here.
 *
 * Two sources, field by field:
 *
 *  - config.php in this module's folder — the file/server-managed way. When a key is in it,
 *    that key WINS, and the settings page shows the field read-only. Nothing here writes it.
 *  - the module's own config in the Zabbix database (`module.config`, written through
 *    CModule::setConfig() by Administration → ElasticPro). Keys:
 *      epUrl, secret (sealed, see seal()), verifyTls, pairedAt, pairedBy, mode ('pair' or
 *      'manual'), tokenId (the API token the pairing made, so a re-pair can retire it),
 *      zabbixUrl (what the pairing told ElasticPro this Zabbix is).
 *
 * The secret is sealed before it goes to the database: module.get returns `config` to any
 * Super admin with API access, and module.update writes the whole config into the audit
 * log. Sealed, both see ciphertext. The key is derived from Zabbix's own session key
 * (config.session_key), which no API returns. If that key is ever regenerated the secret
 * no longer opens; the page says so and a new pairing fixes it.
 */
final class Settings {

	public const MODULE_ID = 'elasticpro';

	/** config.php key => resolved field. */
	private const FILE_KEYS = [
		'core_url' => 'core_url',
		'public_url' => 'public_url',
		'module_secret' => 'secret',
		'verify_tls' => 'verify_tls',
	];

	private const SEAL_PREFIX = 'v1:';

	/** The config.php array, or null when there is no config.php. */
	public static function fileConfig(): ?array {
		$file = __DIR__.'/../config.php';
		if (!is_file($file)) {
			return null;
		}
		$config = require $file;
		return is_array($config) ? $config : [];
	}

	/** The module's stored config (database). Empty when the module object is not loaded. */
	public static function dbConfig(): array {
		$module = APP::ModuleManager()->getModule(self::MODULE_ID);
		return $module !== null ? $module->getConfig() : [];
	}

	/** Replace the stored config. Super admin only (module.update refuses anybody else). */
	public static function saveDbConfig(array $config): void {
		$module = APP::ModuleManager()->getModule(self::MODULE_ID);
		if ($module === null) {
			throw new \RuntimeException('the ElasticPro module is not loaded');
		}
		// setConfig() goes through module.update, whose frontend wrapper returns false and
		// queues the message rather than throwing; turn that into an exception.
		$before = count(\CMessageHelper::getMessages());
		$module->setConfig($config);
		$errors = array_filter(array_slice(\CMessageHelper::getMessages(), $before),
			fn($m) => ($m['type'] ?? '') === 'error'
		);
		if ($errors) {
			throw new \RuntimeException('module.update failed: '
				.implode('; ', array_map(fn($m) => (string) ($m['message'] ?? ''), $errors)));
		}
	}

	/**
	 * The settings the module runs on.
	 *
	 * @return array{core_url: string, public_url: string, secret: string, verify_tls: bool,
	 *               from_file: array<string, bool>, file_present: bool, secret_unreadable: bool}
	 */
	public static function resolve(): array {
		$db = self::dbConfig();
		$secret_db = self::open((string) ($db['secret'] ?? ''));
		$ep = rtrim(trim((string) ($db['epUrl'] ?? '')), '/');
		$out = [
			'core_url' => $ep,
			'public_url' => $ep,
			'secret' => $secret_db,
			'verify_tls' => (bool) ($db['verifyTls'] ?? true),
			'from_file' => array_fill_keys(array_values(self::FILE_KEYS), false),
			'file_present' => false,
			'secret_unreadable' => ($db['secret'] ?? '') !== '' && $secret_db === '',
		];

		$file = self::fileConfig();
		if ($file !== null) {
			$out['file_present'] = true;
			foreach (self::FILE_KEYS as $key => $field) {
				if (!array_key_exists($key, $file)) {
					continue;
				}
				if ($field === 'verify_tls') {
					$out[$field] = (bool) $file[$key];
				}
				else {
					$value = trim((string) $file[$key]);
					if ($value === '') {
						continue;   // an empty placeholder in config.php does not override
					}
					$out[$field] = $field === 'secret' ? $value : rtrim($value, '/');
				}
				$out['from_file'][$field] = true;
			}
		}
		return $out;
	}

	/** What the settings page may show: never the secret, only whether there is one. */
	public static function status(): array {
		$db = self::dbConfig();
		$r = self::resolve();
		return [
			'core_url' => $r['core_url'],
			'public_url' => $r['public_url'],
			'verify_tls' => $r['verify_tls'],
			'secret_set' => strlen($r['secret']) >= 32,
			'secret_unreadable' => $r['secret_unreadable'],
			'from_file' => $r['from_file'],
			'file_present' => $r['file_present'],
			'db' => [
				'epUrl' => (string) ($db['epUrl'] ?? ''),
				'verifyTls' => (bool) ($db['verifyTls'] ?? true),
				'secret_set' => ($db['secret'] ?? '') !== '',
				'pairedAt' => (int) ($db['pairedAt'] ?? 0),
				'pairedBy' => (string) ($db['pairedBy'] ?? ''),
				'mode' => (string) ($db['mode'] ?? ''),
				'zabbixUrl' => (string) ($db['zabbixUrl'] ?? ''),
				'tokenId' => (string) ($db['tokenId'] ?? ''),
			],
		];
	}

	private static function key(): string {
		// 32 bytes, from Zabbix's session key; the label keeps it apart from every other use.
		return hash('sha256', 'elasticpro:module-config:v1:'.CEncryptHelper::sign('elasticpro:module-config:v1'), true);
	}

	public static function seal(string $plain): string {
		$iv = random_bytes(12);
		$tag = '';
		$ct = openssl_encrypt($plain, 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $iv, $tag);
		if ($ct === false) {
			throw new \RuntimeException('could not seal the secret (openssl)');
		}
		return self::SEAL_PREFIX.base64_encode($iv.$tag.$ct);
	}

	/** The plain secret, or '' when there is none or it does not open. */
	public static function open(string $sealed): string {
		if (strpos($sealed, self::SEAL_PREFIX) !== 0) {
			return '';
		}
		$raw = base64_decode(substr($sealed, strlen(self::SEAL_PREFIX)), true);
		if ($raw === false || strlen($raw) < 29) {
			return '';
		}
		$plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA,
			substr($raw, 0, 12), substr($raw, 12, 16)
		);
		return $plain === false ? '' : $plain;
	}
}
