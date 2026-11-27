/*
 * Red Book inside the GL.iNet admin panel (firmware 4.x).
 *
 * The panel's menu entry (/usr/share/oui/menu.d/redbook.json) loads
 * /views/gl-sdk4-ui-redbook.common.js, which shows this script in a frame
 * of its own, so nothing here can change how the panel itself looks or
 * works. The script runs the same Overview view as LuCI, with a small
 * stand-in for the parts of LuCI it uses, and reaches the router through
 * the panel's own login: window.parent.$request -> RPC object "redbook"
 * (/usr/lib/oui-httpd/rpc/redbook). Settings has a form of its own here.
 *
 * A view that starts using another LuCI API needs a stand-in here too.
 * As in LuCI, E() assigns a bare string child with innerHTML; pass text
 * from the router as an array child.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	var BASE = '/luci-static/resources/';
	var STAMP = Date.now();
	var APP = 'redbook';

	var host = null, frame = null;
	try {
		if (window.parent !== window && typeof window.parent.$request === 'function')
			host = window.parent;
		frame = window.frameElement;
	} catch (e) {}

	/* ---------------------------------------------------- LuCI stand-ins -- */

	window._ = function(s) { return s; };

	function escHTML(s) {
		return String(s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/* LuCI's String.prototype.format, for the conversions the views use. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufsh])/g, function(m, pad, left, width, prec, type) {
			if (type === '%') return '%';
			if (i >= args.length) return m;
			var v = args[i++];
			if (type === 'd' || type === 'u') v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f') v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else if (type === 'h') v = escHTML(v == null ? '' : v);
			else v = String(v);
			while (width && v.length < +width) v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	function append(node, c) {
		if (c == null || c === '') return;
		if (Array.isArray(c)) { c.forEach(function(x) { append(node, x); }); return; }
		node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	}

	/* E(tag, attrs, children): as LuCI's, a bare string child is HTML. */
	window.E = function(tag, attrs, data) {
		var el = document.createElement(tag), k;
		if (Array.isArray(attrs) || attrs instanceof Node || typeof attrs === 'string') { data = attrs; attrs = null; }
		for (k in attrs || {}) {
			var v = attrs[k];
			if (v == null) continue;
			if (typeof v === 'function') el.addEventListener(k, v);
			else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
			else el.setAttribute(k, v);
		}
		if (typeof data === 'string') el.innerHTML = data;
		else append(el, data);
		return el;
	};

	window.L = {
		bind: function(fn, self) { var a = [].slice.call(arguments, 2); return function() { return fn.apply(self, a.concat([].slice.call(arguments))); }; },
		url: function() { return '#'; }
	};

	var baseclass = { extend: function(o) { return o; } };

	var view = {
		extend: function(o) {
			o.super = function(name, args) { return Promise.resolve(); };
			return o;
		}
	};

	var polls = [];
	var poll = {
		add: function(fn, seconds) {
			polls.push(window.setInterval(function() { Promise.resolve(fn()).catch(function() {}); }, (seconds || 5) * 1000));
		}
	};

	function note(text, kind) {
		var box = document.getElementById('app-notes');
		var n = E('div', { 'class': 'app-note ' + (kind || 'info') }, [ text ]);
		box.appendChild(n);
		window.setTimeout(function() { n.remove(); }, 8000);
	}

	var ui = {
		addNotification: function(title, content, kind) { note(content, kind); },
		createHandlerFn: function(self, fn) {
			var args = [].slice.call(arguments, 2);
			return function(ev) {
				var btn = ev.currentTarget;
				btn.disabled = true;
				return Promise.resolve(fn.apply(self, args.concat([ ev ]))).finally(function() { btn.disabled = false; });
			};
		},
		showModal: function(title, children) {
			var m = document.getElementById('app-modal');
			m.replaceChildren(E('div', { 'class': 'app-modal-box' }, [ E('h3', {}, [ title ]) ].concat(children)));
			m.hidden = false;
		},
		hideModal: function() { document.getElementById('app-modal').hidden = true; }
	};

	/* One call to the router, through the panel's login. The panel rejects
	 * a reply that carries err_code or err_msg. */
	function call(method, params, seconds) {
		if (!host)
			return Promise.reject(new Error(_('This page only works inside the GL.iNet admin panel.')));
		return Promise.resolve(host.$request('call', [ 'sid', APP, method, params || {} ],
			{ timeout: (seconds || 60) * 1000, isCancel: false, ignoreCoreErrTips: true })).then(function(res) {
			if (res && res.err_code) throw Object.assign(new Error(res.err_msg || _('the router refused the request')), { field: res.field });
			return res;
		}, function(e) {
			throw Object.assign(new Error(e && (e.message || e.err_msg || e.type) || String(e)), { field: e && e.field });
		});
	}

	/* The views call the rpcd object luci.redbook; the panel module has the
	 * same methods, the ones the pages call often under names the panel
	 * does not write to its log ("get"). */
	var METHODS = { status: 'get_status', lines: 'get_lines', drives: 'get_drives' };
	var SECONDS = { lines: 70, test_network: 70 };
	var rpc = {
		declare: function(o) {
			var names = o.params || [];
			return function() {
				var args = arguments, p = {};
				names.forEach(function(n, i) { if (args[i] !== undefined) p[n] = args[i]; });
				return call(METHODS[o.method] || o.method, p, SECONDS[o.method]);
			};
		}
	};

	/* ------------------------------------------------------ module loader -- */

	var BUILTIN = { baseclass: baseclass, view: view, poll: poll, ui: ui, rpc: rpc };
	var modules = {};

	function requireModule(name) {
		if (BUILTIN[name]) return Promise.resolve(BUILTIN[name]);
		if (!new RegExp('^(view\\.)?' + APP + '\\.[a-z]+$').test(name))
			return Promise.reject(new Error(_('%s is not available in the GL.iNet panel').format(name)));
		if (!modules[name]) {
			var path = BASE + name.replace(/\./g, '/') + '.js';
			modules[name] = fetch(path + '?_t=' + STAMP, { credentials: 'same-origin', cache: 'no-store' }).then(function(r) {
				if (!r.ok) throw new Error(_('could not load %s (HTTP %d)').format(path, r.status));
				return r.text();
			}).then(function(src) { return instantiate(src, path); });
			modules[name].catch(function() { delete modules[name]; });
		}
		return modules[name];
	}

	/* LuCI modules start with 'require x as y'; lines: load those first and
	 * pass them in as arguments, as LuCI's loader does. */
	function instantiate(src, path) {
		var lines = src.split('\n'), reqs = [], m;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (line === '' || line === "'use strict';") continue;
			m = /^'require\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?'\s*;$/.exec(line);
			if (!m) break;
			reqs.push({ name: m[1], as: m[2] || m[1].split('.').pop() });
		}
		return Promise.all(reqs.map(function(r) { return requireModule(r.name); })).then(function(deps) {
			var fn = new Function(reqs.map(function(r) { return r.as; }).join(','), src + '\n//# sourceURL=' + path);
			return fn.apply(window, deps);
		});
	}

	/* -------------------------------------------------------------- theme -- */

	/* The panel's colours are CSS variables on its root element; copying
	 * them makes this page follow its light or dark theme. */
	var THEME = [ '--primary', '--primary-background', '--error', '--warning', '--success', '--text-title',
		'--text-regular', '--text-hint', '--background-card', '--background-content', '--border', '--divider' ];

	function syncTheme() {
		if (!host) return;
		try {
			var cs = host.getComputedStyle(host.document.documentElement), root = document.documentElement.style;
			THEME.forEach(function(v) {
				var x = cs.getPropertyValue(v).trim();
				if (x) root.setProperty(v, x); else root.removeProperty(v);
			});
			var font = host.getComputedStyle(host.document.body).fontFamily;
			if (font) root.setProperty('--font', font);
		} catch (e) {}
	}

	function watchTheme() {
		if (!host || !window.MutationObserver) return;
		try {
			var mo = new MutationObserver(function() { syncTheme(); setTimeout(syncTheme, 400); });
			mo.observe(host.document.head, { childList: true });
			window.addEventListener('pagehide', function() { mo.disconnect(); });
		} catch (e) {}
	}

	var CSS = [
		':root{--primary:#5272f7;--error:#e04c7e;--warning:#f5a623;--success:#00c8b5;--text-title:#1f1f3d;--text-regular:#141427;',
		'--text-hint:#b9b9bd;--background-card:#fff;--background-content:#ebebf0;--border:#d2d2d6;--divider:#ebebf0}',
		'body{margin:0;font-family:var(--font,Roboto,Arial,sans-serif);font-size:14px;color:var(--text-regular);background:transparent}',
		'.app-card{background:var(--background-card);border-radius:8px;padding:16px 20px;margin-bottom:16px}',
		'.app-tabs{display:flex;gap:8px;margin-bottom:12px}.app-tabs button{border:0;background:none;padding:6px 10px;cursor:pointer;color:var(--text-regular);border-bottom:2px solid transparent}',
		'.app-tabs button[aria-selected=true]{color:var(--primary);border-bottom-color:var(--primary)}',
		'h2,h3{color:var(--text-title)}.table{width:100%;border-collapse:collapse}.th,.td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--divider)}',
		'.cbi-button,button.app-btn{background:var(--primary);color:#fff;border:0;border-radius:4px;padding:6px 14px;cursor:pointer}',
		'.cbi-button:disabled{opacity:.5}label{display:block;margin:12px 0 4px}input,select{padding:6px;border:1px solid var(--border);border-radius:4px;',
		'background:var(--background-card);color:var(--text-regular);min-width:240px}.app-field-error{color:var(--error);font-size:12px}',
		'.app-note{padding:8px 12px;border-radius:4px;margin-bottom:8px;background:var(--background-content)}.app-note.warning{color:var(--error)}',
		'#app-modal{position:fixed;inset:0;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}#app-modal[hidden]{display:none}',
		'.app-modal-box{background:var(--background-card);padding:16px 20px;border-radius:8px;max-width:480px}',
		'.app-group{border:1px solid var(--divider);border-radius:6px;margin:0 0 16px;padding:8px 16px 12px}.app-group legend{font-weight:600;color:var(--text-title);padding:0 6px}',
		'.app-row{margin:10px 0}.app-row[hidden]{display:none}.app-sub{margin-left:24px}.app-desc{color:var(--text-hint);font-size:12px;margin-top:3px;max-width:640px}',
		'.app-check{display:flex;align-items:center;gap:6px;margin:0}.app-check input{min-width:0}.app-btn-plain{margin-left:8px;background:var(--background-content)!important;color:var(--text-regular)!important}',
		'.app-pre,pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:var(--background-content);padding:8px;border-radius:4px;max-height:420px;overflow:auto}',
		'.redbook-warn{color:var(--error)}.redbook-ok{color:var(--text-regular)}.redbook-info{color:var(--text-regular)}',
		'@media (max-width:600px){input,select{min-width:0;width:100%;box-sizing:border-box}.app-sub{margin-left:12px}}'
	].join('');

	/* ----------------------------------------------------------- settings -- */

	/* The panel's own Settings form, drawn from the schema in common.js,
	 * which LuCI's settings.js is drawn from too. Values go to set_config
	 * (checked again by FIELDS in the panel module), the password to
	 * set_secret; a saved password is never loaded into the page. */
	function renderSettings(page) {
		return Promise.all([ requireModule(APP + '.common'), call('get_config'), call('get_status'),
			call('get_drives').catch(function() { return {}; }) ]).then(function(got) {
			var app = got[0], cfg = (got[1] && !Array.isArray(got[1].config) && got[1].config) || {}, st = got[2] || {};
			var drives = (got[3] && got[3].drives) || [];
			var fields = app.schema(), values = {}, inputs = {}, errors = {}, rows = {};
			fields.forEach(function(f) {
				if (f.type !== 'password') values[f.key] = cfg[f.key] != null ? cfg[f.key] : (f.def != null ? f.def : '');
			});

			function read() {
				fields.forEach(function(f) {
					if (f.type === 'password') return;
					values[f.key] = f.type === 'flag' ? (inputs[f.key].checked ? '1' : '0') : inputs[f.key].value.trim();
				});
			}

			var netBox = E('div', { 'class': 'app-row' }), configsBox = E('div', { 'class': 'app-row' });

			function update() {
				read();
				fields.forEach(function(f) { rows[f.key].hidden = !app.shown(f, values); });
				netBox.hidden = !(values.storage === 'network' || (values.storage === 'usb' && values.backup === '1'));
				configsBox.hidden = values.syslog_send !== '1';
				configsBox.replaceChildren(E('p', {}, [ _('Logs from the router arrive as below. A config for the server that receives them, saving one file per day:') ]));
				app.syslogConfigs(st, values).forEach(function(c) {
					configsBox.appendChild(E('div', {}, [ E('strong', {}, [ c.name ]), ' ', E('code', {}, [ c.file ]), E('pre', { 'class': 'app-pre' }, [ c.text ]) ]));
				});
				resize();
			}

			function field(f) {
				var el, id = 'app-f-' + f.key;
				if (f.type === 'flag') {
					el = E('input', { type: 'checkbox', id: id });
					el.checked = values[f.key] === '1';
				} else if (f.type === 'select') {
					el = E('select', { id: id }, f.options.map(function(o) { return E('option', { value: o[0] }, [ o[1] ]); }));
					el.value = values[f.key];
				} else {
					el = E('input', { type: f.type === 'password' ? 'password' : 'text', id: id, autocomplete: 'off',
						placeholder: f.type === 'password' ? (st.net_password_set ? _('(saved)') : '') : (f.placeholder || '') });
					/* Write-only: a saved password is never put back in the field. */
					el.value = f.type === 'password' ? '' : values[f.key];
					if (f.key === 'usb_path' && drives.length) {
						el.setAttribute('list', 'app-drives');
						el = E('span', {}, [ el, E('datalist', { id: 'app-drives' }, drives.map(function(d) { return E('option', { value: d.path }, [ d.path ]); })) ]);
					}
				}
				var input = el.tagName === 'SPAN' ? el.firstChild : el;
				input.addEventListener('change', update);
				inputs[f.key] = input;
				errors[f.key] = E('div', { 'class': 'app-field-error' });
				var desc = f.desc || '';
				if (f.privacy) desc = desc + ' ' + app.PRIVACY;
				if (f.type === 'password')
					desc = st.net_password_set ? _('A password is saved. Leave empty to keep it. Saved passwords are never shown.') : _('Leave empty for a guest login.');
				var label = E('label', { 'for': id }, [ f.label ]);
				rows[f.key] = E('div', { 'class': 'app-row' + (f.source ? ' app-sub' : '') }, f.type === 'flag'
					? [ E('label', { 'class': 'app-check' }, [ input, ' ', f.label ]), desc ? E('div', { 'class': 'app-desc' }, [ desc ]) : '', errors[f.key] ]
					: [ label, el, desc ? E('div', { 'class': 'app-desc' }, [ desc ]) : '', errors[f.key] ]);
				return rows[f.key];
			}

			var out = E('div', { 'class': 'app-desc' });
			var support = st.support || {};
			netBox.appendChild(E('div', {}, [
				E('button', { 'class': 'app-btn', type: 'button', 'click': function(ev) {
					ev.target.disabled = true;
					out.textContent = _('Trying…');
					call('test_network', {}, 70).then(function(r) {
						out.textContent = r && r.ok ? _('Mounted %s and wrote a test file.').format(r.path) : app.reasonText(r && r.reason);
					}).catch(function(e) { out.textContent = e.message; }).finally(function() { ev.target.disabled = false; resize(); });
				} }, [ _('Test the saved settings') ])
			].concat([ [ 'smb', _('SMB') ], [ 'nfs', _('NFS') ] ].filter(function(t) { return !support[t[0]] && !(t[0] === 'nfs' && support.nfs_installable === false); }).map(function(t) {
				return E('button', { 'class': 'app-btn app-btn-plain', type: 'button', 'click': function(ev) {
					ev.target.disabled = true;
					call('install_support', { type: t[0] }).then(function() {
						out.textContent = _('Installing support for %s from the router\'s package source. This takes a minute; open Settings again afterwards.').format(t[1]);
					}).catch(function(e) { out.textContent = e.message; ev.target.disabled = false; });
				} }, [ _('Install %s support').format(t[1]) ]);
			})).concat([ !support.nfs && support.nfs_installable === false ? E('div', { 'class': 'app-desc' }, [ app.reasonText('nfs_not_on_gl') ]) : '',
				E('div', { 'class': 'app-desc' }, [ _('Save first: the test uses the saved settings.') ]), out ])));

			var form = E('form', { 'class': 'app-card' }, app.TABS.map(function(t) {
				var box = E('fieldset', { 'class': 'app-group' }, [ E('legend', {}, [ t[1] ]) ].concat(
					fields.filter(function(f) { return f.tab === t[0]; }).map(field)));
				if (t[0] === 'network') box.appendChild(netBox);
				if (t[0] === 'syslog') box.appendChild(configsBox);
				return box;
			}).concat([ E('p', {}, [ E('button', { 'class': 'app-btn', type: 'submit' }, [ _('Save') ]) ]) ]));

			form.addEventListener('submit', function(ev) {
				ev.preventDefault();
				read();
				var bad = false, send = {};
				Object.keys(errors).forEach(function(k) { errors[k].textContent = ''; });
				fields.forEach(function(f) {
					if (f.type === 'password') return;
					var r = app.shown(f, values) ? app.checkValue(f, values[f.key]) : true;
					if (r !== true) { errors[f.key].textContent = r; bad = true; }
					send[f.key] = values[f.key];
				});
				if (bad) { note(_('Not saved: some values need fixing.'), 'warning'); resize(); return; }
				call('set_config', { values: send }).then(function() {
					var s = inputs.net_password.value;
					return s ? call('set_secret', { secret: s }).then(function() { inputs.net_password.value = ''; inputs.net_password.placeholder = _('(saved)'); }) : null;
				}).then(function() {
					note(_('Settings saved. Red Book starts again with them within half a minute.'), 'info');
				}).catch(function(e) {
					if (e.field && errors[e.field]) errors[e.field].textContent = e.message;
					note(_('Not saved: %s').format(e.message), 'warning');
				});
			});
			page.replaceChildren(E('h2', {}, [ _('Settings') ]), form);
			update();
		});
	}

	/* --------------------------------------------------------------- pages -- */

	function resize() {
		if (frame) frame.style.height = Math.max(400, document.documentElement.scrollHeight + 20) + 'px';
	}

	function runView(name, page) {
		return requireModule('view.' + APP + '.' + name).then(function(v) {
			return Promise.resolve(v.load ? v.load() : null).then(function(data) {
				page.replaceChildren(E('div', { 'class': 'app-card' }, [ v.render(data) ]));
			});
		});
	}

	function show(name) {
		var page = document.getElementById('app-page');
		polls.forEach(window.clearInterval); polls = [];
		document.querySelectorAll('.app-tabs button').forEach(function(b) { b.setAttribute('aria-selected', String(b.dataset.page === name)); });
		var done = name === 'settings' ? renderSettings(page) : runView(name, page);
		return done.catch(function(e) {
			page.replaceChildren(E('div', { 'class': 'app-card' }, [ E('p', {}, [ _('This page could not load: %s').format(String(e.message || e)) ]) ]));
		}).then(resize);
	}

	function start() {
		document.head.appendChild(E('style', {}, CSS));
		syncTheme();
		watchTheme();
		var tabs = E('div', { 'class': 'app-tabs', role: 'tablist' }, [ [ 'overview', _('Overview') ], [ 'settings', _('Settings') ] ].map(function(t) {
			return E('button', { role: 'tab', 'data-page': t[0], 'click': function() { show(t[0]); } }, [ t[1] ]);
		}));
		document.body.appendChild(E('div', {}, [ tabs, E('div', { id: 'app-notes' }), E('div', { id: 'app-page' }), E('div', { id: 'app-modal', hidden: '' }) ]));
		new MutationObserver(resize).observe(document.body, { childList: true, subtree: true });
		show('overview');
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
