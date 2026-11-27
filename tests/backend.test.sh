#!/bin/sh
# The backend on OpenWrt 23.05 (a container running procd and logd), with a
# Docker volume as the USB drive:
#   - how logread lines are filed: source, level, day, no duplicates
#   - the mesh and web server parsers
#   - writing, compressing finished days, SHA256SUMS, late lines, retention
#   - an unplugged drive: nothing written to RAM, lines kept, a full buffer
#     leaves a "lines were lost" note
#   - a restart adds no duplicates; a stop is recorded as clean
#   - DNS, firewall and syslog settings are changed and put back exactly
#   - hostile settings do nothing; the password is never stored or logged
# Needs Docker. Run: sh tests/backend.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=redbook-test-backend
VOL=redbook-test-usb
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOL" >/dev/null 2>&1 || true
docker run -d --platform linux/amd64 --name "$NAME" --hostname rbtest -v "$VOL:/mnt/usb" \
	-v "$ROOT/luci-app-redbook:/pkg:ro" openwrt/rootfs:x86-64-23.05.6 /sbin/init >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm "$VOL" >/dev/null 2>&1' EXIT
sleep 4

docker exec -i "$NAME" sh -s <<'TEST'
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }

mkdir -p /var/lock /var/run /var/state
touch /var/state/dnsmasqsec           # the clock counts as set
cp -R /pkg/root/. /
chmod 755 /usr/bin/redbook /etc/init.d/redbook /usr/libexec/rpcd/luci.redbook
chmod 600 /etc/config/redbook_auth
uci set redbook.main.usb_path=/mnt/usb
uci set redbook.main.flush_minutes=15  # the test writes when it wants to
uci commit redbook
sh /etc/uci-defaults/80_redbook >/dev/null 2>&1
sleep 2
H=/mnt/usb/redbook/rbtest
TODAY=$(date +%Y-%m-%d)
YDAY=$(date -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%d)

# ----------------------------------------------------------- filing lines
T=/tmp/t; rm -rf $T; mkdir -p $T
(
	REDBOOK_LIB=1 . /usr/bin/redbook
	load_config
	SPOOL=$T/spool; spool_dirs
	cat > $T/in <<'LINES'
Fri Nov 27 08:04:37 2026 [1795795477.166] authpriv.info dropbear[4295]: Child connection from 192.168.8.140:53440
Fri Nov 27 08:04:38 2026 [1795795478.000] daemon.debug foo: debug noise
Fri Nov 27 08:04:39 2026 [1795795479.000] kern.warn kernel: [597120.1] DROP(src wan)IN=eth0 OUT= MAC=aa SRC=203.0.113.4 DST=198.51.100.7
Fri Nov 27 08:04:40 2026 [1795795480.000] kern.err kernel: [597121.1] usb 1-1: device descriptor read error
Fri Nov 27 08:04:41 2026 [1795795481.000] daemon.info dnsmasq[28302]: query[A] example.com from 192.168.8.140
Fri Nov 27 08:04:41 2026 [1795795481.100] daemon.info dnsmasq[28302]: forwarded example.com to 127.0.0.1#3053
Fri Nov 27 08:04:41 2026 [1795795481.200] daemon.info dnsmasq[28302]: reply example.com is 93.184.216.34
Fri Nov 27 08:04:42 2026 [1795795482.000] daemon.info dnsmasq-dhcp[28302]: DHCPACK(br-lan) 192.168.8.140 aa:bb:cc:dd:ee:ff
Sun Nov  1 01:00:00 2026 [1795795483.000] user.notice x: a single-digit day
Wed Oct 21 01:00:00 2026 [1795795484.000] user.notice x: dated before the router started
LINES
	run() { awk -v spool="$SPOOL" -v statef=$T/last -v bootday=2026-11-01 -v slevel="$1" -v klevel=6 -v dns="$2" -v fw=1 "$LOGREAD_AWK" < $T/in; }
	run 6 1
	cat $SPOOL/system/*.cur > $T/system; cat $SPOOL/kernel/*.cur > $T/kernel
	cat $SPOOL/firewall/*.cur > $T/firewall; cat $SPOOL/dns/*.cur > $T/dns
	cat $SPOOL/*/*.cur | wc -l > $T/before
	ls $SPOOL/system > $T/days
	cat $SPOOL/system/2026-11-01.cur > $T/nov01
	run 6 1   # the same lines again: a restarted collector must skip them
	cat $SPOOL/*/*.cur | wc -l > $T/after
	rm -rf $SPOOL $T/last; spool_dirs
	run 6 0
	cat $SPOOL/system/*.cur > $T/system_nodns
	rm -rf $SPOOL $T/last; spool_dirs
	run -1 0
	cat $SPOOL/system/*.cur > $T/system_off 2>/dev/null
	true
)
check "grep -q 'dropbear\[4295\]: Child connection' $T/system && ! grep -q 'debug noise' $T/system" "system log: info kept, debug left out at level info"
check "! grep -q '\[1795795477.166\]' $T/system && grep -q '^Fri Nov 27 08:04:37 2026 authpriv.info dropbear' $T/system" "system log: stored as logread shows it, without the extra time stamp"
check "grep -q 'DROP(src wan)' $T/firewall && ! grep -q DROP $T/kernel && ! grep -q DROP $T/system" "firewall blocks go to their own log, not the kernel log"
check "grep -q 'descriptor read error' $T/kernel" "kernel lines go to the kernel log"
check "[ \$(wc -l < $T/dns) = 1 ] && grep -q 'query\[A\] example.com' $T/dns" "DNS: only query lines are kept"
check "! grep -q 'dnsmasq\[28302\]' $T/system && grep -q 'dnsmasq-dhcp' $T/system" "dnsmasq's query lines stay out of the system log; its DHCP lines stay in"
check "grep -qx 2026-11-27.cur $T/days && grep -qx 2026-11-01.cur $T/days && [ \$(wc -l < $T/days) = 2 ]" "lines are filed under their own day; a single-digit day is read right"
check "grep -q 'before the router started' $T/nov01 && grep -q 'single-digit day' $T/nov01" "a line dated before the router started is kept, under the start day"
check "[ \$(cat $T/after) = \$(cat $T/before) ] && [ \$(cat $T/before) = 7 ]" "a restarted collector adds no duplicates"
check "! grep -q 'query\[' $T/system_nodns" "DNS off: query lines are dropped, not put in the system log"
check "[ ! -s $T/system_off ]" "system log off: nothing is kept"

# ----------------------------------------------------------- mesh, web
(
	REDBOOK_LIB=1 . /usr/bin/redbook
	load_config
	SPOOL=$T/spool2; RUN_DIR=$T/run; MESH_DIR=$T/mesh; mkdir -p $RUN_DIR $MESH_DIR; spool_dirs
	cat > $MESH_DIR/beerocks_agent.20261127_235506.log <<'M'
INFO 23:55:06:001 <548312286528> beerocks_agent_main.cpp[83] --> --- Start of file after roll ---
ERROR 23:59:12:052 <beerocks_agent> son_slave_thread.cpp[1125] --> before midnight
INFO 00:01:00:000 <beerocks_agent> x.cpp[1] --> info after midnight
ERROR 00:02:00:500 <beerocks_agent> y.cpp[2] --> after midnight
  continuation of the error
M
	echo "INFO 00:05:00:000 <x> still being written" > $MESH_DIR/beerocks_agent.20261128_000506.log
	ln -s beerocks_agent.20261128_000506.log $MESH_DIR/beerocks_agent.log
	ON_mesh=1; LEVEL_mesh=warn
	collect_mesh; collect_mesh
	cat $SPOOL/mesh/2026-11-27.cur > $T/mesh27 2>/dev/null; cat $SPOOL/mesh/2026-11-28.cur > $T/mesh28 2>/dev/null
	WEB_LOG=$T/error.log; ON_web=1; LEVEL_web=warn
	printf '2026/11/27 07:21:00 [error] 1#0: *5 first error\n2026/11/27 07:21:01 [info] 1#0: chatter\n2026/11/27 07:21:02 [error] 1#0: half a li' > $WEB_LOG
	collect_web
	cat $SPOOL/web/*.cur > $T/web1
	printf 'ne\n' >> $WEB_LOG
	collect_web
	cat $SPOOL/web/*.cur > $T/web2
)
check "[ \$(wc -l < $T/mesh27) = 1 ] && grep -q '^2026-11-27 23:59:12.052 beerocks_agent ERROR <beerocks_agent> son_slave_thread.cpp\[1125\] --> before midnight' $T/mesh27" "mesh: kept at level warning, with the day and part name added"
check "grep -q '^2026-11-28 00:02:00.500 beerocks_agent ERROR' $T/mesh28 && grep -q 'continuation of the error' $T/mesh28 && ! grep -q 'info after' $T/mesh28" "mesh: past midnight the next day is used; continuation lines follow their message"
check "! grep -q 'still being written' $T/mesh27 $T/mesh28 && [ \$(wc -l < $T/mesh27) = 1 ]" "mesh: the file still being written waits; a file is read once"
check "grep -q 'first error' $T/web1 && ! grep -q chatter $T/web1 && ! grep -q 'half a li' $T/web1" "web server: errors kept at level warn; a half-written line waits"
check "grep -q 'half a line' $T/web2 && [ \$(grep -c 'first error' $T/web2) = 1 ]" "web server: the line is taken whole once finished, and nothing twice"

# ----------------------------------------------------------- the drive
logger -p user.notice "rbtest-notice-1"
logger -p user.debug "rbtest-debug-1"
sleep 1
redbook flush >/dev/null 2>&1
check "grep -q rbtest-notice-1 $H/system/$TODAY.log && ! grep -q rbtest-debug-1 $H/system/$TODAY.log" "the system log reaches the drive, filtered by level"
check "grep -q 'Red Book started recording here' $H/boots/$TODAY.log" "the first start is recorded"
check "grep -q ' load=.* mem_avail_kb=[0-9]' $H/health/$TODAY.log" "a health sample is recorded"
check "grep -q -- '--- the kernel log since the router started' $H/kernel/*.log" "the kernel log since start is saved once"
check "[ \"\$(redbook status | jsonfilter -e @.storage.state)\" = ok ] && [ \"\$(redbook status | jsonfilter -e @.stats.sources.system.files)\" -ge 1 ]" "status: the storage is ok and the files are counted"

printf 'Thu Nov 26 10:00:00 2026 user.notice x: yesterday line\n' > $H/system/$YDAY.log
redbook flush >/dev/null 2>&1
check "[ -s $H/system/$YDAY.log.gz ] && [ ! -e $H/system/$YDAY.log ]" "a finished day is compressed"
check "cd $H/system && grep '  $YDAY.log.gz\$' SHA256SUMS | tail -n 1 | sha256sum -c -" "its SHA-256 is in SHA256SUMS and matches"
mkdir -p /var/run/redbook/spool/system
echo "late line for yesterday" > /var/run/redbook/spool/system/$YDAY.cur
redbook flush >/dev/null 2>&1
check "gzip -dc $H/system/$YDAY.log.gz | grep -q 'yesterday line' && gzip -dc $H/system/$YDAY.log.gz | grep -q 'late line for yesterday'" "a late line is added to a finished day"
check "cd $H/system && grep '  $YDAY.log.gz\$' SHA256SUMS | tail -n 1 | sha256sum -c -" "after a late line, the newest SHA256SUMS line matches"
OLD=$(date -d "@$(( $(date +%s) - 100 * 86400 ))" +%Y-%m-%d)
echo old | gzip > $H/system/$OLD.log.gz
( cd $H/system && sha256sum $OLD.log.gz >> SHA256SUMS )
redbook flush >/dev/null 2>&1
check "[ ! -e $H/system/$OLD.log.gz ] && ! grep -q $OLD $H/system/SHA256SUMS" "a day past the limit (90 days) is deleted, with its sum line"

# ----------------------------------------------------------- unplugged
uci set redbook.main.usb_path=/mnt/gone; uci commit redbook
logger -p user.notice "rbtest-while-away"
sleep 1
redbook flush >/dev/null 2>&1
check "[ \"\$(redbook status | jsonfilter -e @.storage.reason)\" = no_drive ]" "drive gone: the status says so"
check "[ ! -e /mnt/gone ]" "drive gone: nothing is written to the empty mount point (RAM)"
check "cat /var/run/redbook/spool/system/*.cur /var/run/redbook/spool/system/*.out 2>/dev/null | grep -q rbtest-while-away" "drive gone: the lines wait in the buffer"
awk 'BEGIN { for (i = 0; i < 400; i++) printf "filler line %d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n", i }' > /var/run/redbook/spool/conn/$YDAY.cur
REDBOOK_SPOOL_MAX_KB=24 redbook flush >/dev/null 2>&1
check "[ -s /var/run/redbook/spool/conn/dropped ] && [ ! -e /var/run/redbook/spool/conn/$YDAY.cur ]" "buffer full: the oldest lines go and are counted"
uci set redbook.main.usb_path=/mnt/usb; uci commit redbook
redbook flush >/dev/null 2>&1
check "grep -q rbtest-while-away $H/system/$TODAY.log" "drive back: the waiting lines are written"
check "grep -q 'lines of this log were lost between' $H/conn/$TODAY.log" "drive back: the log says how many lines were lost, and when"

# ----------------------------------------------------------- restart
sleep 25   # the daemon notices the changed settings and starts again
logger -p user.notice "rbtest-notice-2"
sleep 1
/etc/init.d/redbook restart >/dev/null 2>&1
sleep 4
redbook flush >/dev/null 2>&1
check "[ \$(grep -c rbtest-notice-1 $H/system/$TODAY.log) = 1 ] && [ \$(grep -c rbtest-notice-2 $H/system/$TODAY.log) = 1 ]" "after restarts every line is there once"
check "read -r id at < $H/.state/stopped && [ \"\$id\" = \"\$(cat /proc/sys/kernel/random/boot_id)\" ]" "a stop is recorded as clean"
check "[ \"\$(redbook status | jsonfilter -e @.collectors.logread)\" = true ]" "the collector runs again after a restart"
check "[ \$(ps w | grep -c '[l]ogread -f -t -l') = 1 ]" "after settings changes and restarts, exactly one collector runs (no orphans)"

# ----------------------------------------------------------- router settings
uci -q delete dhcp.@dnsmasq[0].logqueries
uci set firewall.@zone[1].log=0      # wan: a value of its own, to be put back
uci commit dhcp; uci commit firewall
uci set redbook.main.src_dns=1; uci set redbook.main.src_firewall=1
uci set redbook.main.syslog_send=1; uci set redbook.main.syslog_server=192.0.2.10; uci set redbook.main.syslog_proto=tcp
uci commit redbook
redbook apply
check "[ \"\$(uci -q get dhcp.@dnsmasq[0].logqueries)\" = 1 ]" "DNS on: dnsmasq logs queries"
check "[ \"\$(uci -q get firewall.@zone[1].log)\" = 1 ] && [ -z \"\$(uci -q get firewall.@zone[0].log)\" ]" "firewall on: wan logs blocks, lan is left alone"
check "[ \"\$(uci -q get system.@system[0].log_ip)\" = 192.0.2.10 ] && [ \"\$(uci -q get system.@system[0].log_proto)\" = tcp ]" "syslog server: logd sends to it"
check "[ \"\$(redbook status | jsonfilter -e @.router.dns_logging)\" = true ]" "status: shows the router settings"
uci set redbook.main.syslog_server=192.0.2.11; uci commit redbook
redbook apply
check "[ \"\$(uci -q get system.@system[0].log_ip)\" = 192.0.2.11 ]" "syslog server: a new address is used"
uci set redbook.main.src_dns=0; uci set redbook.main.src_firewall=0; uci set redbook.main.syslog_send=0; uci commit redbook
redbook apply
check "[ -z \"\$(uci -q get dhcp.@dnsmasq[0].logqueries)\" ]" "DNS off: dnsmasq's setting is back as it was (not set)"
check "[ \"\$(uci -q get firewall.@zone[1].log)\" = 0 ]" "firewall off: wan's own value is back"
check "[ -z \"\$(uci -q get system.@system[0].log_ip)\" ] && [ -z \"\$(uci -q get system.@system[0].log_proto)\" ]" "syslog off: logd's settings are back as they were"
check "[ ! -s /etc/redbook/applied ]" "nothing is left marked as changed"

# ----------------------------------------------------------- hostile input
uci set redbook.main.usb_path='/mnt/usb;touch /tmp/pwned1'
uci set redbook.main.net_server='-o /tmp/pwned2'
uci set redbook.main.net_share='x$(touch /tmp/pwned3)'
uci set redbook.main.flush_minutes='1;touch /tmp/pwned4'
uci commit redbook
redbook flush >/dev/null 2>&1; redbook status >/dev/null 2>&1; redbook test-network >/dev/null 2>&1
redbook lines 'system;touch /tmp/pwned5' 5 >/dev/null 2>&1
redbook lines system 5 '$(touch /tmp/pwned6)' >/dev/null 2>&1
check "! ls /tmp/pwned* 2>/dev/null" "hostile settings and arguments run nothing"
check "[ \"\$(redbook status | jsonfilter -e @.storage.reason)\" = bad_path ]" "a hostile drive folder is refused, and the logs do not go to another drive"
uci set redbook.main.usb_path=/mnt/usb; uci -q delete redbook.main.net_server; uci -q delete redbook.main.net_share
uci set redbook.main.flush_minutes=15; uci commit redbook

# ----------------------------------------------------------- the password
PW='Pa ss,w"o'"'"'r$d`1<b>'
printf '%s\n' "$PW" | redbook set-secret >/dev/null
check "[ \"\$(uci -q get redbook_auth.main.net_password)\" = \"\$PW\" ]" "the password is saved exactly"
check "[ \"\$(ls -l /etc/config/redbook_auth | cut -c1-10)\" = -rw------- ]" "the password file is root only"
redbook flush >/dev/null 2>&1
check "! grep -rqF 'w\"o' $H /var/run/redbook && ! logread | grep -qF 'w\"o' && ! redbook status | grep -qF 'w\"o'" "the password is in no stored file, log or status"

# ----------------------------------------------------------- the pages' calls
check "redbook lines system 5 rbtest | jsonfilter -e @.text | grep -q rbtest-notice" "lines: returns the newest lines, filtered"
check "[ \"\$(redbook lines nosuch 5 | jsonfilter -e @.error)\" = unknown_source ]" "lines: an unknown source is refused"
check "redbook drives | jsonfilter -e '@.drives[*].path' | grep -qx /mnt/usb" "drives: the drive is listed"
check "ubus call luci.redbook status >/dev/null 2>&1 || ! pidof rpcd" "rpcd: the status call answers"

[ "$fail" = 0 ] && echo && echo "all checks passed"
[ "$fail" = 0 ] || { echo; echo "$fail check(s) failed"; exit 1; }
TEST
