<?php declare(strict_types = 1);

namespace Modules\ElasticPro\Actions;

require_once __DIR__.'/../lib/SsoClient.php';

use API;
use CController;
use CControllerResponseData;
use CControllerResponseRedirect;
use CUrl;
use CWebUser;
use Modules\ElasticPro\Lib\SsoClient;
use Modules\ElasticPro\Module;

/**
 * One controller for every ElasticPro page. The action name says which page:
 * `elasticpro.indices` opens the app at `#/indices`.
 *
 * Each page load mints its own code. Codes are single-use and cheap, and a page that
 * carried a long-lived session in its HTML would be a session anyone with the page
 * source could reuse.
 */
class View extends CController {

	protected function init(): void {
		// GET only, and nothing here changes state in Zabbix. The one side effect — an
		// account created or refreshed in ElasticPro — is that app's to guard, and it
		// does, with the signature.
		$this->disableCsrfValidation();
	}

	/**
	 * Only the troubleshoot action takes input: what a Zabbix problem says about itself,
	 * filled in by the "Troubleshoot in ElasticPro" script. All of it is passed to the
	 * app as text, which treats it as a hint — the cluster is still one this user can see,
	 * or none.
	 */
	protected function checkInput(): bool {
		return $this->validateInput([
			'zbx_host' => 'string',
			'client' => 'string',
			'rule' => 'string',
			'problem' => 'string',
		]);
	}

	/** The troubleshoot request, trimmed to what a URL should carry. */
	private function trouble(): array {
		if ($this->getAction() !== 'elasticpro.troubleshoot') {
			return [];
		}
		$out = [];
		foreach (['zbx_host', 'client', 'rule', 'problem'] as $k) {
			$v = trim((string) $this->getInput($k, ''));
			if ($v !== '') {
				$out[$k] = mb_substr($v, 0, 255);
			}
		}
		return $out;
	}

	private function page(): string {
		$page = substr($this->getAction(), strlen('elasticpro.'));
		return array_key_exists($page, Module::PAGES) || array_key_exists($page, Module::ADMIN_PAGES)
			? $page : 'overview';
	}

	protected function checkPermissions(): bool {
		// Guests have no ElasticPro role at all.
		if ($this->getUserType() < USER_TYPE_ZABBIX_USER) {
			return false;
		}
		if (array_key_exists($this->page(), Module::ADMIN_PAGES)) {
			return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
		}
		return true;
	}

	/**
	 * The names of the user groups this user is in.
	 *
	 * Read from the database rather than through the API: `usergroup.get` answers
	 * differently by user type, and this list decides which clusters a Zabbix User sees,
	 * so it must not depend on who is asking.
	 */
	private function groups(): array {
		$names = [];
		$rows = DBselect(
			'SELECT g.name FROM usrgrp g JOIN users_groups ug ON ug.usrgrpid=g.usrgrpid'.
			' WHERE ug.userid='.zbx_dbstr(CWebUser::$data['userid'])
		);
		while ($row = DBfetch($rows)) {
			$names[] = $row['name'];
		}
		sort($names);
		return $names;
	}

	private function theme(): string {
		return function_exists('getUserTheme')
			? (string) getUserTheme(CWebUser::$data)
			: (string) (CWebUser::$data['theme'] ?? '');
	}

	/**
	 * Alerts are Zabbix problems. The Alerts menu item opens Problems filtered to the host
	 * groups this module's hosts live in — clusters and the forwarder, parser and node
	 * roles — rather than a second list inside the app.
	 */
	private function problemsUrl(): CUrl {
		$groups = API::HostGroup()->get([
			'output' => ['groupid'],
			'filter' => ['name' => ['Elasticsearch clusters', 'Forwarders', 'Parsers', 'ESNodes', 'Engines']],
		]);
		$url = (new CUrl('zabbix.php'))
			->setArgument('action', 'problem.view')
			->setArgument('filter_set', '1');
		if ($groups) {
			$url->setArgument('groupids', array_column($groups, 'groupid'));
		}
		return $url;
	}

	protected function doAction(): void {
		if ($this->page() === 'alerts') {
			$this->setResponse(new CControllerResponseRedirect($this->problemsUrl()));
			return;
		}
		$sso = new SsoClient();
		$page = $this->page();
		$url = null;
		$error = '';

		if ($sso->isConfigured()) {
			$code = $sso->mintCode((string) CWebUser::$data['username'], (int) $this->getUserType(), $this->groups());
			if ($code !== null) {
				$url = $sso->frameUrl($code, $page, $this->theme(), $this->trouble());
			}
			else {
				$error = $sso->lastError();
			}
		}

		$labels = Module::PAGES + Module::ADMIN_PAGES;
		$response = new CControllerResponseData([
			'configured' => $sso->isConfigured(),
			'frame_url' => $url,
			'public_url' => $sso->publicUrl(),
			'error' => $error,
		]);
		$response->setTitle('ElasticPro — '.($this->trouble() ? 'Troubleshoot' : $labels[$page]));
		$this->setResponse($response);
	}
}
