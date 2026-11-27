# OpenWrt 23.05 with what a router needs for an SMB network folder
# (mount.cifs from the package source) and busybox's missing timeout, as on
# GL firmware. For tests/network.test.sh; the kernel's cifs module comes
# from the Docker host.
#
# The container runs privileged (mount needs it), and then OpenWrt's own
# boot takes down the interface Docker set up. So it does not boot: it runs
# only ubusd and logd, which Red Book needs, and the test starts Red Book.
FROM openwrt/rootfs:x86-64-23.05.6
RUN mkdir -p /var/lock /var/run && opkg update && opkg install cifsmount coreutils-timeout && rm -rf /tmp/opkg-lists
CMD ["sh", "-c", "mkdir -p /var/run/ubus /var/lock /var/state && /sbin/ubusd & sleep 1; /sbin/logd -S 64 & exec sleep 2147483647"]
