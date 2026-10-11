<?php
/**
 * The Clients module's pure parts: roles, the client form's rules and macros, servers and their
 * names, the two CSV files, backups from older versions, report column settings, and the
 * templates it writes.
 *   docker run --rm -v "$PWD":/m -w /m php:8.4-cli-alpine php test/spec.test.php
 * Exit 0 when every check holds; each failure is printed. A PHP warning is a failure.
 */
namespace {
	define('ZBX_MACRO_TYPE_TEXT', 0); define('ZBX_MACRO_TYPE_SECRET', 1); define('ZBX_MACRO_TYPE_VAULT', 2);
	foreach (['GROUP_GUI_ACCESS_DISABLED' => 3, 'PERM_READ' => 2, 'MEDIA_STATUS_ACTIVE' => 0, 'EVENT_SOURCE_TRIGGERS' => 0, 'ACTION_STATUS_ENABLED' => 0,
		'ACTION_PAUSE_SUPPRESSED_TRUE' => 1, 'CONDITION_EVAL_TYPE_AND_OR' => 0, 'ZBX_CONDITION_TYPE_HOST_GROUP' => 0, 'CONDITION_OPERATOR_EQUAL' => 0,
		'OPERATION_TYPE_RECOVERY_MESSAGE' => 11, 'ZBX_REPORT_PERIOD_WEEK' => 1, 'ZBX_REPORT_CYCLE_WEEKLY' => 1, 'ZBX_REPORT_STATUS_ENABLED' => 0,
		'ZBX_WIDGET_FIELD_TYPE_GROUP' => 2] as $k => $v) { define($k, $v); }
	define('ZBX_MONITORED_BY_SERVER', 0); define('ZBX_MONITORED_BY_PROXY', 1); define('ZBX_MONITORED_BY_PROXY_GROUP', 2);
	set_error_handler(function ($no, $msg, $file, $line) { throw new \ErrorException($msg, 0, $no, $file, $line); });
	function _($s) { return $s; }
	function _s($s, ...$a) { foreach ($a as $i => $v) { $s = str_replace('%'.($i + 1).'$s', (string) $v, $s); } return $s; }
	function _n($a, $b, $n) { return str_replace('%1$s', (string) $n, $n == 1 ? $a : $b); }
}
namespace Modules\EpClients\Test {
	foreach (['Store', 'Roles', 'ColumnSettings', 'Forecast', 'ClientTypes', 'MasterTemplate', 'DevicesTemplate', 'JumpTemplate', 'ClusterTemplate', 'ClientSpec', 'Csv', 'Backups', 'Reconciler', 'Lifecycle', 'Registry', 'History', 'SetupChecks', 'AlertRouting'] as $lib) {
		require __DIR__.'/../lib/'.$lib.'.php';
	}
	use Modules\EpClients\Lib\{AlertRouting, Backups, ClientSpec, ClusterTemplate, ColumnSettings, Csv, DevicesTemplate, Forecast, History, JumpTemplate, Lifecycle, MasterTemplate, Reconciler, Registry, Roles, SetupChecks, Store};

	$failed = 0; $passed = 0;
	function check(string $what, bool $ok, $detail = null): void {
		global $failed, $passed;
		if ($ok) { $passed++; return; }
		$failed++; echo "FAIL: $what", $detail !== null ? ' — '.json_encode($detail, JSON_UNESCAPED_SLASHES) : '', PHP_EOL;
	}
	$dir = sys_get_temp_dir().'/ep-test-'.getmypid();
	mkdir($dir);
	putenv('EP_DATA_DIR='.$dir);

	/* ---------------- data folder ---------------- */
	putenv('EP_DATA_DIR='.$dir.'/fresh');
	check('a missing data folder is made on first use', Store::writable() && is_dir($dir.'/fresh'));
	rmdir($dir.'/fresh');
	putenv('EP_DATA_DIR='.$dir);

	/* ---------------- roles ---------------- */
	$roles = Roles::defaults();
	check('the default roles are valid', Roles::validate($roles) === [], Roles::validate($roles));
	check('families: ES, Parser, Forwarder, Engine, Single node', array_column($roles['families'], 'label') === ['ES', 'Parser', 'Forwarder', 'Engine', 'Single node']);
	check('ES roles: data, hot, warm, coordination, master', array_column($roles['families'][0]['roles'], 'short') === ['ES-Data', 'ES-Data-Hot', 'ES-Data-Warm', 'ES-Coord', 'ES-Master']);
	check('Engine roles: Engine, UEBA, AIML', array_column($roles['families'][3]['roles'], 'short') === ['Engine', 'UEBA', 'AIML']);
	$byId = Roles::byId($roles);
	check('Single node counts in ES, Parser, Forwarder and Engine', Roles::familiesOf($byId['single_node']) === ['single', 'es', 'parser', 'fwd', 'engine']);
	$bad = $roles; $bad['families'][0]['roles'][] = ['id' => 'aiml', 'label' => 'X', 'short' => 'X', 'group' => 'X'];
	check('an id used twice is refused', (bool) preg_grep('/used twice/', Roles::validate($bad)));
	$bad = $roles; $bad['families'][1]['roles'][0]['short'] = 'ES-Master';
	check('two roles with the same host-name part are refused', (bool) preg_grep('/called "ES-Master"/', Roles::validate($bad)));
	$bad = $roles; $bad['families'][0]['id'] = 'delay';
	check('a reserved id is refused', (bool) preg_grep('/reserved/', Roles::validate($bad)));
	$bad = $roles; $bad['families'][4]['roles'][0]['alsoIn'][] = 'nope';
	check('counting in a family that does not exist is refused', (bool) preg_grep('/does not exist/', Roles::validate($bad)));
	Roles::save($roles);
	check('roles are kept in the data folder', Roles::load() === $roles && is_file($dir.'/roles.json'));
	check('every configured group is known', in_array('ES Data Hot', Roles::groups($roles), true) && in_array('ESNodes', Roles::groups($roles), true));

	// Roles an older version saved: the new ones are put in, nothing there is changed.
	$v1 = $roles; $v1['version'] = 1;
	$v1['families'][0]['roles'] = array_values(array_filter($v1['families'][0]['roles'], fn($r) => $r['id'] !== 'es_data'));
	$v1['families'][3]['roles'] = array_values(array_filter($v1['families'][3]['roles'], fn($r) => $r['id'] !== 'engine'));
	array_pop($v1['families']);
	$v1['families'][1]['roles'][0]['label'] = 'Log parser';
	$up = Roles::upgrade($v1);
	check('upgrade adds ES Data, Engine and Single node', isset(Roles::byId($up)['es_data'], Roles::byId($up)['engine'], Roles::byId($up)['single_node']));
	check('upgrade keeps what was changed', Roles::byId($up)['parser']['label'] === 'Log parser' && $up['version'] === 2);
	check('ES Data goes first in ES, as in the defaults', $up['families'][0]['roles'][0]['id'] === 'es_data');
	$clash = $v1; $clash['families'][1]['roles'][] = ['id' => 'mine', 'label' => 'Mine', 'short' => 'Engine', 'group' => 'Mine'];
	check('an upgrade that would clash leaves the roles as they were', Roles::upgrade($clash) === $clash);

	// Which roles a host holds, from its groups.
	$of = fn(array $g) => array_column(Roles::rolesOfGroups($roles, $g), 'id');
	check('a host in two role groups holds both roles', $of(['karthi', 'ESNodes', 'ES Data Hot', 'ES Coordination']) === ['es_data_hot', 'es_coord']);
	check('Forwarder is read from its family group', $of(['karthi', 'Forwarders']) === ['forwarder']);
	check('a Single node in Forwarders is not also a Forwarder', $of(['karthi', 'Single node', 'ESNodes', 'Parsers', 'Forwarders', 'Engines']) === ['single_node']);
	check('a family group alone is no role', $of(['karthi', 'ESNodes']) === []);
	check('a server joins every family its roles count in', Roles::familyGroupsOf($roles, ['single_node']) === ['Single node', 'ESNodes', 'Parsers', 'Forwarders', 'Engines']
		&& Roles::familyGroupsOf($roles, ['es_data', 'parser']) === ['ESNodes', 'Parsers']);

	/* ---------------- templates per role ---------------- */
	check('a role with no templates gets the default', Roles::templatesOf($roles, ['parser']) === [Roles::DEFAULT_TEMPLATE]);
	$withT = $roles; $withT['families'][3]['roles'][0]['templates'] = ['Engine by HTTP'];
	check('a role\'s own templates, and every role\'s once', Roles::templatesOf($withT, ['engine', 'parser', 'aiml']) === ['Engine by HTTP', Roles::DEFAULT_TEMPLATE]
		&& Roles::validate($withT) === []);
	check('blank template names count as none', Roles::roleTemplates(['templates' => [' ', '']]) === [Roles::DEFAULT_TEMPLATE]);
	$badT = $roles; $badT['families'][3]['roles'][0]['templates'] = [str_repeat('x', 200)];
	check('a template name too long is refused', (bool) preg_grep('/template name/', Roles::validate($badT)));

	// A Zabbix that calls the templates something else is pointed at them in templates.json,
	// not in PHP.
	$shipped = array_map(fn($slot) => $slot[0], Roles::TEMPLATE_SLOTS);
	check('every slot defaults to the name ElasticPro ships', Roles::templateNames() === $shipped
		&& Roles::defaultTemplate() === Roles::DEFAULT_TEMPLATE && Roles::clusterTemplate() === Roles::DEFAULT_CLUSTER_TEMPLATE, Roles::templateNames());
	check('the slot table covers every template the page writes or looks for',
		array_keys(Roles::TEMPLATE_SLOTS) === ['cluster', 'agent', 'master', 'devices', 'jump', 'jump_ulm', 'ulm', 'plan', 'alerts', 'delay']);
	check('no slot starts out mapped', Roles::templateAliases() === array_map(fn($x) => [], Roles::TEMPLATE_SLOTS));
	Roles::saveTemplateNames(['agent' => 'Linux by Zabbix agent -ACME', 'cluster' => '']);
	check('a name set in the settings is used', Roles::defaultTemplate() === 'Linux by Zabbix agent -ACME' && is_file($dir.'/templates.json'));
	check('one left empty keeps its default', Roles::clusterTemplate() === Roles::DEFAULT_CLUSTER_TEMPLATE);
	check('a role with no templates gets the one that is set', Roles::templatesOf($roles, ['parser']) === ['Linux by Zabbix agent -ACME']);
	check('the cluster host is linked to the one that is set', Reconciler::clusterTemplates()[0] === Roles::clusterTemplate()
		&& Reconciler::agentTemplate() === 'Linux by Zabbix agent -ACME');
	$long = false;
	try { Roles::saveTemplateNames(['agent' => str_repeat('x', 200)]); } catch (\InvalidArgumentException $e) { $long = true; }
	check('a template name too long is refused here too', $long);
	Roles::saveTemplateNames([]);
	check('clearing every row brings the shipped names back', Roles::templateNames() === $shipped);

	// The mapping's point: a template this Zabbix calls something else is found under that name,
	// and the readers that recognise a host follow the mapping rather than a name in PHP.
	Roles::saveTemplateNames(['master' => 'ACME client master', 'cluster' => 'ACME ES cluster',
		'cluster_also' => "Elasticsearch Cluster by HTTP OLD\nElasticsearch Cluster by HTTP OLD\n , ",
		'plan' => 'ACME plan']);
	check('a mapped name is the one that gets written and linked', MasterTemplate::name() === 'ACME client master'
		&& ClusterTemplate::name() === 'ACME ES cluster' && Roles::templateName('plan') === 'ACME plan');
	check('an unmapped slot keeps its shipped name', DevicesTemplate::name() === Roles::TEMPLATE_SLOTS['devices'][0]);
	check('extra names are de-duplicated and the blanks dropped',
		Roles::templateAliases()['cluster'] === ['Elasticsearch Cluster by HTTP OLD']);
	check('recognition takes the mapped name, the extra names, the shipped one and the legacy one',
		Reconciler::esClusterTemplates() === ['ACME ES cluster', 'Elasticsearch Cluster by HTTP OLD',
			Roles::TEMPLATE_SLOTS['cluster'][0], Reconciler::LEGACY_CLUSTER_TEMPLATE], Reconciler::esClusterTemplates());
	check('the master template is recognised by the mapped name and both old spellings',
		Reconciler::masterTemplates() === array_merge(['ACME client master', Roles::TEMPLATE_SLOTS['master'][0]],
			Reconciler::LEGACY_MASTER_TEMPLATES), Reconciler::masterTemplates());
	check('the templates linked to a cluster host follow the mapping',
		Reconciler::clusterTemplates() === ['ACME ES cluster', 'ACME plan', Roles::TEMPLATE_SLOTS['alerts'][0],
			Roles::TEMPLATE_SLOTS['delay'][0], Roles::TEMPLATE_SLOTS['devices'][0]], Reconciler::clusterTemplates());
	check('a writer never uses an extra name', !in_array('Elasticsearch Cluster by HTTP OLD',
		[MasterTemplate::name(), ClusterTemplate::name(), DevicesTemplate::name(), JumpTemplate::name(), JumpTemplate::ulmName()], true));
	// Zabbix keeps hosts and templates in one namespace where a name is unique, so two slots
	// mapped to one name could never both be written; it is refused here, not at install time.
	$clash = false;
	try { Roles::saveTemplateNames(['master' => 'Same', 'devices' => 'Same']); }
	catch (\InvalidArgumentException $e) { $clash = str_contains($e->getMessage(), 'one object per name'); }
	check('two WRITTEN slots mapped to the same name are refused', $clash);
	$clashShipped = false;
	try { Roles::saveTemplateNames(['master' => Roles::TEMPLATE_SLOTS['devices'][0]]); }
	catch (\InvalidArgumentException $e) { $clashShipped = true; }
	check('mapping a written slot onto another written slot\'s shipped name is refused too', $clashShipped);
	// Nothing is created for a slot this page only looks for, so sharing one template between
	// two of them is allowed — as it is between roles.
	$shared = true;
	try { Roles::saveTemplateNames(['plan' => 'One combined template', 'alerts' => 'One combined template']); }
	catch (\InvalidArgumentException $e) { $shared = false; }
	check('two look-for slots may share one template', $shared
		&& Roles::templateName('plan') === 'One combined template' && Roles::templateName('alerts') === 'One combined template');
	// The same template on several roles: templatesOf() returns it once for a server in both.
	$twoRoles = $roles;
	$twoRoles['families'][0]['roles'][0]['templates'] = ['Shared by roles'];
	$twoRoles['families'][1]['roles'][0]['templates'] = ['Shared by roles'];
	check('one template may be given to several roles, and a server gets it once',
		Roles::templatesOf($twoRoles, [$twoRoles['families'][0]['roles'][0]['id'], $twoRoles['families'][1]['roles'][0]['id']]) === ['Shared by roles']);
	$tooMany = Roles::splitNames(implode("\n", array_map(fn($i) => 'n'.$i, range(1, 20))));
	check('the extra names are capped', count($tooMany) === Roles::MAX_ALIASES);
	Roles::saveTemplateNames([]);
	check('and clearing it all restores every shipped name', Roles::templateNames() === $shipped
		&& Roles::templateAliases() === array_map(fn($x) => [], Roles::TEMPLATE_SLOTS));

	// Roles saved before the macro prefix had this name carry none; it is the family id in capitals.
	$noPrefix = $roles; unset($noPrefix['families'][1]['macroPrefix']);
	check('a family with no macro prefix gets its id in capitals', Roles::upgrade($noPrefix)['families'][1]['macroPrefix'] === 'PARSER');

	/* ---------------- names ---------------- */
	$table = json_decode(file_get_contents(__DIR__.'/names.json'), true)['cases'];
	foreach ($table as $case) {
		check('base for '.implode('+', $case['roles']), Roles::serverBase($roles, $case['roles']) === $case['base'], Roles::serverBase($roles, $case['roles']));
	}
	check('servers are <client>-<roles>-<n>', ClientSpec::machineName('karthi', 'ES-Data-Parser-Engine', 1) === 'karthi-ES-Data-Parser-Engine-1');
	check('and the client hosts', ClientSpec::masterName('karthi') === 'karthi-Master' && ClientSpec::clusterName('karthi') === 'karthi-ES-Cluster' && ClientSpec::ulmName('karthi') === 'karthi-ULM');
	check('a name that follows the pattern keeps its number', ClientSpec::slotOf('karthi-ES-Data-Hot-7', 'karthi', 'ES-Data-Hot') === 7);
	check('one that does not has none', ClientSpec::slotOf('vm-1 es-node', 'karthi', 'ES-Data-Hot') === null && ClientSpec::slotOf('karthi-ES-Data-Hot-Coord-1', 'karthi', 'ES-Data-Hot') === null);

	/* ---------------- the form ---------------- */
	$spec = new ClientSpec($roles);
	$servers = [
		['ip' => '10.0.0.22', 'roles' => ['es_data_hot']],
		['ip' => '10.0.0.21', 'roles' => ['es_coord', 'es_data_hot'], 'services' => ['nginx', ' ', 'es_coord'], 'notes' => ' rack 4 ', 'attrs' => ['Rack' => 'R4']],
		['ip' => '10.0.0.11', 'roles' => ['es_master']],
		['ip' => '10.0.1.5', 'roles' => ['parser', 's3_parser']],
		['ip' => '10.0.5.4', 'roles' => ['engine', 'aiml']]
	];
	$form = fn(array $over = []) => array_merge($spec->defaults(), ['name' => 'karthi', 'type' => 'DI', 'es_url' => 'https://es.karthi.local:9243',
		'servers' => json_encode($servers), 'es_data_hot_cpu' => '32', 'es_master_cpu' => '12', 'es_data_hot_mem' => '128', 'es_master_mem' => '48',
		'engine_cpu' => '16', 'single_node_cpu' => '8', 'ulm_bucket' => 'karthi-archive', 'ulm_region' => 'ap-south-1'], $over);
	['client' => $c, 'errors' => $e] = $spec->fromForm($form());
	check('a full DI client has no errors', $e === [], $e);
	check('servers come back sorted by IP', array_keys($c['servers']) === ['10.0.0.11', '10.0.0.21', '10.0.0.22', '10.0.1.5', '10.0.5.4']);
	$s21 = $c['servers']['10.0.0.21'];
	check('a server keeps several roles, in role order', $s21['roles'] === ['es_data_hot', 'es_coord']);
	check('services: blanks and roles dropped, sorted', $s21['services'] === ['nginx']);
	check('notes trimmed, attributes lower-cased', $s21['notes'] === 'rack 4' && $s21['attrs'] === ['rack' => 'R4']);
	check('the canonical JSON is one way only', $c['servers_json'] === $spec->canonServers(array_reverse($servers)));
	check('a DI client needs its archive', count($spec->fromForm($form(['ulm_bucket' => '', 'ulm_region' => '']))['errors']) === 2);
	check('tag1 values are not asked for any more', !preg_grep('/tag1/', $spec->fromForm($form(['ulm_bucket' => '']))['errors']));
	check('an On-Prem client needs no archive', $spec->fromForm($form(['type' => 'On-Prem', 'ulm_bucket' => '']))['errors'] === []);
	check('a type outside CI, DI, On-Prem is refused', (bool) preg_grep('/Type must be one of CI, DI, On-Prem/', $spec->fromForm($form(['type' => 'Cloud']))['errors']));
	check('CI is a type, and like On-Prem needs no log archive', $spec->fromForm($form(['type' => 'CI']))['errors'] === []);
	$srv = fn(array $list) => $spec->fromForm($form(['servers' => json_encode($list)]))['errors'];
	check('an IP listed twice is refused', (bool) preg_grep('/listed twice/', $srv([['ip' => '10.0.0.1', 'roles' => ['parser']], ['ip' => '10.0.0.1', 'roles' => ['aiml']]])));
	check('a server without a role is refused', (bool) preg_grep('/has no role/', $srv([['ip' => '10.0.0.1', 'roles' => []]])));
	check('an unknown role is named', (bool) preg_grep('/no role "soar"/', $srv([['ip' => '10.0.0.1', 'roles' => ['soar']]])));
	check('Single node cannot be combined', (bool) preg_grep('/stands for every role/', $srv([['ip' => '10.0.0.1', 'roles' => ['single_node', 'parser']]])));
	check('a hostname is not an IP', (bool) preg_grep('/"parser01" is not an IPv4/', $srv([['ip' => 'parser01', 'roles' => ['parser']]])));
	check('a bad service name is refused', (bool) preg_grep('/service "a b"/', $srv([['ip' => '10.0.0.1', 'roles' => ['parser'], 'services' => ['a b']]])));
	check('garbage in the servers field says so', (bool) preg_grep('/could not be read/', $spec->fromForm($form(['servers' => '{nope']))['errors']));
	check('a space in the client name is refused (it names hosts)', (bool) preg_grep('/may hold only/', $spec->fromForm($form(['name' => 'kar thi']))['errors']));
	check('a negative request is refused', (bool) preg_grep('/0 or more/', $spec->fromForm($form(['es_master_cpu' => '-1']))['errors']));
	check('monitored by must be proxy: or group:', (bool) preg_grep('/proxy:<name>/', $spec->fromForm($form(['monitored_by' => 'dc-proxy']))['errors'])
		&& $spec->fromForm($form(['monitored_by' => 'proxy:dc-proxy']))['errors'] === []);
	['client' => $dev] = $spec->fromForm($form(['purchased_by' => 'devices', 'purchased' => '500', 'purchased_devices' => '450']));
	check('bought by devices: storage is not set, so its alarm stays quiet', $dev['fields']['purchased'] === '0' && $dev['fields']['purchased_devices'] === '450');
	['client' => $zb] = $spec->fromForm($form(['es_password_mode' => 'zabbix', 'es_password_path' => 'secret/x:y', 'es_password' => 'hunter2']));
	check('a Zabbix secret password clears the Vault path, and stays out of the fields', $zb['fields']['es_password_path'] === '' && $zb['es_password'] === 'hunter2'
		&& !in_array('hunter2', $zb['fields'], true));

	/* ---------------- what a save deletes ---------------- */
	// Four page-made hosts on one IP, one of them with a role: a save listing no servers
	// deleted all four. A host without a role must never be deleted by a save, and the
	// ones that are must be named first (ClientSave asks before going ahead).
	$managed = [Reconciler::MANAGED];
	$h = fn($id, $name, $ip, $roles) => ['hostid' => $id, 'name' => $name, '_ip' => $ip, '_roles' => $roles, 'tags' => $managed];
	$nowK = ['ulm' => null, 'shared' => [], 'machines' => [
		'11' => $h('11', 'k es-node', '203.0.113.20', []), '12' => $h('12', 'k fwd', '203.0.113.20', ['forwarder']),
		'13' => $h('13', 'k parser', '203.0.113.20', []), '14' => $h('14', 'k-Parser-1', '10.0.0.9', ['parser'])]];
	$nowK['shared']['203.0.113.20'] = [$nowK['machines']['11'], $nowK['machines']['12'], $nowK['machines']['13']];
	$rec = new Reconciler($spec);
	['client' => $empty] = $spec->fromForm($form(['type' => 'On-Prem', 'ulm_bucket' => '', 'servers' => '[]']));
	check('a save listing no servers deletes only page-made hosts that held a role — named first', $rec->plannedDeletes($empty, $nowK) === ['12' => 'k fwd', '14' => 'k-Parser-1']);
	['client' => $keep] = $spec->fromForm($form(['type' => 'On-Prem', 'ulm_bucket' => '', 'servers' => json_encode([['ip' => '203.0.113.20', 'roles' => ['forwarder']], ['ip' => '10.0.0.9', 'roles' => ['parser']]])]));
	check('listing every server deletes nothing', $rec->plannedDeletes($keep, $nowK) === []);
	['client' => $merge] = $spec->fromForm($form(['type' => 'On-Prem', 'ulm_bucket' => '', 'merge' => '203.0.113.20', 'servers' => json_encode([['ip' => '203.0.113.20', 'roles' => ['forwarder']], ['ip' => '10.0.0.9', 'roles' => ['parser']]])]));
	check('a ticked merge names the hosts it deletes: all but the first', $rec->plannedDeletes($merge, $nowK) === ['12' => 'k fwd', '13' => 'k parser']);
	$hand = $nowK; $hand['machines']['14']['tags'] = []; $hand['shared'] = [];
	check('a host made by hand is never planned for deletion', !isset($rec->plannedDeletes($empty, $hand)['14']));
	$problems = $rec->sharedProblems($keep + ['es_password' => ''], $nowK + ['cluster' => null]);
	check('hosts sharing an IP without a ticked merge stop the save', (bool) preg_grep('/3 hosts share 203\.0\.113\.20/', $problems), $problems);

	/* ---------------- through a Windows jump host ---------------- */
	$jumpForm = fn(array $over = []) => $form(array_merge(['monitored_by' => 'jump', 'jump_host' => 'jump-win.acme.internal', 'jump_user' => 'jump-user',
		'es_apikey_path' => 'secret/elasticpro/acme:apikey', 'ulm_bucket' => '', 'type' => 'On-Prem'], $over));
	['client' => $jc, 'errors' => $je] = $spec->fromForm($jumpForm());
	check('a jump host client has no errors, port 22 and key id_ed25519 by default', $je === [] && $jc['fields']['jump_port'] === '22' && $jc['fields']['jump_key'] === 'id_ed25519', $je);
	check('a jump host needs its address, user and API key', count($spec->fromForm($jumpForm(['jump_host' => '', 'jump_user' => '', 'es_apikey_path' => '']))['errors']) === 3);
	$jm = $spec->clusterMacros($jc, true);
	check('the cluster host gets the jump host macros and the API key from Vault', $jm['{$WJ.HOST}'] === ['jump-win.acme.internal', 0] && $jm['{$WJ.USER}'] === ['jump-user', 0]
		&& $jm['{$ES.APIKEY}'] === ['secret/elasticpro/acme:apikey', ZBX_MACRO_TYPE_VAULT]);
	check('the cluster certificate is checked by default (no -k)', $jc['fields']['jump_tls'] === 'verify' && $jm['{$WJ.CURL.TLS}'] === ['', 0]);
	$caForm = $spec->fromForm($jumpForm(['jump_tls' => 'ca', 'jump_ca' => 'C:\\certs\\es-ca.pem']));
	check('a CA file on the jump host becomes --cacert', $caForm['errors'] === [] && $spec->clusterMacros($caForm['client'], true)['{$WJ.CURL.TLS}'] === ['--cacert "C:\\certs\\es-ca.pem"', 0], $caForm['errors']);
	check('a CA path with a quote is refused', count($spec->fromForm($jumpForm(['jump_tls' => 'ca', 'jump_ca' => 'C:\\x" & del']))['errors']) === 1);
	check('not checking is -k, and only when chosen', $spec->clusterMacros($spec->fromForm($jumpForm(['jump_tls' => 'none']))['client'], true)['{$WJ.CURL.TLS}'] === ['-k', 0]
		&& $spec->fromForm($jumpForm(['jump_tls' => 'none', 'jump_ca' => 'C:\\x.pem']))['client']['fields']['jump_ca'] === '');
	check('the jump command has no -k of its own', !str_contains(JumpTemplate::command(['/x']), ' -k '));
	$cl = $spec->cloneOf(array_merge($jumpForm(['lead_name' => 'Asha', 'cluster_dl' => 'soc@acme.example', 'es_data_cpu' => '16']), ['_now' => ['x'], 'merge' => '1']));
	check('a clone keeps roles, capacity and the jump host, and starts with no name, URL, key, contacts or servers',
		$cl['name'] === '' && $cl['es_url'] === '' && $cl['es_apikey_path'] === '' && $cl['lead_name'] === '' && $cl['cluster_dl'] === '' && $cl['servers'] === '[]'
		&& $cl['es_data_cpu'] === '16' && $cl['monitored_by'] === 'jump' && $cl['jump_host'] === 'jump-win.acme.internal' && !isset($cl['_now']) && !isset($cl['merge']), $cl);
	check('no jump host macros for a client reached directly', !isset($spec->clusterMacros($c, true)['{$WJ.HOST}']));
	$ju = $spec->fromForm($jumpForm(['ulm_bucket' => 'acme-archive']))['client'];
	$um = $spec->ulmMacros($ju, true);
	check('through a jump host the log archive check reads Elasticsearch from its SSH items', $spec->wantsUlm($ju) && $um['{$ULM.ES.VIA}'] === ['zabbix', 0]
		&& $um['{$WJ.HOST}'] === ['jump-win.acme.internal', 0] && $um['{$ES.APIKEY}'][1] === ZBX_MACRO_TYPE_VAULT);
	check('a direct client\'s log archive check asks Elasticsearch itself', $spec->ulmMacros($spec->fromForm($form(['ulm_bucket' => 'acme-archive']))['client'], true)['{$ULM.ES.VIA}'] === ['direct', 0]);
	$ux = JumpTemplate::ulmExport()['zabbix_export']['templates'][0];
	check('the jump log archive template asks the two searches over SSH, keys the check finds', array_column($ux['items'], 'key') === [JumpTemplate::ULM_DAYS, JumpTemplate::ULM_TAGS]
		&& str_contains(JumpTemplate::ULM_DAYS, 'ep.ulm.days,') && str_contains(JumpTemplate::ULM_TAGS, 'ep.ulm.tags,'));
	check('its searches are JSON once the macros are filled in', json_decode(preg_replace('/\{\$[A-Z.]+\}/', 'x', JumpTemplate::ULM_DAYS_QUERY)) !== null
		&& json_decode(preg_replace('/\{\$[A-Z.]+\}/', 'x', JumpTemplate::ULM_TAGS_QUERY)) !== null);
	check('contacts: a DL must be an email, a contract end a date', count($spec->fromForm($form(['cluster_dl' => 'not-mail', 'contract_end' => '31/12/2026']))['errors']) === 2
		&& $spec->fromForm($form(['lead_name' => 'Priya R', 'cluster_dl' => 'soc-acme@corp.com', 'contract_end' => '2026-12-31']))['errors'] === []);

	$jx = JumpTemplate::export()['zabbix_export'];
	$jt = $jx['templates'][0];
	$jKeys = array_column($jt['items'], 'key');
	$bad = [];
	$walk3 = function ($v, $path) use (&$walk3, &$bad) {
		if (!is_array($v)) return;
		if (preg_match('/(s|mappings|prototypes)$/', (string) basename($path)) && !array_is_list($v)) $bad[] = $path;
		foreach ($v as $k => $w) $walk3($w, $path.'/'.$k);
	};
	$walk3($jx['templates'], 'templates');
	check('jump template: every list is a JSON list', $bad === [], $bad);
	foreach (['es.nodes.fs.total_in_bytes', 'es.nodes.fs.used_in_bytes', DevicesTemplate::KEY, 'es.cluster.status', 'ep.es.indices.red', 'ep.es.slm.last_success_age'] as $k) {
		check("jump template gives $k, the key the reports read", in_array($k, $jKeys, true));
	}
	foreach ($jt['items'] as $it) {
		if ($it['type'] === 'DEPENDENT') {
			check("jump figure {$it['key']} has its master", in_array($it['master_item']['key'], $jKeys, true));
		}
		foreach ($it['triggers'] ?? [] as $tr) {
			preg_match_all('/last\(\/'.preg_quote(JumpTemplate::NAME, '/').'\/([^,)]+(?:\[[^\]]*\])?)/', $tr['expression'], $mm);
			foreach ($mm[1] as $k) { check("jump trigger item exists: $k", in_array($k, $jKeys, true)); }
		}
	}
	$fast = array_values(array_filter($jt['items'], fn($i) => $i['key'] === JumpTemplate::FAST))[0];
	check('one curl.exe call asks every endpoint of the minute, with a marker after each', substr_count($fast['params'], '"{$ELASTICSEARCH.SCHEME}') === count(JumpTemplate::FAST_PATHS)
		&& strpos($fast['params'], '-w "\n@@HTTP %{http_code}@@\n"') !== false && strpos($fast['params'], 'Authorization: ApiKey {$ES.APIKEY}') !== false);
	check('the SSH checks sign in with the key named on the host', $fast['authtype'] === 'PUBLIC_KEY' && $fast['privatekey'] === '{$WJ.KEY}' && $fast['username'] === '{$WJ.USER}');
	check('the node figures come from discovery', count($jt['discovery_rules'][0]['item_prototypes']) === 5);
	check('no answer for 5 minutes is a problem', strpos($jx['triggers'][0]['expression'], 'nodata(/'.JumpTemplate::NAME.'/'.JumpTemplate::FAST.',5m)') === 0);

	/* ---------------- problems by email to the cluster DL ---------------- */
	check('emailing the DL needs a DL', count($spec->fromForm($form(['alert_dl' => '1', 'cluster_dl' => '']))['errors']) === 1
		&& $spec->fromForm($form(['alert_dl' => '1', 'cluster_dl' => 'soc@acme.example']))['client']['fields']['alert_dl'] === '1'
		&& $spec->fromForm($form([]))['client']['fields']['alert_dl'] === '0');
	check('routing is wanted only when asked, with a DL, and not once decommissioned',
		AlertRouting::wanted(['{$EP.ALERT.DL}' => '1', '{$EP.DL}' => 'soc@acme.example'])
		&& !AlertRouting::wanted(['{$EP.ALERT.DL}' => '1', '{$EP.DL}' => ''])
		&& !AlertRouting::wanted(['{$EP.ALERT.DL}' => '0', '{$EP.DL}' => 'soc@acme.example'])
		&& !AlertRouting::wanted(['{$EP.ALERT.DL}' => '1', '{$EP.DL}' => 'soc@acme.example', '{$EP.CLIENT.STATUS}' => 'decommissioned']));
	$rp = AlertRouting::plan('acme', '42', 'soc@acme.example', '1');
	check('the DL group reads only the client\'s host group and has no frontend', $rp['usergroup']['hostgroup_rights'] === [['id' => '42', 'permission' => 2]] && $rp['usergroup']['gui_access'] === 3);
	check('the action takes only the client\'s group, and pauses in maintenance', $rp['action']['filter']['conditions'] === [['conditiontype' => 0, 'operator' => 0, 'value' => '42']]
		&& $rp['action']['pause_suppressed'] === 1 && $rp['media'][0]['sendto'] === ['soc@acme.example']);
	check('the weekly report needs a DL and stops once decommissioned', AlertRouting::reportWanted(['{$EP.REPORT.WEEKLY}' => '1', '{$EP.DL}' => 'soc@acme.example'])
		&& !AlertRouting::reportWanted(['{$EP.REPORT.WEEKLY}' => '1', '{$EP.DL}' => '']) && !AlertRouting::reportWanted(['{$EP.REPORT.WEEKLY}' => '1', '{$EP.DL}' => 'x@y.z', '{$EP.CLIENT.STATUS}' => 'decommissioned'])
		&& count($spec->fromForm($form(['weekly_report' => '1', 'cluster_dl' => '']))['errors']) === 1);
	$wp = AlertRouting::reportPlan('acme', '42', '7', '1');
	check('the report dashboard shows the three reports for the client\'s group only, shared read-only with the DL group',
		array_column($wp['dashboard']['pages'][0]['widgets'], 'type') === ['ep_resources', 'ep_capacity', 'ep_volume']
		&& array_unique(array_map(fn($w) => $w['fields'][0]['value'], $wp['dashboard']['pages'][0]['widgets'])) === ['42']
		&& $wp['dashboard']['userGroups'] === [['usrgrpid' => '7', 'permission' => 2]]);
	check('the report goes weekly, Monday 08:00, for the week before, to the DL group', $wp['report']['cycle'] === 1 && $wp['report']['period'] === 1
		&& $wp['report']['weekdays'] === 1 && $wp['report']['start_time'] === 28800 && $wp['report']['user_groups'] === [['usrgrpid' => '7', 'access_userid' => '1']]);
	check('the DL account name is safe', AlertRouting::userName('Acme Corp/EU') === 'ep-dl-Acme-Corp-EU');

	/* ---------------- storage forecast ---------------- */
	check('full in: -1 (flat or falling) is "not growing", not "under a day"', Forecast::fullIn(-1.0)['level'] === 'flat' && Forecast::fullIn(-1.0)['days'] === null);
	check('full in: unknown stays unknown', Forecast::fullIn(null) === null);
	check('full in: red under 7 days, yellow under 30', Forecast::fullIn(3 * 86400.0)['level'] === 'bad' && Forecast::fullIn(20 * 86400.0)['level'] === 'warn'
		&& Forecast::fullIn(45 * 86400.0)['level'] === 'ok' && Forecast::fullIn(45 * 86400.0)['text'] === '45 days' && Forecast::fullIn(1e12)['level'] === 'flat');
	check('the master template measures what the forecast reads', in_array(Forecast::KEY, array_column((new MasterTemplate(Roles::defaults()))->export()['zabbix_export']['templates'][0]['items'], 'key'), true));

	/* ---------------- status and the register ---------------- */
	check('status: active unless the master host says otherwise', Lifecycle::statusOf([]) === 'active' && Lifecycle::statusOf(['{$EP.CLIENT.STATUS}' => 'disabled']) === 'disabled'
		&& Lifecycle::statusOf(['{$EP.CLIENT.STATUS}' => 'nonsense']) === 'active');
	$nowR = ['master' => ['hostid' => '1', 'name' => 'k-Master'], 'cluster' => ['hostid' => '2', 'name' => 'k-ES-Cluster'], 'ulm' => null,
		'machines' => ['3' => ['hostid' => '3', 'name' => 'k-Parser-1', '_ip' => '10.0.0.3', '_roles' => ['parser']], '4' => ['hostid' => '4', 'name' => 'k-AIML-1', '_ip' => '10.0.0.4', '_roles' => ['aiml']]]];
	Registry::record('k', ['name' => 'k'], $nowR);
	$gone = $nowR; unset($gone['machines']['4']); $gone['cluster'] = null;
	$ex = ['1' => 'k-Master', '3' => 'k-Parser-1'];
	check('a host deleted in Zabbix shows as removed, with what it was', array_map('strval', array_keys(Registry::removed('k', $gone, $ex))) === ['2', '4'] && Registry::removed('k', $gone, $ex)['4']['ip'] === '10.0.0.4');
	$moved = $nowR; unset($moved['machines']['4']);
	$renamed = $moved; $renamed['machines']['3']['name'] = 'parser-old';
	$d = Registry::compare('k', $renamed, ['1' => 'k-Master', '2' => 'k-ES-Cluster', '3' => 'parser-old', '4' => 'k-AIML-1']);
	check('a host moved out of the group is changed, never removed (re-creating it would double the IP)', $d['removed'] === [] && $d['changed']['4']['why'] === 'moved' && $d['changed']['4']['now'] === 'k-AIML-1');
	check('a host renamed in Zabbix is changed, with both names', $d['changed']['3']['why'] === 'renamed' && $d['changed']['3']['name'] === 'k-Parser-1' && $d['changed']['3']['now'] === 'parser-old');
	check('every recorded host id, for one lookup', Registry::hostIds() === ['1', '2', '3', '4']);
	Registry::accept('k', ['4']);
	check('accepting a removal forgets that host only', array_map('strval', array_keys(Registry::removed('k', $gone, $ex))) === ['2']);
	Registry::forget('k');
	check('a forgotten client has nothing recorded', Registry::removed('k', $gone, $ex) === []);
	check('a proxy not seen for 5 minutes is down, and says so', SetupChecks::proxyDown([SetupChecks::proxy(time() - 600, time())]) !== null && SetupChecks::proxyDown([SetupChecks::proxy(time() - 60, time())]) === null
		&& SetupChecks::proxyDown([SetupChecks::proxy(null, time())]) === 'proxy not in Zabbix');
	check('a proxy group offline or degrading is down; recovering is not; unknown is not yet known', SetupChecks::proxyGroup(1)[1] === false && SetupChecks::proxyGroup(4)[1] === false
		&& SetupChecks::proxyGroup(2)[1] === true && SetupChecks::proxyGroup(0)[1] === null);
	History::add('k', 'disabled', 'Admin', '20260101-000000-abcd');
	History::add('other', 'edited', 'Admin');
	check('history: a client\'s own entries, newest first, with their backup', count(History::of('k')) === 1 && History::of('k')[0]['backup'] === '20260101-000000-abcd');

	/* ---------------- older forms ---------------- */
	$old = ['name' => 'k', 'type' => 'On-Prem', 'ips_es_data_hot' => "10.0.0.21\n10.0.0.22", 'ips_es_coord' => '10.0.0.21', 'ips_parser' => '', 'ulm_tags' => 'k1', 'es_jumphost' => 'j'];
	$up = $spec->upgradeForm($old);
	check('an old form: an IP under two roles becomes one server with both', json_decode($up['servers'], true)[0]['roles'] === ['es_data_hot', 'es_coord']
		&& count(json_decode($up['servers'], true)) === 2);
	check('an old form loses the fields that are gone', !isset($up['ulm_tags']) && !isset($up['es_jumphost']) && !isset($up['ips_es_data_hot']));
	check('an old form still passes', $spec->fromForm($up)['errors'] === [], $spec->fromForm($up)['errors']);

	/* ---------------- macros ---------------- */
	$m = $spec->masterMacros($c);
	check('the master keeps type and per-role requests', $m['{$EP.CLIENT.TYPE}'] === ['DI', 0] && $m['{$EP.ES_DATA_HOT.CPU.REQUESTED}'] === ['32', 0]);
	[$es1, $es2] = MasterTemplate::familyMountMacros('es');
	check('a family is measured on / when its roles have no extra disk', $m[$es1] === ['/', 0] && $m[$es2] === ['', 0]);
	['client' => $mnt] = $spec->fromForm($form(['es_data_hot_disk2_fs' => '/data', 'es_data_hot_disk2' => '4000', 'es_master_disk2_fs' => '/data']));
	check('… and on / plus each extra mount of its roles in use, once', $spec->masterMacros($mnt)[$es2] === ['/data', 0] && $spec->masterMacros($mnt)[MasterTemplate::familyMountMacros('es')[2]] === ['', 0]);
	check('extra disks count in the family\'s requested disk', $spec->clusterMacros($mnt, false)['{$ES.ROOTDISK.REQUESTED}'] === ['4000', 0]);

	/* ---------------- disks: / and up to four more ---------------- */
	$disk = fn(array $over) => $spec->fromForm($form($over))['errors'];
	check('an extra disk needs a mount like /data', (bool) preg_grep('/not a mount like \/data/', $disk(['es_master_disk2_fs' => 'data'])));
	check('/ is not an extra disk', (bool) preg_grep('/not a mount like/', $disk(['es_master_disk2_fs' => '/'])));
	check('a mount twice is refused', (bool) preg_grep('/lists the mount \/data twice/', $disk(['es_master_disk2_fs' => '/data', 'es_master_disk3_fs' => '/data'])));
	check('a size without a mount is refused', (bool) preg_grep('/size but no mount/', $disk(['es_master_disk4' => '100'])));
	check('five disks in all are fine', $disk(['es_master_disk2_fs' => '/d2', 'es_master_disk3_fs' => '/d3', 'es_master_disk4_fs' => '/d4', 'es_master_disk5_fs' => '/d5']) === []);
	check('a role\'s mounts: / first, then its extra disks', Roles::diskMounts(['{$EP.PARSER.DISK3.FS}' => '/logs', '{$EP.PARSER.DISK2.FS}' => '/data'], 'parser') === ['/', '/data', '/logs']);
	$legacy = ClientSpec::legacyDisk(['es_data_hot_disk' => '4000'], 'es_data_hot', '/data');
	check('an old single disk on /data becomes disk 2, / not set', $legacy['es_data_hot_disk2_fs'] === '/data' && $legacy['es_data_hot_disk2'] === '4000' && $legacy['es_data_hot_disk'] === '0');
	check('an old single disk on / stays the / disk', ClientSpec::legacyDisk(['x_disk' => '50'], 'x', '/') === ['x_disk' => '50']);
	$oldCsv = Csv::parse("client,es_data_hot_disk_gb,es_data_hot_disk_mount\nkarthi,4000,/data\n", $roles);
	$oc = Csv::toForm($oldCsv['rows'][0], $spec->defaults(), $roles);
	check('an older clients.csv with one disk mount is still read', $oldCsv['ignored'] === [] && $oc['es_data_hot_disk2_fs'] === '/data' && $oc['es_data_hot_disk2'] === '4000');
	$hotDisk = array_values(array_filter((new MasterTemplate($roles))->export()['zabbix_export']['templates'][0]['items'], fn($i) => $i['key'] === 'ep.role.disk.allocated[es_data_hot]'))[0]['params'];
	check('a role\'s disk adds up / and its extra mounts, in one calculation', strpos($hotDisk, 'tag="filesystem:/"') !== false
		&& strpos($hotDisk, 'tag="filesystem:{$EP.ES_DATA_HOT.DISK5.FS}"') !== false && substr_count($hotDisk, ' or ') === 4);
	$cl = $spec->clusterMacros($c, true);
	// ES: hot 32 + master 12 + the Single node's 8, which counts in ES too.
	check('the cluster host gets family totals under the cluster template\'s names', $cl['{$ES.CPU.REQUESTED}'] === ['52', 0] && $cl['{$ES.MEMORY.REQUESTED}'] === ['176', 0], [$cl['{$ES.CPU.REQUESTED}'] ?? null]);
	check('Single node requests count in each family it stands for', $cl['{$ENGINE.CPU.REQUESTED}'] === ['24', 0] && $cl['{$PARSER.CPU.REQUESTED}'] === ['8', 0], [$cl['{$ENGINE.CPU.REQUESTED}'] ?? null]);
	check('memory also under the spelling the cluster template\'s items read', $cl['{$ES.MEM.REQUESTED}'] === ['176', 0] && $cl['{$FORWARDER.MEM.REQUESTED}'] === ['0', 0]);
	check('purchased devices reach the cluster host', $spec->clusterMacros($dev, false)['{$EP.DEVICES.PURCHASED}'] === ['450', 0]);
	check('a new cluster host reads its password from Vault', $cl['{$ELASTICSEARCH.PASSWORD}'] === ['secret/elasticpro/karthi:password', ZBX_MACRO_TYPE_VAULT]);
	check('an existing one keeps its own', !isset($spec->clusterMacros($c, false)['{$ELASTICSEARCH.PASSWORD}']));
	check('a typed password becomes a Zabbix secret', $spec->clusterMacros($zb, false)['{$ELASTICSEARCH.PASSWORD}'] === ['hunter2', ZBX_MACRO_TYPE_SECRET]);
	['client' => $zb0] = $spec->fromForm($form(['es_password_mode' => 'zabbix']));
	check('no password typed: the host keeps its secret', !isset($spec->clusterMacros($zb0, false)['{$ELASTICSEARCH.PASSWORD}']) && !isset($spec->clusterMacros($zb0, true)['{$ELASTICSEARCH.PASSWORD}']));
	check('the jump host macro is gone', !isset($cl['{$ELASTICSEARCH.JUMPHOST}']));
	$u = $spec->ulmMacros($c, true);
	check('the archive host gets bucket and the template defaults it needs, no tag list', $u['{$ULM.S3.BUCKET}'] === ['karthi-archive', 0] && $u['{$ULM.ES.TAG.FIELD}'] === ['tag1.keyword', 0]
		&& !isset($u['{$ULM.TAGS}']));
	check('a role-based bucket carries no Vault secret', !isset($u['{$ULM.AWS.SECRET.ACCESS.KEY}']));

	/* ---------------- CSV ---------------- */
	$cols = array_keys(Csv::columns($roles));
	check('clients.csv starts with client and type', array_slice($cols, 0, 2) === ['client', 'type']);
	check('every role has its requested columns and no IP column', in_array('aiml_memory_gb', $cols, true) && in_array('single_node_cpu_cores', $cols, true) && !preg_grep('/_ips$/', $cols));
	check('purchased by, password kept in and proxy are columns', in_array('purchased_by', $cols, true) && in_array('es_password_in', $cols, true) && in_array('monitored_by', $cols, true));
	$fm = array_merge($form(), ['servers' => $c['servers_json']]);
	$parsed = Csv::parse(Csv::export($roles, [$fm]), $roles);
	check('export then parse is the same client', $parsed['errors'] === [] && Csv::toForm($parsed['rows'][0], $spec->defaults(), $roles)['es_data_hot_cpu'] === '32');
	$sv = Csv::parseServers(Csv::exportServers($roles, [$fm], ['karthi' => ['10.0.0.21' => 'karthi-ES-Data-Hot-Coord-1']]), $roles);
	check('servers.csv round-trips', $sv['errors'] === [] && $spec->canonServers($sv['clients']['karthi']) === $c['servers_json'], $sv['errors']);
	check('servers.csv carries the host name, for reading', strpos(Csv::exportServers($roles, [$fm], ['karthi' => ['10.0.0.21' => 'karthi-ES-Data-Hot-Coord-1']]), 'karthi-ES-Data-Hot-Coord-1') !== false);
	$byName = Csv::parseServers("client,ip,roles,services,owner\nacme,10.1.1.1,ES Data Hot; ES Coordination,kafka,team-a\n", $roles);
	check('roles by name, extra columns as attributes', $byName['clients']['acme'][0]['roles'] === ['es_data_hot', 'es_coord'] && $byName['clients']['acme'][0]['attrs'] === ['owner' => 'team-a']);
	check('a kind other than server is refused for now', (bool) preg_grep('/kind "app"/', Csv::parseServers("client,ip,roles,kind\nacme,10.1.1.1,parser,app\n", $roles)['errors']));
	check('servers.csv needs client, ip and roles', count(Csv::parseServers("client,ip\nacme,10.1.1.1\n", $roles)['errors']) === 1);
	$semi = "client;type;es_node_x\r\nacme;on-prem;1\r\n";
	$p = Csv::parse($semi, $roles);
	check('a ;-separated file from Excel is read', $p['rows'][0]['client'] === 'acme' && $p['ignored'] === ['es_node_x']);
	check('On-Prem is understood however it is written', Csv::toForm($p['rows'][0], $spec->defaults(), $roles)['type'] === 'On-Prem');
	$base = $form(); $base['es_url'] = 'https://old:9200';
	$row = Csv::parse("client,es_master_cpu_cores\nkarthi,16\n", $roles)['rows'][0];
	$over = Csv::toForm($row, $base, $roles);
	check('a column left out keeps its value', $over['es_url'] === 'https://old:9200' && $over['es_master_cpu'] === '16' && $over['servers'] === $base['servers']);
	$row = Csv::parse("client,s3_role_arn\nkarthi,\n", $roles)['rows'][0];
	check('an empty cell clears it', Csv::toForm($row, $base + ['ulm_role_arn' => 'arn:x'], $roles)['ulm_role_arn'] === '');
	check('no client column is an error', (bool) preg_grep('/no "client" column/', Csv::parse("name,type\nx,DI\n", $roles)['errors']));
	check('a formula in a cell is written as text', strpos(Csv::export($roles, [array_merge($spec->defaults(), ['name' => '=cmd'])]), "'=cmd") !== false);

	/* ---------------- backups ---------------- */
	check('a form is the same whatever its order, blanks and "_" keys', Backups::sameForm(
		['name' => 'k', 'purchased' => '10', 'servers' => '[]', '_now' => 'x'], ['purchased' => '10 ', 'name' => 'k', 'servers' => '[]']));
	check('a changed field is a different form', !Backups::sameForm(['name' => 'k', 'purchased' => '10'], ['name' => 'k', 'purchased' => '20']));
	@mkdir($dir.'/backups');
	file_put_contents($dir.'/backups/20260101-000000-abcd.json', json_encode(['id' => '20260101-000000-abcd', 'taken' => 1, 'by' => 'x', 'before' => 'old',
		'roles' => $v1, 'clients' => ['k' => $old], 'machines' => 3]));
	$b = Backups::get('20260101-000000-abcd');
	check('a backup from before servers reads in today\'s terms', $b['schema'] === 2 && isset($b['clients']['k']['servers'])
		&& json_decode($b['clients']['k']['servers'], true)[0]['roles'] === ['es_data_hot', 'es_coord'] && isset(Roles::byId($b['roles'])['single_node']));
	unlink($dir.'/backups/20260101-000000-abcd.json'); rmdir($dir.'/backups');

	/* ---------------- column settings ---------------- */
	$colsIn = [['id' => 'a', 'label' => 'A'], ['id' => 'b', 'label' => 'B'], ['id' => 'c', 'label' => 'C'], ['id' => 'new', 'label' => 'N']];
	$s = ColumnSettings::save('test', ['labels' => ['a' => 'Customer', 'zz' => 'x'], 'hidden' => ['b'], 'order' => ['c', 'a']], ['a', 'b', 'c', 'new']);
	check('unknown ids are dropped', !isset($s['labels']['zz']));
	$out = ColumnSettings::apply($colsIn, ColumnSettings::load('test'));
	check('renamed, hidden and reordered — a new column lands after the one it followed', array_column($out, 'label') === ['C', 'N', 'Customer'], array_column($out, 'label'));
	ColumnSettings::reset('test');
	check('reset brings the defaults back', array_column(ColumnSettings::apply($colsIn, ColumnSettings::load('test')), 'label') === ['A', 'B', 'C', 'N']);

	/* ---------------- the master template ---------------- */
	$x = (new MasterTemplate($roles))->export()['zabbix_export'];
	$t = $x['templates'][0];
	$keys = array_column($t['items'], 'key');
	// Zabbix's import wants every repeated tag as a list: a PHP array keyed by anything else
	// becomes a JSON object, which it refuses ("unexpected tag").
	$notList = [];
	$walk = function ($v, $path) use (&$walk, &$notList) {
		if (!is_array($v)) return;
		if (preg_match('/(s|_rules|mappings|fields|pages|widgets|dependencies)$/', (string) basename($path)) && !array_is_list($v)) $notList[] = $path;
		foreach ($v as $k => $w) $walk($w, $path.'/'.$k);
	};
	foreach (['templates', 'triggers', 'graphs'] as $part) $walk($x[$part], $part);
	check('every list in the export is a JSON list', $notList === [], array_slice($notList, 0, 5));
	check('role items for every role', in_array('ep.role.cpu.requested[es_data_hot]', $keys, true) && in_array('ep.role.disk.usage[aiml]', $keys, true));
	check('family items keep the keys the capacity report reads', in_array('ep.es.cpu.requested', $keys, true) && in_array('ep.fwd.disk.used', $keys, true));
	$famReq = array_values(array_filter($t['items'], fn($i) => $i['key'] === 'ep.es.cpu.requested'))[0];
	check('a family figure adds up every role tagged with it', strpos($famReq['params'], 'ep.role.cpu.requested[*]') !== false && strpos($famReq['params'], 'tag="family:es"') !== false);
	check('role items carry their family tag', in_array(['tag' => 'family', 'value' => 'es'], array_values(array_filter($t['items'], fn($i) => $i['key'] === 'ep.role.cpu.requested[es_master]'))[0]['tags'], true));
	$sn = array_values(array_filter($t['items'], fn($i) => $i['key'] === 'ep.role.cpu.requested[single_node]'))[0]['tags'];
	check('Single node items are tagged with every family it counts in', count(array_filter($sn, fn($tg) => $tg['tag'] === 'family')) === 5);
	$famDisk = array_values(array_filter($t['items'], fn($i) => $i['key'] === 'ep.es.disk.allocated'))[0]['params'];
	check('a family\'s disk is its machines on its mounts, so a shared server counts once', strpos($famDisk, 'group="ESNodes"') !== false
		&& strpos($famDisk, MasterTemplate::familyMountMacros('es')[0]) !== false && strpos($famDisk, MasterTemplate::familyMountMacros('es')[4]) !== false);
	check('devices: purchased, seen and their share', in_array('ep.devices.purchased', $keys, true) && in_array('ep.devices.usage', $keys, true)
		&& strpos(array_values(array_filter($t['items'], fn($i) => $i['key'] === 'ep.devices.seen'))[0]['params'], DevicesTemplate::KEY) !== false);
	check('no aggregate hides a macro in its key', !array_filter($t['items'], fn($i) => preg_match('/last_foreach\(\/\*\/[^?]*\{\$/', $i['params'])));
	check('a shortfall alert per role and resource, plus storage, plus storage over purchase', count($x['triggers']) === count(Roles::allRoles($roles)) * 4 + 2);
	$overT = array_values(array_filter($x['triggers'], fn($t) => strpos($t['expression'], MasterTemplate::OVER['storage']) !== false));
	check('storage over purchase reads the one share-of-purchased item, only when purchase is set', count($overT) === 1 && strpos($overT[0]['expression'], 'ep.es.storage.purchased)>0') !== false
		&& in_array(MasterTemplate::OVER['storage'], array_column($t['items'], 'key'), true));
	foreach ($x['triggers'] as $tr) {
		preg_match_all('/last\(\/'.preg_quote(MasterTemplate::NAME, '/').'\/([^)]+)\)/', $tr['expression'], $mm);
		foreach ($mm[1] as $k) { check("trigger item exists: $k", in_array($k, $keys, true)); }
	}
	foreach ($x['graphs'] as $g) { foreach ($g['graph_items'] as $gi) { check("graph item exists: {$gi['item']['key']}", in_array($gi['item']['key'], $keys, true)); } }
	foreach ($t['dashboards'][0]['pages'] as $pg) { foreach ($pg['widgets'] as $w) { foreach ($w['fields'] as $fld) {
		if ($fld['type'] === 'ITEM') { check("dashboard item exists: {$fld['value']['key']}", in_array($fld['value']['key'], $keys, true)); }
	} } }
	$macros = array_column($t['macros'], 'macro');
	foreach (array_values((new ClientSpec($roles))->macroFields()) as $mf) { check("the template defines $mf", in_array($mf, $macros, true)); }
	foreach ($roles['families'] as $fam) { foreach (MasterTemplate::familyMountMacros($fam['id']) as $fm) { check("the template defines $fm", in_array($fm, $macros, true)); } }
	foreach (array_keys((new ClientSpec($roles))->masterMacros($c)) as $mm) { check("the master macro $mm is the template's", $mm === '{$GRP.CLIENT}' || in_array($mm, $macros, true)); }

	/* ---------------- the devices template ---------------- */
	$d = DevicesTemplate::export()['zabbix_export'];
	$walkD = [];
	$walk2 = function ($v, $path) use (&$walk2, &$walkD) {
		if (!is_array($v)) return;
		if (preg_match('/(s|mappings)$/', (string) basename($path)) && !array_is_list($v)) $walkD[] = $path;
		foreach ($v as $k => $w) $walk2($w, $path.'/'.$k);
	};
	$walk2($d['templates'], 'templates');
	check('devices template: every list is a JSON list', $walkD === [], $walkD);
	$item = $d['templates'][0]['items'][0];
	check('devices: every 6 hours, counting distinct values exactly to 40,000', $item['delay'] === '6h' && strpos($item['posts'], '"precision_threshold":40000') !== false
		&& strpos($item['posts'], '{$EP.DEVICE.FIELD}') !== false && json_decode(str_replace(['{$EP.DEVICE.TIME.FIELD}', '{$EP.DEVICE.WINDOW}', '{$EP.DEVICE.FIELD}'], ['t', '24h', 'f'], $item['posts'])) !== null);
	check('devices: Elasticsearch\'s own error comes through', $item['preprocessing'][0]['type'] === 'CHECK_JSON_ERROR');
	check('devices: src_hostname by default', array_column($d['templates'][0]['macros'], 'value', 'macro')['{$EP.DEVICE.FIELD}'] === 'src_hostname');
	foreach ($item['triggers'] as $tr) {
		check('devices trigger reads its own item: '.$tr['name'], strpos($tr['expression'], '/'.DevicesTemplate::NAME.'/'.DevicesTemplate::KEY) !== false);
	}
	// The extra figures: every one read from a master request on the same template, every
	// trigger on an item that exists, every JavaScript step present.
	$dItems = $d['templates'][0]['items'];
	$dKeys = array_column($dItems, 'key');
	foreach ($dItems as $it) {
		if ($it['type'] === 'DEPENDENT') {
			check("figure {$it['key']} has its master", in_array($it['master_item']['key'], $dKeys, true));
		}
		foreach ($it['triggers'] ?? [] as $tr) {
			preg_match_all('/last\(\/'.preg_quote(DevicesTemplate::NAME, '/').'\/([^,)]+)/', $tr['expression'], $mm);
			foreach ($mm[1] as $k) { check("trigger item exists: $k", in_array($k, $dKeys, true)); }
		}
		foreach ($it['preprocessing'] ?? [] as $pp) {
			if ($pp['type'] === 'JAVASCRIPT') { check("{$it['key']}: its step has code", trim($pp['parameters'][0]) !== ''); }
		}
	}
	foreach (['ep.es.shards.active_primary', 'ep.es.shards.unassigned_reasons', 'ep.es.indices.red', 'ep.es.ilm.mode', 'ep.es.slm.mode',
			'ep.es.slm.last_success_age', 'ep.es.thread_pool.get.rejected.rate', 'ep.es.nodes.cpu.max', 'ep.es.indices.dangling',
			'ep.es.tasks.long', 'ep.es.aliases.no_write_index'] as $k) {
		check("the extra figure $k is there", in_array($k, $dKeys, true));
	}
	check('the technical name stays, so linked hosts keep the template', $d['templates'][0]['template'] === 'ElasticPro cluster devices');
	check('log-delay windows keep their keys', in_array('ep.delay.late.avg[1h]', $keys, true) && in_array('ep.delay.median.change[1d]', $keys, true));
	check('the roles fingerprint is on the template', in_array(['macro' => '{$EP.ROLES.HASH}', 'value' => Roles::hash($roles), 'description' => 'Which roles this template was written for. Set by the Clients page.'], $t['macros'], true));
	check('uuids are v4-shaped and stable', preg_match('/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/', MasterTemplate::uuid('x')) === 1 && MasterTemplate::uuid('x') === MasterTemplate::uuid('x'));
	$more = $roles; $more['families'][3]['roles'][] = ['id' => 'soar', 'label' => 'SOAR', 'short' => 'SOAR', 'group' => 'SOAR'];
	$k2 = array_column((new MasterTemplate($more))->export()['zabbix_export']['templates'][0]['items'], 'key');
	check('a role added appears as its own items, family formulas unchanged', in_array('ep.role.cpu.usage[soar]', $k2, true) && count($k2) === count($keys) + 12);

	foreach (array_diff(scandir($dir), ['.', '..']) as $fn) { unlink($dir.'/'.$fn); }
	rmdir($dir);
	// Actions that keep Zabbix's CSRF check must be called by POST with the token: Zabbix reads a
	// token only from a POST, and answers "Access denied" otherwise. The page's own fetch calls:
	$edit = file_get_contents(__DIR__.'/../views/ep.clients.edit.php');
	check('Test connection posts, with a CSRF token', str_contains($edit, "action=ep.clients.test', { method: 'POST'")
		&& str_contains($edit, "'<?= CSRF_TOKEN_NAME ?>': btn.dataset.csrf") && str_contains($edit, "CCsrfTokenHelper::get('ep.clients.test')"));
	foreach (glob(__DIR__.'/../views/*.php') as $view) {
		preg_match_all("/fetch\\('zabbix\\.php\\?action=([\\w.]+)/", file_get_contents($view), $m);
		foreach ($m[1] as $action) {
			$class = json_decode(file_get_contents(__DIR__.'/../manifest.json'), true)['actions'][$action]['class'] ?? '';
			$src = (string) @file_get_contents(__DIR__.'/../actions/'.$class.'.php');
			check("fetch of $action: reads only (no CSRF) or posts", str_contains($src, 'disableCsrfValidation') || str_contains(file_get_contents($view), "action=$action', { method: 'POST'"), basename($view));
		}
	}

	// A missing template says why it is missing. The log archive template is not in this
	// repository, so a Zabbix without it must still be able to add clients that want no archive.
	$msg = Reconciler::missingTemplatesMessage([Reconciler::ULM_TEMPLATE]);
	check('missing archive template: named, and says it is imported separately', str_contains($msg, Reconciler::ULM_TEMPLATE)
		&& str_contains($msg, 'imported separately') && str_contains($msg, 'leave its S3 bucket empty'), $msg);
	check('missing archive template: does not send them to the master-template button', !str_contains($msg, 'Write master template'), $msg);
	$msg2 = Reconciler::missingTemplatesMessage([MasterTemplate::NAME, Roles::clusterTemplate()]);
	check('missing ours: the button; missing imported: import first', str_contains($msg2, 'Write master template on the Clients page')
		&& str_contains($msg2, 'Import first: Elasticsearch Cluster by HTTP EP.') && !str_contains($msg2, 'imported separately'), $msg2);

	echo "$passed passed, $failed failed", PHP_EOL;
	exit($failed ? 1 : 0);
}
