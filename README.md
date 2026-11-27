# Red Book

**Red Book** keeps your router's logs. An OpenWrt router keeps its log in
memory: a few days at most, gone at every restart or power cut. Red Book
writes it, and the other logs worth keeping, to a **USB drive** or a
**network folder** (SMB or NFS), one file per log and day, compressed and
checksummed, for as long as you choose. Use it to find out what happened last
Tuesday at 3 am, or to look back at who tried to get in.

It is a LuCI app for OpenWrt 23.05 and GL.iNet routers (firmware 4.x), built
on a GL-BE9300. On GL.iNet routers it also appears in GL's own admin panel,
under **Applications → Red Book**; in LuCI it is under **Services → Red Book**.

The name is from the Red Book of Westmarch, the book in which Bilbo and Frodo
wrote down everything that happened.

## What it keeps

Each log can be turned on or off, with its own lowest level kept (where the
log has levels) and its own number of days.

| Log | On at first | What is in it |
|---|---|---|
| System log | yes, info and up, 90 days | Wi-Fi joins and leaves, DHCP, logins, VPN, the rest of the system log |
| Kernel log | yes, info and up, 90 days | drivers, Wi-Fi firmware, USB, network ports; the whole kernel log since start, once per start |
| Crash records | yes, 365 days | kernel crash records the router keeps in flash |
| Restarts | yes, 365 days | when the router started, when it was last seen before, and whether it shut down cleanly |
| System health | yes, 90 days | every 5 minutes: load, free memory, temperature, connections, uptime |
| Web server errors | yes, warnings and up, 90 days | errors from the web server behind the admin panel and LuCI |
| Mesh logs | no | the mesh controller and agent (very large below "warning") |
| DNS queries | no | every name each device looks up |
| Firewall blocks | no | packets dropped or rejected in every zone but LAN |
| Connections | no | every new connection: device, destination, port |

DNS queries, firewall blocks and connections show what every device on your
network does. Turn them on knowingly: the files are not encrypted, and anyone
who can read the drive or the folder can read them.

## Where the files go

```
<drive or folder>/redbook/<router name>/
    system/2026-11-26.log.gz      finished days, compressed
    system/2026-11-27.log         today, plain text
    system/SHA256SUMS             a SHA-256 for every finished day
    kernel/…  boots/…  health/…
```

- Read a finished day with `zcat`, `zgrep` or 7-Zip; check it with
  `sha256sum -c SHA256SUMS`. If late lines are added to a finished day, a new
  line for it is added to `SHA256SUMS`; the last one for a file counts.
- Lines are written every 1, 5 or 15 minutes. Until then they wait in memory,
  so a power cut loses at most that much.
- **An unplugged drive or an unreachable folder never loses lines silently.**
  Lines wait in memory (up to 16 MB). If that fills up, the oldest are
  dropped and the log gets a line saying how many were lost, and between
  which times.
- Nothing is written until the router's clock has been set from the
  internet, so every line lands under the right day.
- With a USB drive, the files can also be **copied to a network folder** after
  every write, as a second copy.

The Overview page shows where the logs go, how much space is left, each log's
size, and the newest lines of any log, with a search box.

## Router settings Red Book changes

Only while the matching option is on, and put back exactly as they were when
it is turned off or the app is removed:

| Option | Router setting |
|---|---|
| DNS queries | dnsmasq's query logging |
| Firewall blocks | logging in every firewall zone but LAN |
| Syslog server | the system log's remote server, port and protocol |

## Sending the log to a syslog server

Red Book can also have the router's own log daemon send every line to a
syslog server as it happens (UDP or TCP). The Syslog server tab shows a
ready-made config for **rsyslog**, **syslog-ng** and classic **syslogd** on
the receiving machine, saving one file per router per day. Red Book does not
replace the router's log daemon: GL's own log page keeps working.

## Network folders

SMB (Windows, macOS, a NAS, Samba) and NFS. The router needs a little support
software for them, which the Network folder tab installs from the router's
own package source with one click (`kmod-fs-cifs cifsmount` for SMB, plus
`kmod-crypto-md4` on kernels before 5.15, such as GL firmware 4.x;
`kmod-fs-nfs kmod-fs-nfs-v3 kmod-fs-nfs-v4 nfs-utils` for NFS). The password
is kept in a file only root can read; it is never shown again, never put on a
command line, and never written to a log.

## Install

Through the package source at
[chaffed.github.io/openwrt-packages](https://chaffed.github.io/openwrt-packages)
(`opkg install luci-app-redbook`), or download the `.ipk` from the
[latest release](https://github.com/chaffed/luci-app-redbook/releases/latest),
copy it to the router and run:

```sh
opkg update
opkg install /tmp/luci-app-redbook_*.ipk
```

## Build and test

```sh
scripts/build-ipk.sh          # dist/luci-app-redbook_<version>-r<release>_all.ipk
node tests/settings.test.js   # the settings agree everywhere
sh tests/backend.test.sh      # the backend on OpenWrt 23.05 (Docker)
sh tests/network.test.sh      # the network folder against a Samba server (Docker, cifs module)
node tests/web.test.js        # both web UIs in Chrome (npm install --no-save playwright-core)
sh tests/install.test.sh      # install, upgrade, remove, install again
```

No OpenWrt SDK needed: the package is architecture independent.

## License

MIT
