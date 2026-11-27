'use strict';
'require baseclass';
'require rpc';

/*
 * Red Book - what the LuCI pages and the GL.iNet panel page share.
 * The calls go to the rpcd object luci.redbook in LuCI; in the GL panel,
 * gl.js stands in for 'rpc' and sends them to the panel's Lua module.
 *
 * schema() is every setting, once: LuCI's settings.js and the GL panel's
 * form (gl.js) are both drawn from it, and tests/settings.test.js holds it
 * together with FIELDS in the panel module and /etc/config/redbook.
 *
 * Strings passed to .format(): LuCI's String.prototype.format reads a "%"
 * followed by a space or one of "b c o q t m u x X j" as a conversion, so
 * write a literal percent sign as "%%".
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.redbook', method: 'status', expect: { '': {} } });
var callLines = rpc.declare({ object: 'luci.redbook', method: 'lines', params: [ 'source', 'count', 'filter' ], expect: { '': {} } });
var callDrives = rpc.declare({ object: 'luci.redbook', method: 'drives', expect: { '': {} } });
var callFlush = rpc.declare({ object: 'luci.redbook', method: 'flush', expect: { '': {} } });
var callTestNetwork = rpc.declare({ object: 'luci.redbook', method: 'test_network', expect: { '': {} } });
var callInstallSupport = rpc.declare({ object: 'luci.redbook', method: 'install_support', params: [ 'type' ], expect: { '': {} } });
var callSetSecret = rpc.declare({ object: 'luci.redbook', method: 'set_secret', params: [ 'secret' ], expect: { '': {} } });

/* The log sources, in the order the pages show them. Keep the ids in step
 * with SOURCES in the backend and the panel module; the defaults are those
 * in /etc/config/redbook (tests/settings.test.js checks). */
var SOURCES = [
	{ id: 'system', label: _('System log'), on: true, level: 'info', days: 90,
	  desc: _('Messages from the router\'s services: Wi-Fi joins and leaves, DHCP, logins, VPN and the rest of the system log.') },
	{ id: 'kernel', label: _('Kernel log'), on: true, level: 'info', days: 90,
	  desc: _('Drivers, Wi-Fi firmware, USB and network ports. The whole kernel log since start is also saved once after each start.') },
	{ id: 'crash', label: _('Crash records'), on: true, days: 365,
	  desc: _('Kernel crash records the router keeps in flash across restarts. Saved when a new one appears.') },
	{ id: 'boots', label: _('Restarts'), on: true, days: 365,
	  desc: _('When the router started, when it was last seen before that, and whether it shut down cleanly.') },
	{ id: 'health', label: _('System health'), on: true, days: 90,
	  desc: _('Every 5 minutes: load, free memory, temperature, number of connections and uptime.') },
	{ id: 'web', label: _('Web server errors'), on: true, level: 'warn', days: 90,
	  desc: _('Errors from the web server behind the admin panel and LuCI, such as failed logins and broken requests.') },
	{ id: 'mesh', label: _('Mesh logs'), on: false, level: 'warn', days: 30,
	  desc: _('The mesh controller and agent. GL firmware repeats a few errors several times a second: each message is kept once per 10 minutes, with a count of its repeats. Even so, expect a few MB a day.') },
	{ id: 'dns', label: _('DNS queries'), on: false, days: 30, privacy: true,
	  desc: _('Every name each device looks up. While this is on, Red Book turns on query logging in dnsmasq; the router\'s own log in memory then holds fewer hours.') },
	{ id: 'firewall', label: _('Firewall blocks'), on: false, days: 30, privacy: true,
	  desc: _('Packets the firewall dropped or rejected, in every zone except LAN (at most 10 a minute per rule). While this is on, Red Book turns on logging in those zones.') },
	{ id: 'conn', label: _('Connections'), on: false, days: 30, privacy: true,
	  desc: _('Every new connection through the router: device, destination and port.') }
];

var LEVELS = [
	[ 'emerg', _('Emergency') ], [ 'alert', _('Alert') ], [ 'crit', _('Critical') ], [ 'err', _('Error') ],
	[ 'warn', _('Warning') ], [ 'notice', _('Notice') ], [ 'info', _('Info') ], [ 'debug', _('Debug (everything)') ]
];

var PRIVACY = _('Shows what every device on your network does. Anyone who can read the drive or the network folder can see it; the files are not encrypted.');

/* Every setting. type: flag | select | text | password. depends: a list of
 * conditions, any of which shows the field ({ key: value } must all hold).
 * tab: storage | network | sources | syslog. The password is kept apart
 * (set_secret), never loaded into a page. */
function schema() {
	var netShown = [ { storage: 'network' }, { storage: 'usb', backup: '1' } ];
	var f = [
		{ tab: 'storage', key: 'enabled', type: 'flag', def: '1', label: _('Record logs') },
		{ tab: 'storage', key: 'storage', type: 'select', def: 'usb', label: _('Write the logs to'),
		  options: [ [ 'usb', _('USB drive') ], [ 'network', _('Network folder') ] ] },
		{ tab: 'storage', key: 'usb_path', type: 'text', optional: true, kind: 'path', depends: [ { storage: 'usb' } ],
		  label: _('Folder on the drive'), placeholder: _('the first USB drive'),
		  desc: _('Leave empty for the first USB drive. The logs go in redbook/<router name>/ inside it.') },
		{ tab: 'storage', key: 'backup', type: 'flag', def: '0', depends: [ { storage: 'usb' } ],
		  label: _('Also copy to the network folder'), desc: _('A second copy, made after each write. Set up the folder on the Network folder tab.') },
		{ tab: 'storage', key: 'compress', type: 'select', def: 'gzip', label: _('Compress finished days'),
		  options: [ [ 'gzip', _('gzip') ], [ 'xz', _('xz (smaller, slower)') ], [ 'none', _('No') ] ],
		  desc: _('Ext4 and most drives cannot compress a folder by themselves, so Red Book compresses each day once it is over. Read them with zcat or 7-Zip.') },
		{ tab: 'storage', key: 'flush_minutes', type: 'select', def: '1', label: _('Write to the storage every'),
		  options: [ [ '1', _('minute') ], [ '5', _('5 minutes') ], [ '15', _('15 minutes') ] ],
		  desc: _('Lines wait in memory until then; a power cut loses at most this much.') },

		{ tab: 'network', key: 'net_type', type: 'select', def: 'smb', depends: netShown, label: _('Kind'),
		  options: [ [ 'smb', _('Windows / Samba share (SMB)') ], [ 'nfs', _('NFS export') ] ] },
		{ tab: 'network', key: 'net_server', type: 'text', optional: true, kind: 'host', depends: netShown,
		  label: _('Server'), placeholder: '192.168.8.10' },
		{ tab: 'network', key: 'net_share', type: 'text', optional: true, kind: 'share', depends: netShown,
		  label: _('Share or export'), placeholder: _('logs  or  /volume1/logs'),
		  desc: _('The share name for SMB, the exported path for NFS.') },
		{ tab: 'network', key: 'net_folder', type: 'text', optional: true, kind: 'folder', depends: netShown,
		  label: _('Folder inside it'), placeholder: _('(the top of the share)') },
		{ tab: 'network', key: 'net_user', type: 'text', optional: true, kind: 'user',
		  depends: [ { storage: 'network', net_type: 'smb' }, { storage: 'usb', backup: '1', net_type: 'smb' } ],
		  label: _('User name'), placeholder: _('(guest)') },
		{ tab: 'network', key: 'net_password', type: 'password',
		  depends: [ { storage: 'network', net_type: 'smb' }, { storage: 'usb', backup: '1', net_type: 'smb' } ],
		  label: _('Password') },
		{ tab: 'network', key: 'net_smbver', type: 'select', optional: true,
		  depends: [ { storage: 'network', net_type: 'smb' }, { storage: 'usb', backup: '1', net_type: 'smb' } ],
		  label: _('SMB version'), options: [ [ '', _('Automatic') ], [ '3.1.1', '3.1.1' ], [ '3.0', '3.0' ], [ '2.1', '2.1' ], [ '2.0', '2.0' ], [ '1.0', _('1.0 (old devices only)') ] ] }
	];
	SOURCES.forEach(function(s) {
		f.push({ tab: 'sources', key: 'src_' + s.id, type: 'flag', def: s.on ? '1' : '0', label: s.label, desc: s.desc, privacy: !!s.privacy });
		if (s.level)
			f.push({ tab: 'sources', key: s.id + '_level', type: 'select', def: s.level, depends: [ dep('src_' + s.id, '1') ],
			  label: _('Lowest level kept'), options: LEVELS, source: s.id });
		f.push({ tab: 'sources', key: s.id + '_days', type: 'text', def: String(s.days), kind: 'days', depends: [ dep('src_' + s.id, '1') ],
		  label: _('Keep for (days)'), source: s.id });
	});
	f.push(
		{ tab: 'syslog', key: 'syslog_send', type: 'flag', def: '0', label: _('Also send the system log to a syslog server'),
		  desc: _('The router\'s own log daemon sends every line as it happens (it does not need a drive). Red Book sets this up and puts it back when turned off.') },
		{ tab: 'syslog', key: 'syslog_server', type: 'text', optional: true, kind: 'host', depends: [ { syslog_send: '1' } ],
		  label: _('Syslog server'), placeholder: '192.168.8.10' },
		{ tab: 'syslog', key: 'syslog_port', type: 'text', def: '514', kind: 'port', depends: [ { syslog_send: '1' } ], label: _('Port') },
		{ tab: 'syslog', key: 'syslog_proto', type: 'select', def: 'udp', depends: [ { syslog_send: '1' } ], label: _('Protocol'),
		  options: [ [ 'udp', _('UDP') ], [ 'tcp', _('TCP') ] ] }
	);
	return f;
}

function dep(k, v) { var o = {}; o[k] = v; return o; }

var TABS = [ [ 'storage', _('Storage') ], [ 'network', _('Network folder') ], [ 'sources', _('Logs to keep') ], [ 'syslog', _('Syslog server') ] ];

/* Checks the pages make before saving (the router checks again). The same
 * rules as the backend and the panel module. */
var KINDS = {
	path: [ /^\/[A-Za-z0-9._\/-]*$/, _('An absolute folder such as /tmp/mountd/disk1_part1 (letters, digits and . _ - / only).') ],
	host: [ /^[A-Za-z0-9.:][A-Za-z0-9.:-]*$/, _('A host name or an IP address.') ],
	share: [ /^[A-Za-z0-9._\/$ ][A-Za-z0-9._\/$ -]*$/, _('Letters, digits, spaces and . _ - / $ only.') ],
	folder: [ /^[A-Za-z0-9._ -][A-Za-z0-9._\/ -]*$/, _('A folder such as routers/home (letters, digits, spaces and . _ - / only; not starting with /).') ],
	user: [ /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/, _('Letters, digits and . _ - @ only.') ],
	days: [ /^[0-9]{1,4}$/, _('A number of days from 1 to 3650.'), 1, 3650 ],
	port: [ /^[0-9]{1,5}$/, _('A port from 1 to 65535.'), 1, 65535 ]
};
function checkValue(f, v) {
	v = String(v == null ? '' : v).trim();
	if (v === '') return f.optional || f.type === 'flag' || f.type === 'select' ? true : _('This cannot be empty.');
	var k = KINDS[f.kind];
	if (!k) return true;
	if (!k[0].test(v) || v.indexOf('..') >= 0) return k[1];
	if (k[2] != null && (+v < k[2] || +v > k[3])) return k[1];
	return true;
}
/* Is field f shown, given the current values? */
function shown(f, values) {
	if (!f.depends) return true;
	return f.depends.some(function(d) {
		return Object.keys(d).every(function(k) { return String(values[k] == null ? '' : values[k]) === d[k]; });
	});
}

/* Why the storage, the backup copy or a test failed, in words. */
var REASONS = {
	no_drive: _('No USB drive is plugged in (or the folder is not on one). Lines wait in memory until it is back.'),
	bad_path: _('The folder on the drive is not allowed (letters, digits and . _ - / only). Nothing is written until it is fixed.'),
	not_writable: _('The folder cannot be written to (read-only, or no permission).'),
	full: _('Less than 50 MB is free. Nothing more is written until there is room.'),
	write_failed: _('Writing failed part way. The rest waits in memory and is tried again.'),
	waiting_clock: _('Waiting for the router\'s clock to be set from the internet, so that lines get the right day.'),
	not_set: _('The network folder is not set up yet (server and share).'),
	no_support: _('The router cannot use this kind of network folder yet: install support for it below.'),
	login_refused: _('The server refused the user name or password.'),
	share_not_found: _('The server has no share or export by that name.'),
	unreachable: _('The server cannot be reached.'),
	refused: _('The server refused the connection.'),
	timeout: _('The server did not answer in time.'),
	version_mismatch: _('The server does not speak that SMB version: try another one, or Automatic.'),
	copy_failed: _('Copying to the network folder failed part way; it is tried again at the next write.'),
	mount_failed: _('The network folder could not be mounted.')
};
/* What a log needs that this router lacks. */
var MISSING = {
	conntrack: _('this router has no conntrack program (install the conntrack package)'),
	mesh: _('this router has no mesh logs'),
	web_log: _('the web server has written no error log yet')
};
function missingText(m) { return MISSING[m] || m; }

function reasonText(r) { return REASONS[r] || (r ? _('Failed (%s).').format(r) : ''); }

function size(bytes) {
	var b = +bytes || 0;
	if (b < 1024) return _('%d bytes').format(b);
	if (b < 1048576) return _('%.1f KB').format(b / 1024);
	if (b < 1073741824) return _('%.1f MB').format(b / 1048576);
	return _('%.2f GB').format(b / 1073741824);
}

function when(ts) {
	var d = new Date(+ts * 1000);
	return !ts || isNaN(d) ? '' : d.toLocaleString();
}

function sourceLabel(id) {
	for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i].label;
	return id;
}

/* Configs for the machine that receives the router's log (the syslog
 * server setting). st: the status reply. */
function syslogConfigs(st, values) {
	var ip = (st && st.lan_ip) || '192.168.8.1', host = (st && st.host) || 'router';
	var port = (values && values.syslog_port) || '514', tcp = values && values.syslog_proto === 'tcp';
	return [
		{ name: 'rsyslog', file: '/etc/rsyslog.d/30-' + host + '.conf', text: [
			'# Receive the log of ' + host + ' (' + ip + ') and keep one file per day.',
			tcp ? 'module(load="imtcp")' : 'module(load="imudp")',
			tcp ? 'input(type="imtcp" port="' + port + '")' : 'input(type="imudp" port="' + port + '")',
			'template(name="RouterDaily" type="string" string="/var/log/routers/%HOSTNAME%/%$YEAR%-%$MONTH%-%$DAY%.log")',
			'if $fromhost-ip == \'' + ip + '\' then {',
			'    action(type="omfile" dynaFile="RouterDaily" createDirs="on")',
			'    stop',
			'}' ].join('\n') },
		{ name: 'syslog-ng', file: '/etc/syslog-ng/conf.d/' + host + '.conf', text: [
			'# Receive the log of ' + host + ' (' + ip + ') and keep one file per day.',
			'source s_' + host.replace(/[^A-Za-z0-9_]/g, '_') + ' { network(transport("' + (tcp ? 'tcp' : 'udp') + '") port(' + port + ')); };',
			'filter f_' + host.replace(/[^A-Za-z0-9_]/g, '_') + ' { netmask("' + ip + '/32"); };',
			'destination d_routers { file("/var/log/routers/${HOST}/${YEAR}-${MONTH}-${DAY}.log" create-dirs(yes)); };',
			'log { source(s_' + host.replace(/[^A-Za-z0-9_]/g, '_') + '); filter(f_' + host.replace(/[^A-Za-z0-9_]/g, '_') + '); destination(d_routers); flags(final); };' ].join('\n') },
		{ name: _('classic syslogd'), file: '/etc/syslog.conf', text: [
			'# Start syslogd with -r (BSD: without -s) so it listens on UDP port 514, then:',
			'*.*    /var/log/' + host + '.log',
			'# Classic syslogd takes UDP on port 514 only.' ].join('\n') }
	];
}

return baseclass.extend({
	callStatus: callStatus,
	callLines: callLines,
	callDrives: callDrives,
	callFlush: callFlush,
	callTestNetwork: callTestNetwork,
	callInstallSupport: callInstallSupport,
	callSetSecret: callSetSecret,
	SOURCES: SOURCES,
	LEVELS: LEVELS,
	TABS: TABS,
	PRIVACY: PRIVACY,
	schema: schema,
	checkValue: checkValue,
	shown: shown,
	reasonText: reasonText,
	missingText: missingText,
	sourceLabel: sourceLabel,
	size: size,
	when: when,
	syslogConfigs: syslogConfigs
});
