<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseData;
use Modules\EpClients\Lib\{History, Lifecycle, Reconciler, Registry, Roles};

/** The form: empty for a new client, filled for one that exists or a cluster host being taken on. */
class ClientEdit extends Base {

	protected const READ_ONLY_OK = true;

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'string', 'clone' => 'string']);
	}

	protected function doAction(): void {
		$from = trim((string) $this->getInput('clone', ''));
		if ($from !== '') {
			$source = $this->state()->formFor($from);
			if (($source['_now']['master'] ?? null) === null) {
				$this->toList(_('Nothing to clone'), [], true, _s('Client "%1$s" was not found.', $from));
				return;
			}
			$this->setResponse(self::page($this, $this->spec()->cloneOf($source), 'add', [], false, [], $from));
			return;
		}
		$name = trim((string) $this->getInput('client', ''));
		$form = $name === '' ? $this->spec()->defaults() : $this->state()->formFor($name);
		$now = $form['_now'] ?? null;
		$this->setResponse(self::page($this, $form, $now === null || $now['master'] === null ? 'add' : 'edit', [],
			$now !== null && $now['master'] === null && ($now['cluster'] !== null || $now['machines'])));
	}

	public static function page(Base $c, array $form, string $mode, array $errors, bool $adopting = false, array $done = [], string $clonedFrom = ''): CControllerResponseData {
		$now = $form['_now'] ?? null;
		$roles = $c->rolesFor();
		$byId = Roles::byId($roles);
		$names = [];
		$existing = [];
		if ($now !== null) {
			foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
				$existing[] = ['name' => $h['name'], 'managed' => Reconciler::isManaged($h), 'ip' => $h['_ip'] ?? null,
					'role' => implode(' + ', array_map(fn($rid) => $byId[$rid]['label'] ?? $rid, $h['_roles'] ?? []))];
				if (($h['_ip'] ?? null) !== null) {
					$names[$h['_ip']] = $h['name'];
				}
			}
		}
		$status = 'active';
		$maintenance = null;
		$removed = [];
		$changed = [];
		if ($now !== null && $now['master'] !== null) {
			$status = Lifecycle::statusOf((new Reconciler($c->specFor()))->macros($now['master']['hostid']));
			$maintenance = Lifecycle::maintenances([$form['name']])[$form['name']] ?? null;
			$diff = $c->canWrite() ? Registry::compare($form['name'], $now, $c->existingHosts()) : ['removed' => [], 'changed' => []];
			$removed = array_values($diff['removed']);
			$changed = array_values($diff['changed']);
		}
		$proxies = array_column(API::Proxy()->get(['output' => ['name'], 'sortfield' => 'name']) ?: [], 'name');
		$groups = array_column(API::ProxyGroup()->get(['output' => ['name'], 'sortfield' => 'name']) ?: [], 'name');
		$response = new CControllerResponseData([
			'form' => array_filter($form, fn($k) => $k[0] !== '_', ARRAY_FILTER_USE_KEY),
			'roles' => $roles,
			'mode' => $mode,
			'adopting' => $adopting,
			'existing' => $existing,
			'host_names' => $names,
			'unassigned' => $form['_unassigned'] ?? [],
			'shared' => $form['_shared'] ?? [],
			'deletes' => $form['_deletes'] ?? null,
			'current' => (array) json_decode((string) ($form['_current_servers'] ?? ($mode === 'edit' ? $form['servers'] : '[]')), true),
			'merge' => array_filter(explode(',', (string) ($form['merge'] ?? ''))),
			'has_cluster' => $now !== null && $now['cluster'] !== null,
			'proxies' => $proxies,
			'status' => $status,
			'maintenance' => $maintenance,
			'removed' => $removed,
			'changed' => $changed,
			'history' => $mode === 'edit' ? History::of($form['name'], 30) : [],
			'proxy_groups' => $groups,
			'errors' => $errors,
			'cloned_from' => $clonedFrom,
			'can_write' => $c->canWrite(),
			'done' => $done
		]);
		$response->setTitle($mode === 'add' ? _('Add client') : _s('Client %1$s', $form['name']));
		return $response;
	}
}
