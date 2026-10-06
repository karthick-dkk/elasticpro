<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

foreach (['Store', 'Roles', 'ColumnSettings', 'Forecast', 'ClientTypes', 'MasterTemplate', 'DevicesTemplate', 'JumpTemplate', 'ClientSpec', 'Reconciler', 'Lifecycle', 'Registry', 'History', 'ClientState', 'Csv', 'Backups', 'TemplateInstaller', 'Importer', 'AlertRouting'] as $lib) {
	require_once __DIR__.'/../lib/'.$lib.'.php';
}

use API;
use Exception;
use CController;
use CControllerResponseRedirect;
use CMessageHelper;
use CUrl;
use CWebUser;
use Modules\EpClients\Lib\{AlertRouting, Backups, ClientSpec, ClientState, History, Importer, Lifecycle, Reconciler, Registry, Roles, Store};

/** What every Clients page shares: Super admins only; roles, rules and Zabbix state; backups. */
abstract class Base extends CController {

	private $roles_cache;
	/** @var string|null the backup taken before this request's change */
	private $lastBackup = null;

	/** Pages that only show (the list, a client's page) are open to Zabbix Admins too, read-only. */
	protected const READ_ONLY_OK = false;

	protected function checkPermissions(): bool {
		return $this->canWrite() || (static::READ_ONLY_OK && $this->getUserType() == USER_TYPE_ZABBIX_ADMIN);
	}

	/** Only Super admins change clients. */
	public function canWrite(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	/** hostid => visible name, for the recorded hosts Zabbix still has. */
	public function existingHosts(): array {
		$ids = Registry::hostIds();
		return $ids ? array_column(API::Host()->get(['output' => ['hostid', 'name'], 'hostids' => $ids]) ?: [], 'name', 'hostid') : [];
	}

	protected function roles(): array {
		return $this->roles_cache ?? ($this->roles_cache = Roles::load());
	}

	/** The roles, for a view. */
	public function rolesFor(): array {
		return $this->roles();
	}

	/** The form rules, for a view. */
	public function specFor(): ClientSpec {
		return $this->spec();
	}

	protected function spec(): ClientSpec {
		return new ClientSpec($this->roles());
	}

	protected function rec(): Reconciler {
		return new Reconciler($this->spec());
	}

	protected function state(?Reconciler $rec = null): ClientState {
		return new ClientState($this->spec(), $rec ?? $this->rec());
	}

	protected function importer(): Importer {
		return new Importer($this->spec(), $this->state());
	}

	protected function user(): string {
		return (string) (CWebUser::$data['username'] ?? '?');
	}

	/** A copy of everything, before a change. Refuses the change when it cannot be taken. */
	protected function backup(string $before): string {
		return $this->lastBackup = Backups::take($before, $this->user(), $this->state(), $this->roles());
	}

	protected function lifecycle(): Lifecycle {
		return new Lifecycle($this->rec());
	}

	/** Remember the client as it is now in Zabbix, for noticing hosts deleted behind the page's back. */
	protected function register(string $client): void {
		$form = $this->state()->formFor($client);
		if ($form['_now']['master'] !== null) {
			Registry::record($client, ClientState::plain($form), $form['_now']);
		}
	}

	/** Who last changed a client, and how — shown on the list. */
	protected function noteChange(string $client, string $how): void {
		$log = Store::read('changes.json', []);
		$log[$client] = ['at' => time(), 'how' => $how, 'by' => $this->user()];
		Store::write('changes.json', $log);
		History::add($client, $how, $this->user(), $this->lastBackup);
		// The register follows every change: forgotten when the client is gone, refreshed otherwise.
		$gone = in_array($how, ['removed', 'removed by restore', 'deleted for good'], true);
		if ($gone) {
			Registry::forget($client);
		}
		else {
			$this->register($client);
		}
		// Problems by email to the cluster DL follow the client too: set up, changed or removed.
		try {
			$now = $gone ? null : $this->rec()->current($client);
			$this->routed = array_merge($this->routed, AlertRouting::sync($client, $now['groupid'] ?? null,
				($now['master'] ?? null) !== null ? $this->rec()->macros($now['master']['hostid']) : [], (string) (CWebUser::$data['userid'] ?? '')));
		}
		catch (Exception $e) {
			$this->routed[] = _s('Alert routing: %1$s', $e->getMessage());
		}
	}

	/** What the DL alert routing did on this request's changes, for the notice. */
	private array $routed = [];

	protected function toList(string $title, array $lines = [], bool $error = false, ?string $detail = null): void {
		$lines = array_merge($lines, array_values(array_unique($this->routed)));
		$error ? CMessageHelper::setErrorTitle($title) : CMessageHelper::setSuccessTitle($title);
		if ($detail !== null) {
			$error ? CMessageHelper::addError($detail) : CMessageHelper::addSuccess($detail);
		}
		foreach ($lines as $line) {
			CMessageHelper::addSuccess($line);
		}
		$this->setResponse(new CControllerResponseRedirect((new CUrl('zabbix.php'))->setArgument('action', 'ep.clients.list')));
	}
}
