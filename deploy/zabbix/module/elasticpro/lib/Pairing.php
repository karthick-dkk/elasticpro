<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Lib;

require_once __DIR__.'/Settings.php';
require_once __DIR__.'/SsoClient.php';

use API;
use CMessageHelper;
use CSettingsHelper;

/**
 * "Pair with ElasticPro" on Administration → ElasticPro.
 *
 * ElasticPro (Config → Zabbix → Pair with Zabbix) shows a one-time pairing code:
 * base64url(JSON {v: 1, ep, secret, nonce, exp}). Pasted here, the module — acting as the
 * Super admin who pasted it, through Zabbix's own API classes, so every step is permission-
 * checked and in the audit log —
 *
 *  1. creates or reuses the sync role and user named in sync-role.json (the one list the
 *     setup script uses too): API access, read methods only, no frontend;
 *  2. creates a NEW API token for that user;
 *  3. POSTs {nonce, zabbixUrl, apiUrl, apiToken, zabbixVersion, ts} to <ep>/zabbix/pair,
 *     signed exactly like the sign-in (SsoClient::postSigned — one implementation);
 *  4. on success stores {epUrl, secret, verifyTls, pairedAt, pairedBy, tokenId} and only
 *     then deletes the token an earlier pairing made; on failure deletes the token it just
 *     made and changes nothing else.
 *
 * Only tokens a pairing created (the one whose id is stored) are ever deleted: the setup
 * script's token, or anybody else's, is never touched.
 */
final class Pairing {

	/** A pairing code is valid for this long past its exp only to absorb clock skew. */
	private const SKEW_SECS = 60;

	/** sync-role.json: role, user, group and token names, and the API allow-list. */
	public static function spec(): array {
		$raw = file_get_contents(__DIR__.'/../sync-role.json');
		$spec = $raw !== false ? json_decode($raw, true) : null;
		if (!is_array($spec) || !isset($spec['roleName'], $spec['userName'], $spec['methods'])) {
			throw new \RuntimeException('sync-role.json is missing or unreadable in the module folder');
		}
		return $spec;
	}

	/**
	 * @return array{ep: string, secret: string, nonce: string, exp: int}
	 */
	public static function decodeCode(string $code): array {
		$code = preg_replace('/\s+/', '', $code) ?? '';
		if ($code === '') {
			throw new \RuntimeException('paste the pairing code from ElasticPro (Config → Zabbix → Pair with Zabbix)');
		}
		$b64 = strtr($code, '-_', '+/');
		$b64 .= str_repeat('=', (4 - strlen($b64) % 4) % 4);
		$json = base64_decode($b64, true);
		$data = $json !== false ? json_decode($json, true) : null;
		if (!is_array($data)) {
			throw new \RuntimeException('that is not an ElasticPro pairing code — copy it again, whole');
		}
		if (($data['v'] ?? null) !== 1) {
			throw new \RuntimeException('this pairing code is from a different ElasticPro version (v='
				.json_encode($data['v'] ?? null).'); this module understands v=1');
		}
		$ep = rtrim(trim((string) ($data['ep'] ?? '')), '/');
		$secret = trim((string) ($data['secret'] ?? ''));
		$nonce = (string) ($data['nonce'] ?? '');
		$exp = $data['exp'] ?? null;
		if (!self::isHttpUrl($ep)) {
			throw new \RuntimeException('the pairing code names no usable ElasticPro address');
		}
		if (strlen($secret) < 32 || $nonce === '' || !is_int($exp)) {
			throw new \RuntimeException('the pairing code is incomplete — copy it again, whole');
		}
		if ($exp + self::SKEW_SECS < time()) {
			throw new \RuntimeException('this pairing code expired at '.gmdate('Y-m-d H:i:s', $exp)
				.' UTC — start a new pairing in ElasticPro');
		}
		return ['ep' => $ep, 'secret' => $secret, 'nonce' => $nonce, 'exp' => $exp];
	}

	public static function isHttpUrl(string $url): bool {
		$p = parse_url($url);
		return is_array($p) && isset($p['scheme'], $p['host'])
			&& in_array(strtolower($p['scheme']), ['http', 'https'], true);
	}

	/** This Zabbix's frontend address: Administration → General → Other → Frontend URL, else the request's. */
	public static function defaultZabbixUrl(): string {
		$url = rtrim(trim((string) CSettingsHelper::get(CSettingsHelper::URL)), '/');
		if ($url !== '') {
			return preg_replace('~/(zabbix|index)\.php$~', '', $url) ?? $url;
		}
		$https = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off');
		$host = (string) ($_SERVER['HTTP_HOST'] ?? '');
		$dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
		return $host !== '' ? ($https ? 'https' : 'http').'://'.$host.$dir : '';
	}

	/**
	 * Run an internal API call; a failure becomes an exception carrying Zabbix's own message
	 * (the frontend wrapper returns false and queues the message instead of throwing).
	 */
	private static function api(string $what, callable $call) {
		$before = count(CMessageHelper::getMessages());
		$result = $call();
		if ($result === false) {
			$msgs = array_slice(CMessageHelper::getMessages(), $before);
			$text = implode('; ', array_map(fn($m) => (string) ($m['message'] ?? ''), $msgs));
			throw new \RuntimeException($what.' failed'.($text !== '' ? ': '.$text : ''));
		}
		return $result;
	}

	/** The rules sync-role.json asks for. */
	private static function rules(array $spec): array {
		return [
			'ui.default_access' => 0,
			'modules.default_access' => 0,
			'actions.default_access' => 0,
			'api.access' => 1,
			'api.mode' => 1,
			'api' => array_values($spec['methods']),
		];
	}

	/** Whether an existing role already grants exactly what the spec asks. */
	private static function roleMatches(array $role, array $spec): bool {
		$r = $role['rules'] ?? [];
		$have = array_values((array) ($r['api'] ?? []));
		$want = array_values($spec['methods']);
		sort($have);
		sort($want);
		foreach ((array) ($r['ui'] ?? []) as $ui) {
			if ((string) ($ui['status'] ?? '0') === '1') {
				return false;
			}
		}
		return (int) $role['type'] === (int) $spec['roleType']
			&& (string) ($r['api.access'] ?? '') === '1'
			&& (string) ($r['api.mode'] ?? '') === '1'
			&& (string) ($r['ui.default_access'] ?? '') === '0'
			&& (string) ($r['modules.default_access'] ?? '') === '0'
			&& (string) ($r['actions.default_access'] ?? '') === '0'
			&& $have === $want;
	}

	/** Create or reuse the sync role; returns its id. Updated only if it drifted from the spec. */
	private static function ensureRole(array $spec): string {
		$roles = self::api('role.get', fn() => API::Role()->get([
			'output' => ['roleid', 'type'],
			'selectRules' => API_OUTPUT_EXTEND,
			'filter' => ['name' => $spec['roleName']],
		]));
		if ($roles) {
			$role = reset($roles);
			if (!self::roleMatches($role, $spec)) {
				self::api('role.update', fn() => API::Role()->update([
					'roleid' => $role['roleid'],
					'type' => (int) $spec['roleType'],
					'rules' => self::rules($spec),
				]));
			}
			return (string) $role['roleid'];
		}
		$r = self::api('role.create', fn() => API::Role()->create([
			'name' => $spec['roleName'],
			'type' => (int) $spec['roleType'],
			'rules' => self::rules($spec),
		]));
		return (string) $r['roleids'][0];
	}

	/** The user group with frontend access disabled: the named one, else any such group. */
	private static function noFrontendGroup(array $spec): string {
		$groups = self::api('usergroup.get', fn() => API::UserGroup()->get([
			'output' => ['usrgrpid'],
			'filter' => ['name' => $spec['noFrontendGroup'], 'gui_access' => GROUP_GUI_ACCESS_DISABLED],
		]));
		if (!$groups) {
			$groups = self::api('usergroup.get', fn() => API::UserGroup()->get([
				'output' => ['usrgrpid'],
				'filter' => ['gui_access' => GROUP_GUI_ACCESS_DISABLED],
				'sortfield' => 'usrgrpid',
				'limit' => 1,
			]));
		}
		if (!$groups) {
			throw new \RuntimeException('no user group has frontend access disabled; create one (Users → User groups, '
				.'Frontend access: Disabled) — the sync user must not be able to sign in to Zabbix');
		}
		return (string) reset($groups)['usrgrpid'];
	}

	/** Create or reuse the sync user; returns its id. */
	private static function ensureUser(array $spec, string $roleid, string $groupid): string {
		$users = self::api('user.get', fn() => API::User()->get([
			'output' => ['userid', 'roleid'],
			'selectUsrgrps' => ['usrgrpid'],
			'filter' => ['username' => $spec['userName']],
		]));
		if ($users) {
			$user = reset($users);
			$in_group = in_array($groupid, array_column($user['usrgrps'], 'usrgrpid'), false);
			if ((string) $user['roleid'] !== $roleid || !$in_group) {
				self::api('user.update', fn() => API::User()->update([
					'userid' => $user['userid'],
					'roleid' => $roleid,
					'usrgrps' => [['usrgrpid' => $groupid]],
				]));
			}
			return (string) $user['userid'];
		}
		// Never shown, never stored: the user signs in with its API token only. Mixed classes
		// so a strict password policy accepts it.
		$password = 'Ev-'.bin2hex(random_bytes(20)).'-Zq7!';
		$r = self::api('user.create', fn() => API::User()->create([
			'username' => $spec['userName'],
			'passwd' => $password,
			'roleid' => $roleid,
			'usrgrps' => [['usrgrpid' => $groupid]],
		]));
		return (string) $r['userids'][0];
	}

	/**
	 * Role, user and a fresh token.
	 *
	 * @return array{userid: string, tokenid: string, token: string}
	 */
	public static function provision(string $by): array {
		$spec = self::spec();
		$roleid = self::ensureRole($spec);
		$userid = self::ensureUser($spec, $roleid, self::noFrontendGroup($spec));

		$name = ($spec['pairedTokenPrefix'] ?? 'elasticpro-paired-').gmdate('Ymd-His').'-'.bin2hex(random_bytes(3));   // unique even for two pairings in one second
		$r = self::api('token.create', fn() => API::Token()->create([
			'name' => $name,
			'userid' => $userid,
			'description' => 'ElasticPro cluster sync — made by pairing, from Administration → ElasticPro, by '.$by,
		]));
		$tokenid = (string) $r['tokenids'][0];
		try {
			$g = self::api('token.generate', fn() => API::Token()->generate([$tokenid]));
			$token = (string) ($g[0]['token'] ?? '');
			if ($token === '') {
				throw new \RuntimeException('token.generate returned no token');
			}
		}
		catch (\Throwable $e) {
			self::deleteToken($tokenid);
			throw $e;
		}
		return ['userid' => $userid, 'tokenid' => $tokenid, 'token' => $token];
	}

	/** Delete a token a pairing made. Returns false (with Zabbix's message queued) if it could not. */
	public static function deleteToken(string $tokenid): bool {
		if ($tokenid === '') {
			return true;
		}
		$exists = API::Token()->get(['output' => ['tokenid'], 'tokenids' => [$tokenid]]);
		if (!$exists) {
			return true;   // already gone
		}
		return API::Token()->delete([$tokenid]) !== false;
	}

	/**
	 * The call to ElasticPro. Throws with what it answered when it is not a success.
	 *
	 * @return array  ElasticPro's answer ({ok, epVersion, ...}).
	 */
	public static function sendPair(array $code, string $zabbix_url, string $api_url, string $token,
			bool $verify_tls): array {
		$body = json_encode([
			'nonce' => $code['nonce'],
			'zabbixUrl' => $zabbix_url,
			'apiUrl' => $api_url,
			'apiToken' => $token,
			'zabbixVersion' => ZABBIX_VERSION,
			'ts' => time(),
		], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($body === false) {
			throw new \RuntimeException('could not encode the pairing request');
		}
		$url = $code['ep'].'/zabbix/pair';
		$r = SsoClient::postSigned($url, $code['secret'], $body, $verify_tls, 15);
		if ($r['status'] === 0) {
			throw new \RuntimeException('could not reach ElasticPro at '.$url.': '.$r['error']
				.($verify_tls ? ' (if its certificate is self-signed, untick "Verify TLS" for a test only)' : ''));
		}
		$data = $r['data'];
		if ($r['status'] !== 200 || $data === null || ($data['ok'] ?? false) !== true) {
			$why = $data !== null
				? trim(((string) ($data['kind'] ?? '')).' '.((string) ($data['message'] ?? '')))
				: '';
			throw new \RuntimeException('ElasticPro refused the pairing (HTTP '.$r['status'].')'
				.($why !== '' ? ': '.$why : '')
				.($r['status'] === 404 ? ' — is this ElasticPro recent enough to pair, and does its nginx pass /zabbix/pair?' : ''));
		}
		return $data;
	}
}
