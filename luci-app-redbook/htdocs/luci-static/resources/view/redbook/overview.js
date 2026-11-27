'use strict';
'require view';
'require poll';
'require ui';
'require redbook.common as app';

/*
 * Red Book - Overview. Also runs inside the GL.iNet admin panel (gl.js
 * provides stand-ins for view, poll, ui, E, _ and the rpc calls), so use
 * only those LuCI APIs here, or add a stand-in for any new one.
 *
 * E(tag, attrs, 'text') assigns a bare string with innerHTML: text from
 * the router (paths, log lines) is always passed as an array child.
 * SPDX-License-Identifier: MIT
 */

function line(kind, children) {
	return E('p', { 'class': 'redbook-' + kind }, children);
}

return view.extend({
	load: function() {
		return app.callStatus().catch(function() { return {}; });
	},

	renderStatus: function(st) {
		var out = [], sto = st.storage || {}, bk = sto.backup || {}, r = st.router || {};
		if (!st.enabled) return E('div', {}, [ line('warn', [ _('Red Book is off: no logs are being kept.') ]) ]);
		if (st.running === false) out.push(line('warn', [ _('The Red Book service is not running.') ]));

		var where = st.storage_kind === 'network' ? _('the network folder %s') : _('the USB drive at %s');
		if (!sto.state)
			out.push(line('info', [ _('Nothing has been written yet.') ]));
		else if (sto.state === 'ok')
			out.push(line('ok', [ _('Writing to %s, in %s: %s free of %s. Last written %s.').format(where.format(sto.path), st.folder,
				app.size((+sto.free_kb || 0) * 1024), app.size((+sto.total_kb || 0) * 1024), app.when(sto.at)) ]));
		else
			out.push(line('warn', [ _('Not writing to %s. %s').format(where.format(sto.path || '?'), app.reasonText(sto.reason)) ]));

		if (st.backup && st.storage_kind === 'usb') {
			if (bk.state === 'ok')
				out.push(line('ok', [ _('Copied to the network folder %s at %s.').format(bk.path, app.when(bk.last_ok)) ]));
			else if (bk.state === 'error')
				out.push(line('warn', [ _('Not copied to the network folder %s. %s').format(bk.path, app.reasonText(bk.reason)) ]));
		}
		if (+st.spool_kb > 0)
			out.push(line('info', [ _('%s waiting in memory for the next write.').format(app.size(st.spool_kb * 1024)) ]));
		if (+st.dropped > 0)
			out.push(line('warn', [ _('%d lines were dropped while the storage was away and the memory buffer was full. The logs say when.').format(st.dropped) ]));
		if (st.next && sto.state)
			out.push(line('info', [ _('Next write: %s.').format(app.when(st.next)) ]));

		var changed = String(r.changed_by_redbook || '');
		var settings = [];
		if (r.dns_logging) settings.push(_('dnsmasq logs every DNS query') + (changed.indexOf('dns') >= 0 ? _(' (turned on by Red Book)') : ''));
		if (r.firewall_logging) settings.push(_('the firewall logs blocked packets') + (changed.indexOf('fw_') >= 0 ? _(' (turned on by Red Book)') : ''));
		if (r.syslog_server) settings.push(_('the system log is sent to %s').format(r.syslog_server) + (changed.indexOf('syslog') >= 0 ? _(' (set by Red Book)') : ''));
		if (settings.length)
			out.push(line('info', [ _('On the router: %s.').format(settings.join('; ')) ]));

		return E('div', {}, out);
	},

	renderSources: function(st) {
		var stats = (st.stats && st.stats.sources) || {};
		var levels = {};
		app.LEVELS.forEach(function(l) { levels[l[0]] = l[1]; });
		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, [ _('Log') ]),
				E('th', { 'class': 'th' }, [ _('Recording') ]),
				E('th', { 'class': 'th' }, [ _('Kept for') ]),
				E('th', { 'class': 'th' }, [ _('Today') ]),
				E('th', { 'class': 'th' }, [ _('Stored') ])
			])
		].concat((st.sources || []).map(function(s) {
			var x = stats[s.id] || {};
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ app.sourceLabel(s.id) ]),
				E('td', { 'class': 'td' }, [ !s.on ? _('no') : s.missing && s.id !== 'web' ? _('on, but %s').format(app.missingText(s.missing))
					: s.level ? _('yes, from %s up').format(levels[s.level] || s.level) : _('yes') ]),
				E('td', { 'class': 'td' }, [ _('%d days').format(s.days) ]),
				E('td', { 'class': 'td' }, [ x.files ? app.size(x.today_bytes) : '' ]),
				E('td', { 'class': 'td' }, [ x.files ? (x.files === 1 ? _('%s in 1 file').format(app.size(x.bytes)) : _('%s in %d files').format(app.size(x.bytes), x.files)) : '' ])
			]);
		})));
	},

	renderViewer: function(st) {
		var pick = E('select', { 'class': 'cbi-input-select', 'id': 'redbook-source' }, (st.sources || []).map(function(s) {
			return E('option', { 'value': s.id }, [ app.sourceLabel(s.id) ]);
		}));
		var text = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'id': 'redbook-filter', 'placeholder': _('containing… (optional)') });
		var out = E('pre', { 'id': 'redbook-lines', 'style': 'white-space:pre-wrap;word-break:break-all;max-height:30em;overflow:auto;font-size:85%' }, [ _('Pick a log and press Show.') ]);
		var show = E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function() {
			return app.callLines(pick.value, 200, text.value).then(function(r) {
				r = r || {};
				var body = String(r.text || '');
				var note = r.file ? _('From %s:').format(r.file) : (r.storage_reason ? app.reasonText(r.storage_reason) + ' ' + _('Showing what is waiting in memory:') : '');
				out.replaceChildren(note ? note + '\n\n' : '', body || _('(no lines)'));
			}).catch(function(e) {
				out.replaceChildren(_('Could not read the log: %s').format(String(e.message || e)));
			});
		}) }, [ _('Show') ]);
		return E('div', {}, [
			E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;align-items:center' }, [ pick, text, show ]),
			out
		]);
	},

	render: function(st) {
		var self = this;
		st = st || {};
		var statusBox = E('div', {}, [ this.renderStatus(st) ]);
		var sourcesBox = E('div', {}, [ this.renderSources(st) ]);

		var refresh = function() {
			return app.callStatus().then(function(s) {
				statusBox.replaceChildren(self.renderStatus(s || {}));
				sourcesBox.replaceChildren(self.renderSources(s || {}));
			});
		};
		poll.add(refresh, 15);

		var flushBtn = E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, function() {
			return app.callFlush().then(function() {
				ui.addNotification(null, E('p', {}, [ _('Writing now. The page updates in a few seconds.') ]), 'info');
				window.setTimeout(refresh, 4000);
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, [ _('Could not write now: %s').format(String(e.message || e)) ]), 'warning');
			});
		}) }, [ _('Write now') ]);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Red Book') ]),
			E('div', { 'class': 'cbi-section' }, [ statusBox, flushBtn ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Logs') ]), sourcesBox ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Read a log') ]), this.renderViewer(st) ])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
