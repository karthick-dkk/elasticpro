<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Actions;

require_once __DIR__.'/../lib/Settings.php';
require_once __DIR__.'/../lib/SsoClient.php';
require_once __DIR__.'/../lib/Pairing.php';

use CController;
use CControllerResponseFatal;
use CControllerResponseRedirect;
use CMessageHelper;
use CUrl;
use CWebUser;
use Modules\ElasticPro\Lib\Pairing;
use Modules\ElasticPro\Lib\Settings;
use Modules\ElasticPro\Lib\SsoClient;

/**
 * Every change on Administration → ElasticPro: pair, save manual settings, test, unpair.
 * POST only, CSRF token required (Zabbix checks it before checkInput for module actions),
 * Super admins only. Always answers with a redirect back to the page and a message; never
 * echoes the secret, the pairing code or the token.
 */
class LinkUpdate extends CController {

	protected function checkInput(): bool {
		$ok = $this->validateInput([
			'op' => 'required|in pair,manual,test,unpair',
			'code' => 'string',
			'zabbix_url' => 'string',
			'api_url' => 'string',
			'ep_url' => 'string',
			'secret' => 'string',
			'verify_tls' => 'in 0,1',
		]);
		if (!$ok) {
			$this->setResponse(new CControllerResponseFatal());
		}
		return $ok;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	private function by(): string {
		return (string) CWebUser::$data['username'];
	}

	protected function doAction(): void {
		// Messages the internal API queued while failing are folded into ours; start clean.
		CMessageHelper::clear();
		try {
			switch ($this->getInput('op')) {
				case 'pair':
					$this->pair();
					break;
				case 'manual':
					$this->manual();
					break;
				case 'test':
					$this->test();
					break;
				case 'unpair':
					$this->unpair();
					break;
			}
		}
		catch (\Throwable $e) {
			CMessageHelper::clear();
			CMessageHelper::setErrorTitle(_('ElasticPro: not done'));
			CMessageHelper::addError($e->getMessage());
		}
		$this->setResponse(new CControllerResponseRedirect(
			(new CUrl('zabbix.php'))->setArgument('action', 'elasticpro.link.edit')
		));
	}

	private function fileNote(): void {
		$s = Settings::resolve();
		if ($s['file_present']) {
			$keys = array_keys(array_filter($s['from_file']));
			if ($keys) {
				CMessageHelper::addWarning(_s('config.php in the module folder still sets %1$s and wins over what is stored here. Remove config.php (or those keys) to run on these settings.',
					implode(', ', $keys)
				));
			}
		}
	}

	private function pair(): void {
		$code = Pairing::decodeCode((string) $this->getInput('code', ''));

		$zabbix_url = rtrim(trim((string) $this->getInput('zabbix_url', '')), '/');
		if ($zabbix_url === '') {
			$zabbix_url = Pairing::defaultZabbixUrl();
		}
		if (!Pairing::isHttpUrl($zabbix_url)) {
			throw new \RuntimeException('"This Zabbix\'s address" must be an http(s) URL');
		}
		$api_url = trim((string) $this->getInput('api_url', ''));
		if ($api_url === '') {
			$api_url = $zabbix_url.'/api_jsonrpc.php';
		}
		if (!Pairing::isHttpUrl($api_url)) {
			throw new \RuntimeException('"API URL for ElasticPro" must be an http(s) URL');
		}
		$verify = $this->getInput('verify_tls', '0') === '1';
		$old = Settings::dbConfig();

		// 1. Role, user, a NEW token. The old token keeps working until this pairing succeeds.
		$made = Pairing::provision($this->by());

		// 2. Tell ElasticPro. On any failure the new token goes and nothing else changes.
		try {
			$answer = Pairing::sendPair($code, $zabbix_url, $api_url, $made['token'], $verify);
		}
		catch (\Throwable $e) {
			$gone = Pairing::deleteToken($made['tokenid']);
			throw new \RuntimeException($e->getMessage().($gone
				? ' — the API token made for this attempt was deleted; nothing else changed.'
				: ' — and the API token made for this attempt could not be deleted: remove it under Users → API tokens.'));
		}

		// 3. Keep it. ElasticPro already holds the new token, so from here on nothing is undone.
		try {
			Settings::saveDbConfig([
				'epUrl' => $code['ep'],
				'secret' => Settings::seal($code['secret']),
				'verifyTls' => $verify,
				'pairedAt' => time(),
				'pairedBy' => $this->by(),
				'mode' => 'pair',
				'tokenId' => $made['tokenid'],
				'zabbixUrl' => $zabbix_url,
			]);
		}
		catch (\Throwable $e) {
			throw new \RuntimeException('ElasticPro accepted the pairing, but saving it here failed ('
				.$e->getMessage().'). Pair again from a new code.');
		}

		// 4. Retire the token an earlier pairing made — only now, and only that one.
		$old_token = (string) ($old['tokenId'] ?? '');
		CMessageHelper::setSuccessTitle(_s('Paired with ElasticPro at %1$s', $code['ep']));
		if (isset($answer['epVersion'])) {
			CMessageHelper::addSuccess(_s('ElasticPro version: %1$s', (string) $answer['epVersion']));
		}
		if ($old_token !== '' && $old_token !== $made['tokenid'] && !Pairing::deleteToken($old_token)) {
			CMessageHelper::addWarning(_s('The previous pairing\'s API token (id %1$s) could not be deleted; remove it under Users → API tokens.', $old_token));
		}
		$this->fileNote();
	}

	private function manual(): void {
		$old = Settings::dbConfig();
		$s = Settings::resolve();

		$ep = rtrim(trim((string) $this->getInput('ep_url', '')), '/');
		if ($ep === '') {
			$ep = (string) ($old['epUrl'] ?? '');
		}
		$file_has_urls = $s['from_file']['core_url'] && $s['from_file']['public_url'];
		if ($ep !== '' && !Pairing::isHttpUrl($ep)) {
			throw new \RuntimeException('"ElasticPro URL" must be an http(s) URL');
		}
		if ($ep === '' && !$file_has_urls) {
			throw new \RuntimeException('enter the ElasticPro URL');
		}

		$secret = trim((string) $this->getInput('secret', ''));
		if ($secret !== '' && strlen($secret) < 32) {
			throw new \RuntimeException('the secret must be at least 32 characters (the same value as ELASTICPRO_ZABBIX_SSO_SECRET on the core)');
		}
		$sealed = $secret !== '' ? Settings::seal($secret) : (string) ($old['secret'] ?? '');
		if ($sealed === '' && !$s['from_file']['secret']) {
			throw new \RuntimeException('enter the secret — nothing is stored yet');
		}

		Settings::saveDbConfig([
			'epUrl' => $ep,
			'secret' => $sealed,
			'verifyTls' => $this->getInput('verify_tls', '0') === '1',
			'pairedAt' => time(),
			'pairedBy' => $this->by(),
			'mode' => 'manual',
		] + array_intersect_key($old, array_flip(['tokenId', 'zabbixUrl'])));

		CMessageHelper::setSuccessTitle(_('ElasticPro settings saved'));
		$this->fileNote();
	}

	private function test(): void {
		$s = Settings::resolve();
		if ($s['core_url'] === '' || $s['public_url'] === '') {
			throw new \RuntimeException('nothing to test: the module has no ElasticPro URL yet — pair, or enter it below');
		}
		$lines = [];
		$ok = true;

		// Reachable, and (when verify is on) with a certificate this server trusts.
		$g = SsoClient::get($s['public_url'].'/', $s['verify_tls']);
		if ($g['status'] === 0) {
			$ok = false;
			$lines[] = _s('%1$s: not reachable from the Zabbix server — %2$s', $s['public_url'], $g['error']);
		}
		else {
			$lines[] = _s('%1$s: answered HTTP %2$s%3$s', $s['public_url'], $g['status'],
				$s['verify_tls'] ? ', certificate trusted' : ', certificate NOT checked (verify TLS is off)');
			$ok = $ok && $g['status'] < 500;
		}

		// A signed probe. The body is deliberately not a sign-in request, so the core checks the
		// signature, then refuses the body (400 bad_request) — nobody is signed in or created.
		if (strlen($s['secret']) < 32) {
			$ok = false;
			$lines[] = $s['secret_unreadable']
				? _('The stored secret no longer opens (Zabbix\'s session key changed?) — pair again.')
				: _('No secret is set — pair, or enter it below.');
		}
		else {
			$body = json_encode(['probe' => true, 'ts' => time(), 'nonce' => bin2hex(random_bytes(16))],
				JSON_UNESCAPED_SLASHES
			);
			$p = SsoClient::postSigned($s['core_url'].'/sso/zabbix', $s['secret'], (string) $body, $s['verify_tls']);
			$kind = (string) ($p['data']['kind'] ?? '');
			if ($p['status'] === 0) {
				$ok = false;
				$lines[] = _s('Signed check: %1$s/sso/zabbix not reachable — %2$s', $s['core_url'], $p['error']);
			}
			elseif ($p['status'] === 400 && $kind === 'bad_request') {
				$lines[] = _('Signed check: ElasticPro accepted the signature — the secret matches.');
			}
			else {
				$ok = false;
				$why = [
					'bad_signature' => _('the secret does not match the one ElasticPro holds — pair again'),
					'stale' => _('the clocks of this server and ElasticPro differ by more than 60 s'),
					'not_configured' => _('ElasticPro has no Zabbix secret set — pair from its Config → Zabbix'),
				][$kind] ?? ($p['status'] === 404
					? _('ElasticPro does not answer /sso/zabbix at this address (nginx refuses /sso/ from outside?)')
					: _s('unexpected answer HTTP %1$s %2$s', $p['status'], $kind));
				$lines[] = _s('Signed check: %1$s', $why);
			}
		}

		if ($ok) {
			CMessageHelper::setSuccessTitle(_('ElasticPro connection works'));
			foreach ($lines as $l) {
				CMessageHelper::addSuccess($l);
			}
		}
		else {
			CMessageHelper::setErrorTitle(_('ElasticPro connection test failed'));
			foreach ($lines as $l) {
				CMessageHelper::addError($l);
			}
		}
	}

	private function unpair(): void {
		$old = Settings::dbConfig();
		$tokenid = (string) ($old['tokenId'] ?? '');
		$gone = Pairing::deleteToken($tokenid);
		// Keep where ElasticPro is, so a later pairing or manual entry starts from it.
		Settings::saveDbConfig(array_intersect_key($old, array_flip(['epUrl', 'verifyTls'])));

		CMessageHelper::setSuccessTitle(_('Unpaired: the secret stored here was removed'));
		if ($tokenid !== '') {
			if ($gone) {
				CMessageHelper::addSuccess(_('The API token the pairing made was deleted.'));
			}
			else {
				CMessageHelper::addWarning(_s('The pairing\'s API token (id %1$s) could not be deleted; remove it under Users → API tokens.', $tokenid));
			}
		}
		CMessageHelper::addWarning(_('Also unpair in ElasticPro (Config → Zabbix → Unpair), so it stops accepting the old secret.'));
		$this->fileNote();
	}
}
