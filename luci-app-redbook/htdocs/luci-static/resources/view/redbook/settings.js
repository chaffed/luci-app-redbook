'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require redbook.common as app';

/*
 * Red Book - Settings (UCI config /etc/config/redbook), drawn from the
 * schema in common.js, which the GL panel's form (gl.js) is drawn from too.
 *
 * The network folder's password is not part of this form's config: it is
 * kept in /etc/config/redbook_auth, which this page never loads, and is
 * saved through the set_secret call. The page only learns whether one is
 * set. Fields whose names start with "_" are not stored by the form.
 * SPDX-License-Identifier: MIT
 */

var CLASSES = { flag: 'Flag', select: 'ListValue', text: 'Value', password: 'Value' };

return view.extend({
	load: function() {
		return Promise.all([
			app.callStatus().catch(function() { return {}; }),
			app.callDrives().catch(function() { return {}; })
		]);
	},

	render: function(got) {
		var m, s, o, self = this, st = got[0] || {}, drives = (got[1] && got[1].drives) || [];

		m = new form.Map('redbook', _('Red Book – Settings'),
			_('Keeps the router\'s logs on a USB drive or a network folder, for troubleshooting and security analysis.'));

		s = m.section(form.NamedSection, 'main', 'redbook');
		s.anonymous = true;
		s.addremove = false;
		app.TABS.forEach(function(t) { s.tab(t[0], t[1]); });

		app.schema().forEach(function(f) {
			var name = f.type === 'password' ? '_' + f.key : f.key;
			var desc = f.desc || '';
			if (f.privacy) desc = desc + ' ' + app.PRIVACY;
			if (f.source) desc = '';
			o = s.taboption(f.tab, form[CLASSES[f.type]], name, f.source ? '↳ ' + f.label : f.label, desc || null);
			(f.depends || []).forEach(function(d) { o.depends(d); });

			if (f.type === 'flag') {
				o.rmempty = false;
				o.default = f.def;
			} else if (f.type === 'select') {
				f.options.forEach(function(v) { o.value(v[0], v[1]); });
				o.default = f.def;
				o.rmempty = !!f.optional;
			} else if (f.type === 'password') {
				/* Write-only: never filled in from the router. */
				o.password = true;
				o.description = st.net_password_set ? _('A password is saved. Leave empty to keep it. Saved passwords are never shown.') : _('Leave empty for a guest login.');
				o.placeholder = st.net_password_set ? _('(saved)') : '';
				o.cfgvalue = function() { return ''; };
				o.write = function(section_id, value) { self.newSecret = value; };
				o.remove = function() {};
			} else {
				if (f.placeholder) o.placeholder = f.placeholder;
				if (f.def != null) o.default = f.def;
				o.rmempty = !!f.optional;
				o.validate = function(section_id, value) { return app.checkValue(f, value); };
				if (f.key === 'usb_path')
					drives.forEach(function(d) { o.value(d.path, _('%s (%s free)').format(d.path, app.size((+d.free_kb || 0) * 1024))); });
			}

			if (f.key === 'net_smbver') self.renderNetworkActions(s, st);
		});

		o = s.taboption('syslog', form.DummyValue, '_configs', _('For the syslog server'));
		o.depends('syslog_send', '1');
		o.renderWidget = function() {
			var values = { syslog_port: uci.get('redbook', 'main', 'syslog_port') || '514', syslog_proto: uci.get('redbook', 'main', 'syslog_proto') || 'udp' };
			return E('div', {}, [
				E('p', {}, [ _('Logs from the router arrive as below. A config for the server that receives them, saving one file per day (shown for the saved port and protocol):') ])
			].concat(app.syslogConfigs(st, values).map(function(c) {
				return E('div', { 'style': 'margin-top:.8em' }, [
					E('strong', {}, [ c.name ]), ' ', E('code', {}, [ c.file ]),
					E('pre', { 'style': 'white-space:pre-wrap;font-size:90%;margin-top:.3em' }, [ c.text ])
				]);
			})));
		};

		return m.render();
	},

	/* The Test and Install buttons, on the Network folder tab. */
	renderNetworkActions: function(s, st) {
		var o = s.taboption('network', form.DummyValue, '_netactions', _('Check'));
		o.depends({ storage: 'network' });
		o.depends({ storage: 'usb', backup: '1' });
		o.renderWidget = function() {
			var out = E('div', { 'class': 'redbook-net-result', 'style': 'margin-top:.5em' });
			var test = E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function() {
				out.replaceChildren(E('em', {}, [ _('Trying…') ]));
				return app.callTestNetwork().then(function(r) {
					out.replaceChildren(r && r.ok ? E('span', { 'style': 'color:green' }, [ _('Mounted %s and wrote a test file.').format(r.path) ])
						: E('span', { 'style': 'color:#c00' }, [ app.reasonText(r && r.reason) ]));
				}).catch(function(e) { out.replaceChildren(String(e.message || e)); });
			}) }, [ _('Test the saved settings') ]);
			var support = st.support || {};
			var missing = [ [ 'smb', _('SMB') ], [ 'nfs', _('NFS') ] ].filter(function(t) { return !support[t[0]] && !(t[0] === 'nfs' && support.nfs_installable === false); });
			var nfsNote = !support.nfs && support.nfs_installable === false ? E('p', { 'class': 'cbi-value-description' }, [ app.reasonText('nfs_not_on_gl') ]) : '';
			var installs = missing.map(function(t) {
				return E('button', { 'class': 'cbi-button', 'style': 'margin-left:.5em', 'click': ui.createHandlerFn(this, function() {
					return app.callInstallSupport(t[0]).then(function() {
						out.replaceChildren(_('Installing support for %s from the router\'s package source. This takes a minute; reload the page afterwards.').format(t[1]));
					});
				}) }, [ _('Install %s support').format(t[1]) ]);
			});
			return E('div', {}, [
				test
			].concat(installs).concat([
				support.installing ? E('p', {}, [ _('Installing support…') ]) : '',
				nfsNote,
				E('p', { 'class': 'cbi-value-description' }, [ _('Save first: the test uses the saved settings.') ]),
				out
			]));
		};
	},

	/* Save the password (if one was typed) through its own call, then the
	 * other settings as usual. */
	handleSave: function(ev) {
		var self = this;
		self.newSecret = null;
		return this.super('handleSave', [ ev ]).then(function() {
			if (!self.newSecret) return;
			return app.callSetSecret(self.newSecret).then(function(r) {
				if (!r || !r.ok) throw new Error(_('the router did not save it'));
				self.newSecret = null;
				ui.addNotification(null, E('p', {}, [ _('Password saved.') ]), 'info');
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, [ _('The password was not saved: %s').format(String(e.message || e)) ]), 'warning');
			});
		});
	}
});
