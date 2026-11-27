# luci-app-redbook

Red Book: keeps the router's logs on a USB drive or a network folder (SMB, NFS), for troubleshooting and security analysis. An OpenWrt package with pages in LuCI and in the GL.iNet admin panel (firmware 4.x).

## Working on this repo

- Built from the `openwrt-router-app` skill's template; that skill's references hold the LuCI, GL.iNet panel, packaging and testing rules this app follows. Load it before touching the web UI, the GL panel, the package scripts or the tests.
- **Settings are described once**, in `schema()` in `htdocs/luci-static/resources/redbook/common.js`. LuCI's `settings.js` and the GL panel's form (`gl.js`) are both drawn from it. A new setting also needs: `FIELDS` (and `CHOICES` for a select) in `root/usr/lib/oui-httpd/rpc/redbook`, a default in `root/etc/config/redbook`, and reading it in the backend's `load_config` with a fallback and a whitelist. `node tests/settings.test.js` checks all of it.
- **Log sources** are listed in four places, in the same order: `SOURCES` in the backend, in the panel module, in common.js, and the defaults in `/etc/config/redbook`; the backend's `default_on/days/level` must match common.js. The settings test checks.
- **A gap is never silent.** Lines wait in a RAM buffer and are written only after checking the storage is really there (an unplugged drive's mount point is a RAM folder). If the buffer fills, dropped lines are counted and a note goes into the log. Don't add a path that writes without `resolve_storage`.
- **Router settings Red Book changes** (dnsmasq logqueries, firewall zone `log`, system `log_ip/port/proto`) are changed only in `do_apply`, with the original value saved in `/etc/redbook/applied` first, and put back by `do_apply revert` (prerm runs `redbook revert`). Never change another config any other way.
- The network folder's password lives only in `/etc/config/redbook_auth` (mode 600), key `net_password`. It reaches mount.cifs in a credentials file in RAM that is deleted straight after mounting. Never on a command line, in a log or a reply; the web and network tests check with a password full of quoting characters.
- Strings passed to `.format()` write a literal percent as `%%` (the settings test checks).
- A real file server for testing from a router: `sh tests/nas/nas.sh up` makes a small Lima VM serving SMB and NFS on this Mac's LAN address (ports 445 and 2049 only), `nas.sh info` says what to type in. `sh tests/nas/nfs-check.sh` runs Red Book's NFS folder from the OpenWrt container against it.
- Tests: `node tests/settings.test.js`; `sh tests/backend.test.sh`, `sh tests/install.test.sh` (Docker); `sh tests/network.test.sh` (Docker, and the kernel's cifs module: `colima ssh -- sudo modprobe cifs` on this Mac); `node tests/web.test.js` (Docker + Chrome + `npm install --no-save playwright-core`). Test output goes to `.test-out/` because Docker Desktop on macOS doesn't share the system temp folder. Look at the screenshots in `.test-out/web/`.
- Release: bump `PKG_VERSION` in the Makefile and `VERSION` in the backend, tag `vX.Y.Z`, push the tag; CI attaches the .ipk to a GitHub release. Then add `luci-app-redbook` to `openwrt-packages/packages.txt` (once) and run its publish workflow: only on the owner's go-ahead.

## Facts learned the hard way

- **Many log lines share a millisecond**: a quarter of the GL-BE9300's buffer did. A restarted collector cannot skip by time alone (`e <= last` dropped over 1,000 of 4,064 lines): `logread.last` holds the newest stamp and every line kept with it, and only those copies are skipped.
- **SMB on Linux before 5.15 needs the kernel's MD4** (`kmod-crypto-md4`) for the NT hash under every NTLM login. GL's `kmod-fs-cifs` does not depend on it, and without it Samba sees a wrong password (`NT_STATUS_WRONG_PASSWORD`; `mount error(13)`). From 5.15 cifs has its own. Seen on the mesh node (5.4.213).
- **GL's NFS modules crash the GL-BE9300**: installing `kmod-fs-nfs` from GL's package source on firmware 4.10.1 panicked the kernel as the `grace` module loaded (`opens_in_grace` from `init_module`), and the router restarted. Nothing stayed installed. Red Book's crash and restart logs recorded it.
- `logread -f` prints **no backlog**; `logread -f -l N` prints the last N lines, then follows. `-t` adds `[epoch.ms]` after the date, which is how a restarted collector skips lines it already has (`/var/run/redbook/logread.last`). The stamp is removed before storing.
- The shell starts the collectors as `/sbin/logread`, `/usr/sbin/conntrack` (that is their cmdline): match on `*"logread -f -t -l "*`, not `"logread …"*`, or a restart leaves an orphan reader and starts no new one.
- On OpenWrt `/var` is a link to `/tmp`: `/proc/mounts` lists the network mount as `/tmp/run/redbook/net`. Compare against `pwd -P` of the mount point.
- mount.cifs with `iocharset=utf8` fails with `error(79)` when the kernel has no `nls_utf8` module; leave it out. `error(101)` is network unreachable.
- busybox awk has no `[\[\]]` bracket class (it silently matches nothing): use `substr`. It does have `strftime`, `systime` and `mktime`.
- The plain OpenWrt 23.05 x86 image's busybox has no `timeout`; GL's does. The backend's `tmo` uses it when present.
- `du` counts 4 KB per folder outside tmpfs: measure the buffer by bytes of its files (`spool_bytes`).
- An init script can hang (dnsmasq's did, in a container): other services are reloaded in the background (`reload_bg`) so the logs keep being kept.
- The GL panel and `uci commit` don't tell procd about a settings change; the daemon compares a checksum of `uci show redbook` every loop and starts again in place (`exec`).
- GL mesh logs (`/tmp/beerocks/logs`) rotate every 10 minutes and keep 3 files. Lines carry only the time; the day comes from the file name. Firmware 4.10 repeats a few errors several times a second: about 110 MB a day even at "warning" (measured on the mesh node), so exact repeats are kept once per file with a count (1.56 MB → 23 KB).
- GL firmware puts the old nginx error log (`/tmp/log/nginx/error.log`, in RAM) back after a restart, with lines weeks old. A read position kept in RAM re-reads it all: the newest stored line and the lines of that second are kept in `<storage>/.state/web.last` instead. Seen on the mesh node's first reboot test.
- GL 4.10 runs fw4 (nftables): look for `log prefix` with `nft list ruleset`, not iptables. GL's own SYN_FLOOD and ICMP rules log packets, which is why packet lines stay in the kernel log while the firewall log is off.
- dnsmasq with `logqueries=1` writes several lines per lookup into logd's 512 KB buffer: only `query[` lines are kept, and none go to the system log.
- Test rigs: an OpenWrt container run `--privileged` (needed to mount) loses its network to OpenWrt's own boot, so `tests/openwrt-net` does not boot and starts only ubusd and logd. In a non-privileged container dnsmasq crash-loops (it cannot make its jail).

## Agent skills

### Issue tracker

GitHub Issues on chaffed/luci-app-redbook, through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
