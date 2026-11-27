/*
 * The settings are described once, in the schema in common.js; this holds
 * everything else to it:
 *   - LuCI's settings.js offers exactly the schema's settings (it is run
 *     here against a stand-in for LuCI's form and the options are counted)
 *   - the GL panel's form is drawn from the schema and knows every type
 *   - the panel module's FIELDS accept exactly those settings, with the
 *     same choices and levels
 *   - /etc/config/redbook holds the schema's defaults
 *   - the backend, the panel module and the pages list the same sources
 *   - every .format() string writes a literal percent as %%
 *   - the program reports the package version
 * Run: node tests/settings.test.js
 */
var fs = require('fs'), path = require('path');
var PKG = path.join(__dirname, '..', 'luci-app-redbook');
var read = function(p) { return fs.readFileSync(path.join(PKG, p), 'utf8'); };
var fail = 0;
function eq(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want), good = g === w;
	if (!good) fail++;
	console.log((good ? 'ok   ' : 'FAIL ') + name + (good ? '' : ' (got ' + g + ', expected ' + w + ')'));
}
function sorted(a) { return a.slice().sort(); }

/* ------------------------------------------------------------- schema */
global._ = function(s) { return s; };
String.prototype.format = function() { var a = arguments, i = 0; return this.replace(/%(\.\d+)?[sdf%]/g, function(m) { return m === '%%' ? '%' : String(a[i++]); }); };
var app = new Function('baseclass', 'rpc', read('htdocs/luci-static/resources/redbook/common.js'))(
	{ extend: function(o) { return o; } },
	{ declare: function() { return function() { return Promise.resolve({}); }; } });
var schema = app.schema();
var keys = schema.filter(function(f) { return f.type !== 'password'; }).map(function(f) { return f.key; });

/* -------------------------------------------------------------- LuCI */
var luci = [];
function Option(name) { this.name = name; }
Option.prototype.value = function() {};
Option.prototype.depends = function() {};
var form = {
	Map: function() {
		this.section = function() {
			return {
				tab: function() {},
				taboption: function(tab, cls, name) { if (!cls) throw new Error('no form class for ' + name); luci.push(name); return new Option(name); }
			};
		};
		this.render = function() { return Promise.resolve(); };
		this.lookupOption = function() { return []; };
	}
};
[ 'Flag', 'ListValue', 'Value', 'DummyValue' ].forEach(function(c) { form[c] = c; });
var settings = new Function('view', 'form', 'ui', 'uci', 'app', read('htdocs/luci-static/resources/view/redbook/settings.js'))(
	{ extend: function(o) { return o; } }, form, {}, { get: function() {} }, app);
settings.render([ {}, { drives: [ { path: '/mnt/usb', free_kb: 1 } ] } ]);
eq(sorted(luci.filter(function(n) { return n.charAt(0) !== '_'; })), sorted(keys), 'LuCI Settings offers exactly the schema\'s settings');
eq(luci.indexOf('_net_password') >= 0, true, 'LuCI Settings has the write-only password field');

/* ------------------------------------------------------------ GL form */
var gl = read('htdocs/luci-static/resources/redbook/gl.js');
eq(/app\.schema\(\)/.test(gl), true, 'the GL panel form is drawn from the schema');
var types = sorted(Array.from(new Set(schema.map(function(f) { return f.type; }))));
eq(types.filter(function(t) { return gl.indexOf("'" + t + "'") < 0; }), [], 'the GL panel form handles every field type in the schema');

/* ------------------------------------------------- the panel module */
var lua = read('root/usr/lib/oui-httpd/rpc/redbook');
var luaList = function(name) {
	var m = new RegExp('local ' + name + ' = \\{([^}]*)\\}').exec(lua);
	return m ? (m[1].match(/"[^"]*"/g) || []).map(function(s) { return s.slice(1, -1); }) : null;
};
var luaSources = luaList('SOURCES'), luaLevels = luaList('LEVELS');
var leveled = Object.keys(eval('(' + /local LEVELED = (\{[^}]*\})/.exec(lua)[1].replace(/(\w+) = /g, '"$1": ') + ')'));
var fields = (/local FIELDS = \{\n([\s\S]*?)\n\}/.exec(lua)[1].match(/^    (\w+) = \{/gm) || []).map(function(l) { return l.trim().split(' ')[0]; });
luaSources.forEach(function(s) { fields.push('src_' + s, s + '_days'); if (leveled.indexOf(s) >= 0) fields.push(s + '_level'); });
eq(sorted(fields), sorted(keys), 'the GL panel module accepts exactly the schema\'s settings');
var choices = {}, cm = /local CHOICES = \{\n([\s\S]*?)\n\}/.exec(lua)[1];
cm.split('\n').forEach(function(l) {
	var m = /^\s*(\w+) = \{([^}]*)\}/.exec(l);
	if (m) choices[m[1]] = sorted((m[2].match(/"[^"]*"/g) || []).map(function(s) { return s.slice(1, -1); }));
});
schema.filter(function(f) { return f.type === 'select' && !f.source; }).forEach(function(f) {
	eq(choices[f.key] || null, sorted(f.options.map(function(o) { return o[0]; }).filter(function(v) { return v !== ''; })),
		'the panel module allows the same choices for ' + f.key);
});
eq(luaLevels, app.LEVELS.map(function(l) { return l[0]; }), 'the panel module allows the same levels');
eq(sorted(leveled), sorted(app.SOURCES.filter(function(s) { return s.level; }).map(function(s) { return s.id; })), 'the same sources have a level everywhere');

/* ------------------------------------------------------- defaults */
var conf = {};
read('root/etc/config/redbook').split('\n').forEach(function(l) {
	var m = /^\s*option (\w+) '([^']*)'/.exec(l);
	if (m) conf[m[1]] = m[2];
});
var want = {};
schema.forEach(function(f) { if (f.def != null && f.type !== 'password') want[f.key] = f.def; });
eq(Object.keys(want).filter(function(k) { return conf[k] !== want[k]; }).map(function(k) { return k + '=' + conf[k] + ' (schema: ' + want[k] + ')'; }), [],
	'/etc/config/redbook holds the schema\'s defaults');

/* -------------------------------------------------------- sources */
var backend = read('root/usr/bin/redbook');
var bsrc = /^SOURCES='([^']*)'/m.exec(backend)[1].split(' ');
eq(bsrc, app.SOURCES.map(function(s) { return s.id; }), 'the backend lists the same sources, in the same order');
eq(luaSources, bsrc, 'the panel module lists the same sources');
var bdefault = function(fn) {
	var body = new RegExp(fn + '\\(\\) \\{ case \\$1 in ([^}]*)\\}').exec(backend)[1];
	return function(id) {
		var parts = body.split(';;');
		for (var i = 0; i < parts.length; i++) {
			var m = /^\s*([^)]+)\) echo (\S+)/.exec(parts[i]);
			if (m && (m[1] === '*' || m[1].split('|').indexOf(id) >= 0)) return m[2];
		}
	};
};
var don = bdefault('default_on'), ddays = bdefault('default_days'), dlevel = bdefault('default_level');
eq(app.SOURCES.filter(function(s) { return don(s.id) !== (s.on ? '1' : '0') || ddays(s.id) !== String(s.days) || (s.level && dlevel(s.id) !== s.level); }).map(function(s) { return s.id; }), [],
	'the backend falls back to the same defaults as the pages');

/* ------------------------------------------------------ .format() */
var bad = [];
[ 'htdocs/luci-static/resources/redbook/common.js', 'htdocs/luci-static/resources/redbook/gl.js',
  'htdocs/luci-static/resources/view/redbook/overview.js', 'htdocs/luci-static/resources/view/redbook/settings.js' ].forEach(function(f) {
	var src = read(f), re = /'((?:[^'\\]|\\.)*)'\s*\)?\s*\.format\(/g, m;
	while ((m = re.exec(src))) {
		var rest = m[1].replace(/%(%|s|d|h|\.\d+f)/g, '');
		if (rest.indexOf('%') >= 0) bad.push(path.basename(f) + ': ' + m[1]);
	}
});
eq(bad, [], 'every .format() string writes a literal percent as %%');

var version = /^PKG_VERSION:=(.*)$/m.exec(read('Makefile'))[1];
eq(/^VERSION=(\S+)/m.exec(backend)[1], version, 'the program reports the package version');
console.log(fail ? '\n' + fail + ' check(s) failed' : '\nall checks passed');
process.exit(fail ? 1 : 0);
