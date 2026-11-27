#!/bin/sh
# The package as people get it: the .ipk, installed with opkg on a clean
# OpenWrt 23.05 (a container), then upgraded to a newer release, removed and
# installed again. Settings and the password must come through all of it,
# and removing it must put back the router settings Red Book changed.
# Needs Docker.
#
# Run: sh tests/install.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/.test-out/install"   # inside the repo: Docker Desktop on macOS does not share the system temp folder
rm -rf "$OUT"
mkdir -p "$OUT"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$ROOT/luci-app-redbook/Makefile")
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$ROOT/luci-app-redbook/Makefile")
sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null
REDBOOK_RELEASE=$((RELEASE + 1)) sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null

docker run --rm --platform linux/amd64 -v "$OUT:/dist:ro" -e VERSION="$VERSION" -e RELEASE="$RELEASE" openwrt/rootfs:x86-64-23.05.6 sh -c '
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
this=/dist/luci-app-redbook_${VERSION}-r${RELEASE}_all.ipk
newer=/dist/luci-app-redbook_${VERSION}-r$((RELEASE + 1))_all.ipk
mode() { ls -l "$1" | cut -c1-10; }   # busybox has no stat
mkdir -p /var/lock /var/run
opkg update >/dev/null 2>&1 || { echo "FAIL opkg update (no network?)"; exit 1; }

opkg install "$this" >/tmp/install.log 2>&1 || { cat /tmp/install.log; echo "FAIL the package does not install"; exit 1; }
check "opkg list-installed | grep -q \"^luci-app-redbook - ${VERSION}-r${RELEASE}\$\"" "clean install: ${VERSION}-r${RELEASE} installs with its dependencies"
check "[ \"\$(redbook status | jsonfilter -e @.version)\" = \"$VERSION\" ]" "clean install: the program says it is $VERSION"
check "[ \"\$(mode /etc/config/redbook_auth)\" = -rw------- ]" "clean install: the secret file is readable by root only"
check "ls /etc/rc.d/ | grep -q redbook" "clean install: the scheduler is set to start with the router"
check "[ ! -e /etc/uci-defaults/80_redbook ]" "clean install: the first-run script ran"
check "[ -s /usr/share/luci/menu.d/luci-app-redbook.json ] && [ -s /usr/share/rpcd/acl.d/luci-app-redbook.json ] && [ -x /usr/libexec/rpcd/luci.redbook ]" "clean install: LuCI menu, permissions and rpcd plugin are in place"
check "[ -s /www/views/gl-sdk4-ui-redbook.common.js ] && [ -s /usr/share/oui/menu.d/redbook.json ] && [ -s /usr/lib/oui-httpd/rpc/redbook ]" "clean install: the GL.iNet panel files are in place"
check "[ \"\$(redbook status | jsonfilter -e @.net_password_set)\" = false ]" "clean install: no password yet"
mkdir -p /var/state && touch /var/state/dnsmasqsec
redbook flush >/dev/null 2>&1
check "[ \"\$(redbook status | jsonfilter -e @.storage.reason)\" = no_drive ] && [ -z \"\$(find / \\( -path /proc -o -path /tmp/run -o -path /var/run \\) -prune -o -type d -path \"*/redbook/*/system\" -print 2>/dev/null)\" ]" "clean install, no drive: says so and writes no logs anywhere"

uci set redbook.main.compress=xz
uci set redbook.main.src_dns=1
uci commit redbook
echo "s3cret pass" | redbook set-secret >/dev/null
redbook apply
check "[ \"\$(uci -q get dhcp.@dnsmasq[0].logqueries)\" = 1 ]" "DNS queries on: dnsmasq logs them"
kept() {
	[ "$(uci -q get redbook.main.compress)" = xz ] && [ "$(uci -q get redbook_auth.main.net_password)" = "s3cret pass" ] &&
	[ "$(mode /etc/config/redbook_auth)" = -rw------- ] && grep -q "^dns=1" /etc/redbook/applied
}

opkg install "$newer" >/tmp/upgrade.log 2>&1 || cat /tmp/upgrade.log
check "opkg list-installed | grep -q \"^luci-app-redbook - ${VERSION}-r$((RELEASE + 1))\$\"" "upgrade: a newer release installs over it"
check kept "upgrade: settings, password and the record of router changes are kept; the password file stays root only"
check "! ls /etc/config/ | grep -q -- -opkg" "upgrade: no stray -opkg copies of the settings are left"
check "ls /etc/rc.d/ | grep -q redbook" "upgrade: the scheduler is still set to start"

opkg remove luci-app-redbook >/tmp/remove.log 2>&1 || cat /tmp/remove.log
check "[ ! -e /usr/bin/redbook ] && [ ! -e /www/views/gl-sdk4-ui-redbook.common.js ] && ! ls /etc/rc.d/ | grep -q redbook" "remove: the program, the scheduler and the pages are gone"
check "[ -z \"\$(uci -q get dhcp.@dnsmasq[0].logqueries)\" ] && ! grep -q dns /etc/redbook/applied" "remove: query logging in dnsmasq is put back as it was"
check "[ -s /etc/config/redbook_auth ] && [ \"\$(uci -q get redbook.main.compress)\" = xz ]" "remove: settings and password stay on the router"
opkg install "$this" >/tmp/again.log 2>&1 || cat /tmp/again.log
check "[ \"\$(uci -q get redbook.main.compress)\" = xz ] && [ \"\$(uci -q get redbook_auth.main.net_password)\" = \"s3cret pass\" ]" "install again: picks up the kept settings and password"
redbook apply
check "[ \"\$(uci -q get dhcp.@dnsmasq[0].logqueries)\" = 1 ]" "install again: DNS query logging is turned back on"

[ "$fail" = 0 ] && echo && echo "all checks passed"
[ "$fail" = 0 ] || { echo; echo "$fail check(s) failed"; exit 1; }
'
