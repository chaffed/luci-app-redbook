# Red Book

Keeps the router's logs on a USB drive or network folder for troubleshooting and security analysis.

An OpenWrt package (`luci-app-redbook`) with pages in LuCI (Services → Red Book) and in the GL.iNet admin panel (Applications → Red Book). Tested on OpenWrt 23.05, the release GL.iNet firmware 4.x is built on.

## Install

Download the `.ipk` from the [latest release](https://github.com/chaffed/luci-app-redbook/releases/latest), copy it to the router and run:

```sh
opkg update
opkg install /tmp/luci-app-redbook_*.ipk
```

## Build

```sh
scripts/build-ipk.sh        # writes dist/luci-app-redbook_<version>-r<release>_all.ipk
```

No OpenWrt SDK needed: the package is architecture independent.

## License

MIT
