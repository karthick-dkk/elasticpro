<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Lib;

require_once __DIR__.'/Settings.php';

/**
 * Asks the ElasticPro core for a one-time sign-in code for the Zabbix user looking at
 * the page.
 *
 * The request is `{username, zabbix_user_type, groups, ts, nonce}`, signed with
 * HMAC-SHA256 under the shared secret. The core checks the signature, the clock (±60 s) and
 * the nonce (once only), creates or refreshes the account `<username>@zabbix`, and
 * answers with a code that works once, for sixty seconds. The browser then loads the app
 * with that code and the app trades it for a session.
 *
 * Settings come from Settings::resolve() — config.php when present (it wins, key by key),
 * else what Administration → ElasticPro stored. Two addresses, kept apart on purpose:
 *
 *  - `core_url` is where THIS SERVER reaches the core. On the Docker deployment that may be
 *    the internal network (http://ep-core:8765, config.php only).
 *  - `public_url` is what the VISITOR'S BROWSER loads in the frame — an address the browser
 *    can reach, normally the ElasticPro URL people already use.
 *  A pairing stores one ElasticPro URL, used for both.
 *
 * Every failure returns null with a reason, never a half-built URL: a frame pointed at a
 * dead code is a blank rectangle nobody can diagnose.
 *
 * sign() and postSigned() are the ONE implementation of the module's signed server-to-server
 * call: the sign-in here, the pairing (Pairing.php) and the connection test all use them.
 */
class SsoClient {

	private string $core_url;
	private string $public_url;
	private string $secret;
	private bool $verify_tls;
	private string $last_error = '';

	public function __construct(?array $settings = null) {
		$s = $settings ?? Settings::resolve();
		$this->core_url = rtrim((string) $s['core_url'], '/');
		$this->public_url = rtrim((string) $s['public_url'], '/');
		$this->secret = trim((string) $s['secret']);
		$this->verify_tls = (bool) $s['verify_tls'];
	}

	public function isConfigured(): bool {
		return $this->core_url !== '' && $this->public_url !== '' && strlen($this->secret) >= 32;
	}

	public function publicUrl(): string {
		return $this->public_url;
	}

	public function lastError(): string {
		return $this->last_error;
	}

	/** The exact bytes signed are the exact bytes sent. */
	public static function sign(string $secret, string $body): string {
		return hash_hmac('sha256', $body, trim($secret));
	}

	/**
	 * POST `$body` to `$url`, signed under `$secret` in X-Zabbix-Module-Signature.
	 *
	 * @return array{status: int, data: ?array, error: string}  status 0 = never answered.
	 */
	public static function postSigned(string $url, string $secret, string $body, bool $verify_tls,
			int $timeout = 5): array {
		return self::request($url, $verify_tls, $timeout, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => $body,
			CURLOPT_HTTPHEADER => [
				'Content-Type: application/json',
				'X-Zabbix-Module-Signature: '.self::sign($secret, $body),
			],
		]);
	}

	/** A plain GET — the connection test's "is anything there, and is its TLS trusted". */
	public static function get(string $url, bool $verify_tls, int $timeout = 5): array {
		return self::request($url, $verify_tls, $timeout, [CURLOPT_HTTPGET => true]);
	}

	private static function request(string $url, bool $verify_tls, int $timeout, array $opts): array {
		$ch = curl_init($url);
		if ($ch === false) {
			return ['status' => 0, 'data' => null, 'error' => 'curl is not available'];
		}
		curl_setopt_array($ch, $opts + [
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_FOLLOWLOCATION => false,
			CURLOPT_CONNECTTIMEOUT => 3,
			CURLOPT_TIMEOUT => $timeout,
			CURLOPT_SSL_VERIFYPEER => $verify_tls,
			CURLOPT_SSL_VERIFYHOST => $verify_tls ? 2 : 0,
		]);
		$raw = curl_exec($ch);
		$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
		$curl_error = curl_error($ch);
		// No curl_close(): it has done nothing since PHP 8.0 and is deprecated in 8.5, where
		// Zabbix shows the deprecation as a red banner over the page.

		if ($raw === false) {
			return ['status' => 0, 'data' => null, 'error' => $curl_error !== '' ? $curl_error : 'no answer'];
		}
		$data = json_decode((string) $raw, true);
		return ['status' => $status, 'data' => is_array($data) ? $data : null, 'error' => ''];
	}

	/**
	 * @param string[] $groups  Names of the Zabbix user groups this user is in.
	 * @return string|null      A one-time code, or null (see lastError()).
	 */
	public function mintCode(string $username, int $user_type, array $groups): ?string {
		if (!$this->isConfigured()) {
			$this->last_error = 'the module is not configured';
			return null;
		}
		$body = json_encode([
			'username' => $username,
			'zabbix_user_type' => $user_type,
			'groups' => array_values($groups),
			'ts' => time(),
			'nonce' => bin2hex(random_bytes(16)),
		], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($body === false) {
			$this->last_error = 'could not encode the request';
			return null;
		}

		$r = self::postSigned($this->core_url.'/sso/zabbix', $this->secret, $body, $this->verify_tls);
		if ($r['status'] === 0) {
			$this->last_error = 'could not reach ElasticPro at '.$this->core_url.': '.$r['error'];
			return null;
		}
		$data = $r['data'];
		if ($r['status'] !== 200 || $data === null || empty($data['sso_code'])) {
			$this->last_error = $data !== null && isset($data['message'])
				? (string) $data['message']
				: 'ElasticPro answered HTTP '.$r['status'];
			return null;
		}
		return (string) $data['sso_code'];
	}

	/** The frame's address: the app, the code, the embed flag, the theme and the page. */
	/** `$extra` is the troubleshoot request (zbx_host, client, rule, problem), or empty. */
	public function frameUrl(string $code, string $page, string $theme, array $extra = []): string {
		return $this->public_url.'/?'.http_build_query([
			'sso_code' => $code,
			'embed' => '1',
			'zbx_theme' => $theme,
		] + $extra).'#/'.rawurlencode($page);
	}
}
