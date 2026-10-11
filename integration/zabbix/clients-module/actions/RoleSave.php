<?php declare(strict_types = 0);

namespace Modules\EpClients\Actions;

use API;
use CControllerResponseRedirect;
use CMessageHelper;
use CUrl;
use Exception;
use Modules\EpClients\Lib\{Roles, TemplateInstaller, TemplateMap};

/**
 * Add, change, move or remove a family or a role. After a backup, the roles are saved and the
 * master template is rewritten, so the change reaches every client's figures and the reports.
 * A role or family that still has machines cannot be removed.
 */
class RoleSave extends Base {

	protected function checkInput(): bool {
		return $this->validateInput([
			'op' => 'required|in add_family,add_role,edit_family,edit_role,remove,up,down,set_templates',
			'id' => 'string', 'family' => 'string', 'label' => 'string', 'short' => 'string', 'group' => 'string', 'macroPrefix' => 'string',
			'templates' => 'array', 'templates_keep' => 'string'
		] + self::templateFields());
	}

	/**
	 * One group of fields per Roles::TEMPLATE_SLOTS key: the chosen name from the select, the
	 * extra names as template ids from the picker, and the ids' keep-list — names this Zabbix
	 * has not got, which the picker cannot carry and a save must not drop.
	 */
	private static function templateFields(): array {
		$out = [];
		foreach (array_keys(Roles::TEMPLATE_SLOTS) as $slot) {
			$out[$slot.'_template'] = 'string';
			$out[$slot.'_also'] = 'array';
			$out[$slot.'_also_keep'] = 'string';
		}
		return $out;
	}

	/**
	 * The template names a picker and its keep-list stand for: the ids resolved to today's
	 * names, plus the stored names this Zabbix has not got, each once.
	 */
	private function picked(string $field): array {
		$names = array_merge(
			TemplateMap::namesOf((array) $this->getInput($field, [])),
			Roles::splitNames((string) $this->getInput($field.'_keep', ''))
		);
		return array_values(array_unique(array_filter($names, fn($n) => trim($n) !== '')));
	}

	protected function doAction(): void {
		$roles = $this->roles();
		$op = $this->getInput('op');
		$id = trim((string) $this->getInput('id', ''));
		$in = fn($k) => trim((string) $this->getInput($k, ''));
		// Template names are a setting, not part of the roles: changing one rewrites nothing, so
		// it skips the backup-and-reinstall below.
		if ($op === 'set_templates') {
			try {
				$map = [];
				foreach (array_keys(Roles::TEMPLATE_SLOTS) as $slot) {
					// The select offers the shipped name as its first option; storing it would
					// pin the slot to today's spelling, so it is stored as "unmapped" instead.
					$chosen = $in($slot.'_template');
					$map[$slot] = $chosen === (Roles::TEMPLATE_SLOTS[$slot][0] ?? '') ? '' : $chosen;
					$map[$slot.'_also'] = implode("\n", $this->picked($slot.'_also'));
				}
				Roles::saveTemplateNames($map);
				CMessageHelper::setSuccessTitle(_('Template mapping saved'));
			}
			catch (Exception $e) {
				CMessageHelper::setErrorTitle(_('Template mapping not changed'));
				CMessageHelper::addError($e->getMessage());
			}
			$this->setResponse(new CControllerResponseRedirect((new CUrl('zabbix.php'))->setArgument('action', 'ep.clients.roles')));
			return;
		}
		// Templates, comma-separated; none means the Linux agent template named in the settings.
		// Chosen in the picker, never typed; the same template may be picked for several roles,
		// and Roles::templatesOf() already returns each one once per server.
		$templates = $this->picked('templates');
		try {
			switch ($op) {
				case 'add_family':
					$roles['families'][] = ['id' => $in('id'), 'label' => $in('label'), 'group' => $in('group'), 'macroPrefix' => strtoupper($in('macroPrefix')),
						'memAlias' => '', 'order' => Roles::RESOURCES,
						'roles' => [['id' => $in('id').'_node', 'label' => $in('label'), 'short' => $in('short') ?: $in('label'), 'group' => $in('group'), 'templates' => $templates]]];
					$what = _s('Family "%1$s" added', $in('label'));
					break;
				case 'add_role':
					foreach ($roles['families'] as &$f) {
						if ($f['id'] === $in('family')) {
							$f['roles'][] = ['id' => $in('id'), 'label' => $in('label'), 'short' => $in('short'), 'group' => $in('group'), 'templates' => $templates];
						}
					}
					unset($f);
					$what = _s('Role "%1$s" added', $in('label'));
					break;
				case 'edit_family':
				case 'edit_role':
					foreach ($roles['families'] as &$f) {
						if ($op === 'edit_family' && $f['id'] === $id) {
							$f['label'] = $in('label');
							$f['group'] = $in('group');
						}
						foreach ($f['roles'] as &$r) {
							if ($op === 'edit_role' && $r['id'] === $id) {
								$r['label'] = $in('label');
								$r['short'] = $in('short');
								$r['group'] = $in('group');
								$r['templates'] = $templates;
							}
						}
						unset($r);
					}
					unset($f);
					$what = _('Saved');
					break;
				case 'remove':
					$this->refuseIfUsed($roles, $id);
					$roles['families'] = array_values(array_filter(array_map(function($f) use ($id) {
						if ($f['id'] === $id) {
							return null;
						}
						$f['roles'] = array_values(array_filter($f['roles'], fn($r) => $r['id'] !== $id));
						return $f;
					}, $roles['families'])));
					$what = _('Removed');
					break;
				default:
					$roles = $this->move($roles, $id, $op === 'up' ? -1 : 1);
					$what = _('Moved');
			}
			$errors = Roles::validate($roles);
			if ($errors) {
				throw new Exception(implode(' ', $errors));
			}
			$this->backup('Roles: '.$what);
			Roles::save($roles);
			TemplateInstaller::install($roles);
			CMessageHelper::setSuccessTitle($what);
			CMessageHelper::addSuccess(_('The master template was rewritten; new figures show their first values within about ten minutes.'));
		}
		catch (Exception $e) {
			CMessageHelper::setErrorTitle(_('Roles not changed'));
			CMessageHelper::addError($e->getMessage());
		}
		$this->setResponse(new CControllerResponseRedirect((new CUrl('zabbix.php'))->setArgument('action', 'ep.clients.roles')));
	}

	private function refuseIfUsed(array $roles, string $id): void {
		foreach ($roles['families'] as $f) {
			$groups = $f['id'] === $id ? array_merge([$f['group']], array_column($f['roles'], 'group')) : [];
			foreach ($f['roles'] as $r) {
				if ($r['id'] === $id) {
					$groups = [$r['group']];
				}
			}
			foreach ($groups as $g) {
				$found = API::HostGroup()->get(['output' => ['groupid'], 'filter' => ['name' => $g], 'selectHosts' => API_OUTPUT_COUNT]);
				if ($found && (int) $found[0]['hosts'] > 0 && !($f['id'] !== $id && $g === $f['group'])) {
					throw new Exception(_s('"%1$s" still has %2$s machine(s) in host group "%3$s". Move them to another role first.', $id, $found[0]['hosts'], $g));
				}
			}
		}
	}

	private function move(array $roles, string $id, int $by): array {
		$swap = function(array $list) use ($id, $by) {
			$i = array_search($id, array_column($list, 'id'), true);
			if ($i === false || !isset($list[$i + $by])) {
				return $list;
			}
			[$list[$i], $list[$i + $by]] = [$list[$i + $by], $list[$i]];
			return $list;
		};
		$roles['families'] = $swap($roles['families']);
		foreach ($roles['families'] as &$f) {
			$f['roles'] = $swap($f['roles']);
		}
		unset($f);
		return $roles;
	}
}
