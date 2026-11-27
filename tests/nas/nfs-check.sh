#!/bin/sh
# Red Book's NFS folder from OpenWrt 23.05 (a container on the Docker host's kernel,
# which needs the nfs module) to the file server of tests/nas, through this
# machine's LAN address as a router would. Needs the redbook-test-netrouter
# image (sh tests/network.test.sh builds it) and the VM: sh tests/nas/nas.sh up.
# Run: sh tests/nas/nfs-check.sh [server address]
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd) NAME=redbook-nfs-check VOL=redbook-nfs-check-usb
SERVER=${1:-$(ipconfig getifaddr "$(route -n get default | awk '/interface:/ { print $2 }')" 2>/dev/null || hostname -I | cut -d" " -f1)}
docker rm -f $NAME >/dev/null 2>&1 || true; docker volume rm $VOL >/dev/null 2>&1 || true
docker run -d --platform linux/amd64 --privileged --name $NAME --hostname rbnfs -v "$VOL:/mnt/usb" \
	-v "$ROOT/luci-app-redbook:/pkg:ro" redbook-test-netrouter >/dev/null
sleep 3
nas() { limactl shell redbook-nas sudo sh -c "$1"; }
nas 'rm -rf /srv/nfs/logs/*'
docker exec -i -e SERVER="$SERVER" $NAME sh -s <<'TEST'
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
reason() { redbook test-network | jsonfilter -e @.reason; }
mkdir -p /var/lock /var/run /var/state; touch /var/state/dnsmasqsec
cp -R /pkg/root/. /; chmod 755 /usr/bin/redbook /etc/init.d/redbook; chmod 600 /etc/config/redbook_auth
uci set redbook.main.usb_path=/mnt/usb; uci set redbook.main.flush_minutes=15
uci set redbook.main.backup=1; uci set redbook.main.net_type=nfs
uci set redbook.main.net_server="$SERVER"; uci set redbook.main.net_share=/srv/nfs/logs
uci commit redbook
check "[ \"\$(reason)\" = no_support ]" "without nfs-utils: the reason is that support is missing"
opkg update >/dev/null 2>&1 && opkg install nfs-utils >/dev/null 2>&1
check "command -v mount.nfs" "nfs-utils installed from OpenWrt's package source"
start-stop-daemon -S -b -x /usr/bin/redbook -- daemon
sleep 3
F=$(redbook status | jsonfilter -e @.folder); TODAY=$(date +%Y-%m-%d)
check "redbook test-network | jsonfilter -e @.ok | grep -qx true" "test: the export mounts and is writable"
grep " nfs" /proc/mounts | sed 's/^/     /'
logger -p user.notice "rbnfs-line-1"; sleep 2; redbook flush >/dev/null 2>&1
check "grep -q rbnfs-line-1 /var/run/redbook/net/$F/system/$TODAY.log" "copy: today's system log reaches the export"
check "[ \"\$(redbook status | jsonfilter -e @.storage.backup.state)\" = ok ]" "status: the copy is ok"

uci set redbook.main.net_share=/srv/nfs/readonly; uci commit redbook
check "[ \"\$(reason)\" = not_writable ]" "a read-only export: not writable"
uci set redbook.main.net_share=/srv/nfs/missing; uci commit redbook
r=$(reason); echo "     a missing export gives: $r"
check "[ \"$r\" != ok ] && [ -n \"$r\" ]" "a missing export: refused, with a reason"

uci set redbook.main.net_share=/srv/nfs/logs; uci set redbook.main.backup=0; uci set redbook.main.storage=network; uci commit redbook
sleep 3
logger -p user.notice "rbnfs-line-2"; sleep 2; redbook flush >/dev/null 2>&1
check "[ \"\$(redbook status | jsonfilter -e @.storage.kind)\" = network ] && [ \"\$(redbook status | jsonfilter -e @.storage.state)\" = ok ]" "the export as the only storage: status ok"
check "grep -q rbnfs-line-2 /var/run/redbook/net/$F/system/$TODAY.log" "the export as the only storage: lines are written there"
echo "$F" > /tmp/folder
exit $fail
TEST
echo "-- the server stops answering"
nas 'systemctl stop nfs-server'
docker exec $NAME sh -c 'logger -p user.notice rbnfs-line-3; sleep 2; s=$(date +%s); redbook flush >/dev/null 2>&1; e=$(( $(date +%s) - s )); echo "     a write with the server gone took ${e}s"; [ $e -le 300 ] && echo "ok   the write gives up in time (soft mount; the SMB test allows 300 s too)" || echo "FAIL the write hung (${e}s)"; st=$(redbook status | jsonfilter -e @.storage.state -e @.storage.reason | tr "\n" " "); echo "     status: $st"; grep -q rbnfs-line-3 /var/run/redbook/spool/system/*.cur 2>/dev/null && echo "ok   the lines wait in memory" || echo "FAIL the line is not waiting"'
nas 'systemctl start nfs-server'; sleep 5
docker exec $NAME sh -c 'redbook flush >/dev/null 2>&1; sleep 2; redbook flush >/dev/null 2>&1; echo "     status: $(redbook status | jsonfilter -e @.storage.state)"'
F=$(docker exec $NAME cat /tmp/folder)
nas "grep -c rbnfs-line-3 /srv/nfs/logs/$F/system/\$(date +%Y-%m-%d).log" | grep -qx 1 && echo "ok   server back: the waiting line arrives, once" || echo "FAIL server back: the line did not arrive once"
nas "cd /srv/nfs/logs/$F && ls -ln system | head -4"
docker rm -f $NAME >/dev/null; docker volume rm $VOL >/dev/null
