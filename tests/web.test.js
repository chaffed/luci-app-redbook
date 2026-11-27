/*
 * The pages in a real browser: OpenWrt 23.05 with LuCI in a container, the
 * package's files copied in, a Docker volume as the USB drive, Chrome
 * driven by playwright-core.
 *   - LuCI: log in; Overview shows where the logs go and reads a log back
 *     (a line with markup stays text); Settings saves a setting on each
 *     tab, shows fields only when they apply, shows the syslog server
 *     configs, and keeps the network password write-only.
 *   - GL.iNet panel: tests/gl/panel.html stands in for the panel (it loads
 *     the view file the way the panel does) and tests/gl/rpc.lua for its
 *     /rpc (the panel's argument check and its limited ngx.pipe), running
 *     the real Lua module: Overview, the log viewer, and the panel's own
 *     settings form, including a value it must refuse.
 * Screenshots go to .test-out/web/.
 *
 * Needs docker, Google Chrome and: npm install --no-save playwright-core
 * APP_CHROME=/path/to/chrome picks another Chromium; APP_KEEP=1 leaves the
 * container running (http://127.0.0.1:18580, root / luci-test).
 * Run: node tests/web.test.js
 */
var fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http');

var ROOT = path.join(__dirname, '..');
var NAME = 'redbook-test-web', IMAGE = 'redbook-test-web', PORT = 18580, VOL = 'redbook-test-web-usb';
var WEB = 'http://127.0.0.1:' + PORT, ROOT_PW = 'luci-test';
var SHOTS = path.join(ROOT, '.test-out', 'web');
/* Characters that break naive quoting in shell, JSON, UCI and HTML. */
var SECRET = 'Se cr,e"t\'$x\\`1<b>';
var HOSTILE = '<img src=x onerror=window.__pwned=1>';

var playwright;
try { playwright = require('playwright-core'); }
catch (e) { console.error('playwright-core is not installed. Run: npm install --no-save playwright-core'); process.exit(2); }

var fail = 0;
function ok(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); return cond; }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function docker(args, input) { return cp.execFileSync('docker', args, { input: input, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] }); }
function router(script) { return docker([ 'exec', '-i', NAME, 'sh', '-s' ], script); }
function uciGet(k) { return router('uci -q get ' + k + ' || true').replace(/\n$/, ''); }
function get(url) {
	return new Promise(function(resolve, reject) { http.get(url, function(res) { res.resume(); resolve(res.statusCode); }).on('error', reject); });
}
async function waitFor(fn, ms) {
	for (var t = 0; t < ms; t += 500) { if (await fn()) return true; await sleep(500); }
	return false;
}

(async function() {
	var browser, replies = [], problems = [];
	fs.mkdirSync(SHOTS, { recursive: true });
	try {
		docker([ 'build', '-q', '--platform', 'linux/amd64', '-t', IMAGE, path.join(ROOT, 'tests', 'openwrt') ]);
		try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* not running */ }
		try { docker([ 'volume', 'rm', VOL ]); } catch (e) { /* none */ }
		docker([ 'run', '-d', '--platform', 'linux/amd64', '--name', NAME, '--hostname', 'rbweb', '-p', '127.0.0.1:' + PORT + ':80',
			'-v', VOL + ':/mnt/usb',
			'-v', path.join(ROOT, 'luci-app-redbook') + ':/pkg:ro', '-v', path.join(ROOT, 'tests') + ':/tests:ro', IMAGE, '/sbin/init' ]);
		for (var i = 0; i < 100; i++) {
			try { if (await get(WEB + '/cgi-bin/luci/')) break; } catch (e) { /* not up yet */ }
			await sleep(300);
		}
		router([
			'set -e',
			'mkdir -p /var/state && touch /var/state/dnsmasqsec',
			'cp -R /pkg/root/. /',
			'cp -R /pkg/htdocs/. /www/',
			'chmod 755 /usr/bin/redbook /usr/libexec/rpcd/luci.redbook /etc/init.d/redbook',
			'chmod 600 /etc/config/redbook_auth',
			'uci set redbook.main.usb_path=/mnt/usb && uci set redbook.main.flush_minutes=15 && uci commit redbook',
			'sh /etc/uci-defaults/80_redbook',
			/* The GL panel stand-in, served by uhttpd. */
			'mkdir -p /www/gl && cp /tests/gl/panel.html /www/gl/panel.html',
			'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc',
			'printf "' + ROOT_PW + '\\n' + ROOT_PW + '\\n" | passwd root >/dev/null 2>&1',
			'sleep 2',
			'logger -p user.notice "rbweb-line-1 hello"',
			'logger -p user.notice "rbweb-hostile ' + HOSTILE + '"',
			'sleep 1',
			'/usr/bin/redbook flush >/dev/null 2>&1 || true'
		].join('\n'));

		/* The collector reads logd on its own time: wait until both test lines
		   are kept, or the viewer checks below can pass (or fail) on a page
		   that does not hold the hostile line yet. */
		ok(await waitFor(function() {
			var s = router('/usr/bin/redbook lines system 50 rbweb');
			return s.indexOf('rbweb-line-1') >= 0 && s.indexOf('rbweb-hostile') >= 0;
		}, 30000), 'both test lines are collected');

		browser = await playwright.chromium.launch(process.env.APP_CHROME ? { executablePath: process.env.APP_CHROME } : { channel: 'chrome' });
		var page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		page.on('response', function(res) {
			if (/\/(cgi-bin|ubus)/.test(res.url()))
				replies.push(Promise.race([ res.text().catch(function() { return ''; }), sleep(5000).then(function() { return ''; }) ]));
		});

		/* ------------------------------------------------------------ LuCI */
		await page.goto(WEB + '/cgi-bin/luci/');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		/* Script errors count from here on (the login page answers 403). */
		page.on('pageerror', function(e) { problems.push('page error: ' + e.message); });
		page.on('console', function(m) { if (m.type() === 'error') problems.push('console: ' + m.text()); });

		await page.goto(WEB + '/cgi-bin/luci/admin/services/redbook/overview');
		await page.waitForSelector('text=Read a log', { timeout: 15000 });
		ok(await page.isVisible('text=Writing to the USB drive at /mnt/usb'), 'LuCI Overview says where the logs go');
		ok(await page.isVisible('td >> text=System log') && await page.isVisible('text=yes, from Info up'), 'LuCI Overview lists the logs and what is kept');
		await page.selectOption('#redbook-source', 'system');
		await page.fill('#redbook-filter', 'rbweb');
		await page.click('text=Show');
		await page.waitForSelector('#redbook-lines >> text=rbweb-line-1 hello', { timeout: 15000 });
		var pre = await page.textContent('#redbook-lines');
		ok(pre.indexOf(HOSTILE) >= 0 && (await page.$$('#redbook-lines img')).length === 0, 'LuCI Overview shows a log line with markup as text');
		ok(!(await page.evaluate(function() { return window.__pwned; })), 'nothing from a log line ran');
		await page.screenshot({ path: path.join(SHOTS, 'luci-overview.png'), fullPage: true });

		await page.goto(WEB + '/cgi-bin/luci/admin/services/redbook/settings');
		await page.waitForSelector('select[id$=".compress"]', { timeout: 15000 });
		await page.selectOption('select[id$=".compress"]', 'xz');
		ok(!(await page.isVisible('[data-name="net_server"]')), 'LuCI Settings hides the network folder while it is not used');
		await page.click('.cbi-value[data-name="backup"] input[type=checkbox]');
		await page.click('.cbi-tabmenu li[data-tab="network"] a');
		await page.waitForSelector('[data-name="net_server"] input', { state: 'visible', timeout: 5000 });
		ok(await page.isVisible('text=Test the saved settings'), 'LuCI Settings shows the network folder and its Test button once the copy is on');
		await page.fill('[data-name="net_server"] input', '192.0.2.20');
		await page.fill('[data-name="net_share"] input', 'logs');
		await page.fill('[data-name="_net_password"] input', SECRET);
		await page.click('.cbi-tabmenu li[data-tab="sources"] a');
		await page.click('.cbi-value[data-name="src_dns"] input[type=checkbox]');
		ok(await page.isVisible('text=Shows what every device on your network does'), 'LuCI Settings warns about what the DNS log shows');
		await page.click('.cbi-tabmenu li[data-tab="syslog"] a');
		await page.click('.cbi-value[data-name="syslog_send"] input[type=checkbox]');
		await page.fill('[data-name="syslog_server"] input', '192.0.2.30');
		ok(await page.isVisible('text=imudp') && await page.isVisible('text=syslog-ng'), 'LuCI Settings shows configs for the syslog server');
		await page.screenshot({ path: path.join(SHOTS, 'luci-settings-syslog.png'), fullPage: true });
		/* "Save" only stages the change in the session; "Save & Apply"
		 * commits it, then the page must stay open until LuCI confirms:
		 * leave earlier and rpcd rolls the change back about 90 s later. */
		await page.click('.cbi-page-actions .cbi-button-apply');
		await page.waitForSelector('text=Password saved', { timeout: 15000 });
		await page.waitForSelector('text=Configuration changes applied', { timeout: 120000 });
		ok(uciGet('redbook.main.compress') === 'xz' && uciGet('redbook.main.backup') === '1', 'LuCI Settings saves the storage tab');
		ok(uciGet('redbook.main.net_server') === '192.0.2.20' && uciGet('redbook.main.net_share') === 'logs', 'LuCI Settings saves the network folder');
		ok(uciGet('redbook.main.src_dns') === '1' && uciGet('redbook.main.syslog_server') === '192.0.2.30', 'LuCI Settings saves the logs and syslog tabs');
		ok(uciGet('redbook_auth.main.net_password') === SECRET, 'LuCI Settings saves the password exactly, quoting characters and all');
		ok(await waitFor(function() { return uciGet('system.@system[0].log_ip') === '192.0.2.30'; }, 40000), 'after Save & Apply, the router sends its log to the syslog server');
		await page.reload();
		await page.waitForSelector('select[id$=".compress"]', { timeout: 15000 });
		await page.click('.cbi-tabmenu li[data-tab="network"] a');
		ok((await page.inputValue('[data-name="_net_password"] input')) === '', 'LuCI Settings never fills the saved password back in');
		await page.screenshot({ path: path.join(SHOTS, 'luci-settings-network.png'), fullPage: true });

		/* ---------------------------------------------- GL panel stand-in */
		router('uci set redbook.main.syslog_send=0; uci set redbook.main.src_dns=0; uci commit redbook');
		await page.goto(WEB + '/gl/panel.html');
		var frame = null;
		for (i = 0; i < 50 && !frame; i++) {
			frame = page.frames().find(function(f) { return f !== page.mainFrame(); });
			await sleep(200);
		}
		ok(!!frame, 'GL panel: the view file shows the app in a frame');
		await frame.waitForSelector('text=Read a log', { timeout: 15000 });
		ok(await frame.isVisible('text=Writing to the USB drive at /mnt/usb'), 'GL panel: the LuCI Overview runs inside the panel');
		ok(await page.textContent('#menu-label') === 'Red Book', 'GL panel: the menu label comes from the i18n file');
		await frame.selectOption('#redbook-source', 'system');
		await frame.click('text=Show');
		await frame.waitForSelector('#redbook-lines >> text=rbweb-line-1', { timeout: 15000 });
		ok((await frame.textContent('#redbook-lines')).indexOf(HOSTILE) >= 0 && (await frame.$$('#redbook-lines img')).length === 0, 'GL panel: the log viewer shows lines as text');
		await page.screenshot({ path: path.join(SHOTS, 'gl-overview.png'), fullPage: true });

		await frame.click('button[data-page=settings]');
		await frame.waitForSelector('#app-f-compress', { timeout: 15000 });
		await frame.selectOption('#app-f-compress', 'none');
		ok(await frame.isVisible('#app-f-net_server'), 'GL panel: the network folder shows while the copy is on');
		await frame.uncheck('#app-f-backup');
		ok(!(await frame.isVisible('#app-f-net_server')), 'GL panel: and hides once it is off');
		await frame.check('#app-f-backup');
		await frame.fill('#app-f-net_server', '192.0.2.21');
		await frame.fill('#app-f-system_days', '99999');
		await frame.click('button[type=submit]');
		await frame.waitForSelector('text=some values need fixing', { timeout: 5000 });
		ok(await frame.isVisible('text=A number of days from 1 to 3650'), 'GL panel: a value out of range is refused, with the reason');
		await frame.fill('#app-f-system_days', '120');
		await frame.fill('#app-f-net_password', SECRET + '2');
		await frame.click('button[type=submit]');
		await frame.waitForSelector('text=Settings saved', { timeout: 15000 });
		ok(uciGet('redbook.main.compress') === 'none' && uciGet('redbook.main.system_days') === '120', 'GL panel: Settings saves through the Lua module');
		ok(uciGet('redbook.main.net_server') === '192.0.2.21', 'GL panel: Settings saves the network folder');
		ok(uciGet('redbook_auth.main.net_password') === SECRET + '2', 'GL panel: Settings saves the password, quoting characters and all');
		ok(router('cat /tmp/gl-rpc-spawn.log 2>/dev/null').indexOf('cr,e') < 0, 'GL panel: the password was never a command argument');
		/* On GL firmware, no NFS install: a note says why. */
		router('echo 4.10.1 > /etc/glversion');
		/* Settings again: it redraws with a fresh status (wait for the note,
		   or this looks at the old page before the redraw). */
		await frame.click('button[data-page=settings]');
		await frame.waitForSelector('text=GL\'s own NFS kernel modules crashed', { state: 'attached', timeout: 15000 });
		await frame.check('#app-f-backup');
		ok(!(await frame.isVisible('text=Install NFS support')) && await frame.isVisible('text=GL\'s own NFS kernel modules crashed'), 'GL panel: on GL firmware NFS is not offered for install, and the page says why');
		router('rm -f /etc/glversion');
		await frame.uncheck('#app-f-backup');
		await page.screenshot({ path: path.join(SHOTS, 'gl-settings.png'), fullPage: true });
		await page.goto(WEB + '/gl/panel.html?theme=dark');
		await sleep(2500);
		await page.screenshot({ path: path.join(SHOTS, 'gl-overview-dark.png'), fullPage: true });

		var all = (await Promise.all(replies)).join('\n');
		ok(all.indexOf('cr,e') < 0 && all.indexOf('Se cr') < 0, 'the password never came back to the browser in any reply');
		ok(problems.length === 0, 'no script errors' + (problems.length ? ': ' + problems.join(' | ') : ''));
	} catch (e) {
		ok(false, 'the test ran to the end: ' + (e.stack || e));
	} finally {
		if (browser) await browser.close();
		if (process.env.APP_KEEP) console.log('container left running: ' + WEB + ' (root / ' + ROOT_PW + '); remove with: docker rm -f ' + NAME);
		else {
			try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* gone */ }
			try { docker([ 'volume', 'rm', VOL ]); } catch (e) { /* gone */ }
		}
	}
	console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
	process.exit(fail ? 1 : 0);
})();
