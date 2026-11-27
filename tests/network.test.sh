#!/bin/sh
# The network folder, against a real Samba server (a container), with the
# OpenWrt package source's own mount.cifs on OpenWrt 23.05:
#   - a wrong password, a missing share and an unknown server each give
#     their own reason
#   - the USB drive's files are copied to the share, and today's file is
#     topped up as it grows
#   - the share as the only storage
#   - a server that stops answering: the write gives up in time, the lines
#     wait, and they arrive once it is back
#   - the password is in no command line, mount table, log or file
# Needs Docker with the kernel's cifs module loaded (Colima on macOS:
# colima ssh -- sudo modprobe cifs; GitHub's runner: sudo modprobe cifs).
# Run: sh tests/network.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NET=redbook-test-net SMB=redbook-test-smbd NAME=redbook-test-netrouter VOL=redbook-test-net-usb
# shellcheck disable=SC2016 # a literal $ and backquote, on purpose
PW='Pa ss,w"o'"'"'r$d`1<b>'
cleanup() {
	docker rm -f "$NAME" "$SMB" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	docker volume rm "$VOL" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT
docker build -q --platform linux/amd64 -t redbook-test-smb "$ROOT/tests/smb" >/dev/null
docker build -q --platform linux/amd64 -t redbook-test-netrouter "$ROOT/tests/openwrt-net" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --platform linux/amd64 --name "$SMB" --network "$NET" --network-alias nas -e SMB_PASS="$PW" redbook-test-smb >/dev/null
docker run -d --platform linux/amd64 --privileged --name "$NAME" --hostname rbnet --network "$NET" -v "$VOL:/mnt/usb" \
	-v "$ROOT/luci-app-redbook:/pkg:ro" redbook-test-netrouter >/dev/null
sleep 4
smb() { docker exec "$SMB" sh -c "$1"; }

docker exec -i -e PW="$PW" "$NAME" sh -s <<'TEST' || exit 1
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
mkdir -p /var/lock /var/run /var/state; touch /var/state/dnsmasqsec
cp -R /pkg/root/. /
chmod 755 /usr/bin/redbook /etc/init.d/redbook; chmod 600 /etc/config/redbook_auth
uci set redbook.main.usb_path=/mnt/usb; uci set redbook.main.flush_minutes=15
uci set redbook.main.backup=1; uci set redbook.main.net_type=smb
uci set redbook.main.net_server=nas; uci set redbook.main.net_share=logs; uci set redbook.main.net_folder=routers
uci set redbook.main.net_user=rbuser
uci commit redbook
# No procd here: run the daemon by hand, detached.
start-stop-daemon -S -b -x /usr/bin/redbook -- daemon
sleep 3
TODAY=$(date +%Y-%m-%d)
B=/var/run/redbook/net/routers/redbook/rbnet

printf '%s\n' 'wrong password' | redbook set-secret >/dev/null
check "[ \"\$(redbook test-network | jsonfilter -e @.reason)\" = login_refused ]" "a wrong password: the server refused the login"
printf '%s\n' "$PW" | redbook set-secret >/dev/null
uci set redbook.main.net_share=nosuch; uci commit redbook
check "[ \"\$(redbook test-network | jsonfilter -e @.reason)\" = share_not_found ]" "a missing share: no share by that name"
uci set redbook.main.net_share=logs; uci set redbook.main.net_server=nas.invalid; uci commit redbook
check "[ \"\$(redbook test-network | jsonfilter -e @.reason)\" = unreachable ]" "an unknown server: cannot be reached"
uci set redbook.main.net_server=nas; uci commit redbook
check "[ \"\$(redbook test-network | jsonfilter -e @.ok)\" = true ]" "the right settings: mounted and a test file written"

logger -p user.notice "rbnet-line-1"
sleep 1
redbook flush >/dev/null 2>&1
check "grep -q rbnet-line-1 /mnt/usb/redbook/rbnet/system/$TODAY.log" "the drive gets the lines"
check "[ \"\$(redbook status | jsonfilter -e @.storage.backup.state)\" = ok ]" "status: the copy is ok"
check "cmp /mnt/usb/redbook/rbnet/system/$TODAY.log $B/system/$TODAY.log" "the copy on the share matches the drive"
logger -p user.notice "rbnet-line-2"
sleep 1
redbook flush >/dev/null 2>&1
check "cmp /mnt/usb/redbook/rbnet/system/$TODAY.log $B/system/$TODAY.log && grep -q rbnet-line-2 $B/system/$TODAY.log" "today's file is topped up on the share as it grows"
YDAY=$(date -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%d)
echo "yesterday" > /mnt/usb/redbook/rbnet/system/$YDAY.log
cp /mnt/usb/redbook/rbnet/system/$YDAY.log $B/system/$YDAY.log
redbook flush >/dev/null 2>&1
check "[ -s $B/system/$YDAY.log.gz ] && [ ! -e $B/system/$YDAY.log ] && cmp $B/system/SHA256SUMS /mnt/usb/redbook/rbnet/system/SHA256SUMS" "a finished day: the share gets the compressed file and its sum, the plain copy goes"

# The share as the only storage.
uci set redbook.main.storage=network; uci commit redbook
logger -p user.notice "rbnet-direct"
sleep 1
redbook flush >/dev/null 2>&1
check "grep -q rbnet-direct $B/system/$TODAY.log && ! grep -q rbnet-direct /mnt/usb/redbook/rbnet/system/$TODAY.log" "storage on the share: lines go straight there"
check "[ \"\$(redbook status | jsonfilter -e @.storage.state)\" = ok ] && [ \"\$(redbook status | jsonfilter -e @.storage.kind)\" = network ]" "status: writing to the network folder"

# The password stays secret.
check "! grep -qF 'w\"o' /proc/mounts && ! grep -rqF 'w\"o' /var/run/redbook /mnt/usb $B && ! logread | grep -qF 'w\"o'" "the password is in no mount table, file or log"
check "[ ! -e /var/run/redbook/net.cred ]" "the credentials file is gone after mounting"
check "! grep -q 'password=' /proc/mounts" "the mount table shows no password"
echo "$fail" > /tmp/fail
TEST

# A server that stops answering, then comes back.
docker pause "$SMB" >/dev/null
docker exec "$NAME" sh -c 'logger -p user.notice rbnet-while-down; sleep 1'
start=$(date +%s)
docker exec "$NAME" sh -c 'redbook flush >/dev/null 2>&1' || true
took=$(( $(date +%s) - start ))
fail=$(docker exec "$NAME" cat /tmp/fail)
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
if [ "$took" -le 300 ]; then ok "a server that stops answering: the write gives up in time (${took} s)"; else bad "the write hung for ${took} s"; fi
if docker exec "$NAME" sh -c 'cat /var/run/redbook/spool/system/* 2>/dev/null | grep -q rbnet-while-down'; then ok "its lines wait in memory"; else bad "the lines were not kept while the server was away"; fi
docker unpause "$SMB" >/dev/null
sleep 2
docker exec "$NAME" sh -c 'redbook flush >/dev/null 2>&1' || true
docker exec "$NAME" sh -c 'redbook flush >/dev/null 2>&1' || true
if smb "grep -q rbnet-while-down /share/routers/redbook/rbnet/system/$(date +%Y-%m-%d).log"; then ok "server back: the waiting lines arrive"; else bad "server back: the waiting lines did not arrive"; fi
if smb "grep -q rbnet-line-2 /share/routers/redbook/rbnet/system/$(date +%Y-%m-%d).log"; then ok "the Samba server itself holds the files"; else bad "the files are not on the Samba server"; fi

[ "$fail" = 0 ] && echo && echo "all checks passed"
[ "$fail" = 0 ] || { echo; echo "$fail check(s) failed"; exit 1; }
