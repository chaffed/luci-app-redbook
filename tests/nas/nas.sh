#!/bin/sh
# A file server on this Mac for testing Red Book's network folder from a real
# router (tests/nas/nas.yaml: SMB and NFS in a small Lima VM).
#
#   sh tests/nas/nas.sh up       make the VM (first time) and start it
#   sh tests/nas/nas.sh info     the addresses, shares and user to type in
#   sh tests/nas/nas.sh check    mount each share from inside the VM
#   sh tests/nas/nas.sh down     stop it (ports 445 and 2049 are freed)
#   sh tests/nas/nas.sh delete   remove the VM and its files
#
# The SMB password is made once and kept outside the repository, in
# ~/.config/redbook-nas/password (mode 600). Needs Lima (brew install lima).
set -eu
NAME=redbook-nas
HERE=$(cd "$(dirname "$0")" && pwd)
CONF=$HOME/.config/redbook-nas
PWFILE=$CONF/password

exists() { limactl list -q 2>/dev/null | grep -qx "$NAME"; }
mac_ip() {
	ifc=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')
	ipconfig getifaddr "${ifc:-en0}" 2>/dev/null || echo "<this Mac's address>"
}

case "${1:-}" in
up)
	if [ ! -s "$PWFILE" ]; then
		mkdir -p "$CONF"; chmod 700 "$CONF"
		(umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20 > "$PWFILE")
	fi
	if ! exists; then
		limactl create --tty=false --name "$NAME" --set ".param.PASSWORD = \"$(cat "$PWFILE")\"" "$HERE/nas.yaml"
	fi
	limactl start --tty=false "$NAME"
	sh "$0" info
	;;
info)
	ip=$(mac_ip)
	echo "Server:  $ip"
	echo "SMB:     share logs (writable), readonly (read only); user rbtest, password in $PWFILE"
	echo "NFS:     /srv/nfs/logs (writable), /srv/nfs/readonly (read only)"
	echo "In the VM, written files are under /srv/smb/logs and /srv/nfs/logs:"
	echo "         limactl shell $NAME sudo ls -R /srv/smb/logs /srv/nfs/logs"
	echo "SMB logins and why one failed:"
	echo "         limactl shell $NAME sudo grep Auth: /var/log/samba/log.smbd"
	;;
check)
	# Mounts each share over the VM's own address, the way a client would.
	limactl shell "$NAME" sudo sh -s "$(cat "$PWFILE")" <<'EOF'
set -u
command -v mount.cifs >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q cifs-utils >/dev/null
m=$(mktemp -d); rc=0
cred=$(mktemp); printf 'username=rbtest\npassword=%s\n' "$1" > "$cred"
if mount -t cifs //127.0.0.1/logs "$m" -o "credentials=$cred" && touch "$m/.check" && rm "$m/.check"; then echo "ok   SMB logs: mounted and written"; else echo "FAIL SMB logs"; rc=1; fi
umount "$m" 2>/dev/null
if mount -t cifs //127.0.0.1/readonly "$m" -o "credentials=$cred" && ! touch "$m/.check" 2>/dev/null; then echo "ok   SMB readonly: mounted, not writable"; else echo "FAIL SMB readonly"; rc=1; fi
umount "$m" 2>/dev/null; rm -f "$cred"
if mount -t nfs -o vers=4 127.0.0.1:/srv/nfs/logs "$m" && touch "$m/.check" && rm "$m/.check"; then echo "ok   NFS logs: mounted and written"; else echo "FAIL NFS logs"; rc=1; fi
umount "$m" 2>/dev/null
if mount -t nfs -o vers=4 127.0.0.1:/srv/nfs/readonly "$m" && ! touch "$m/.check" 2>/dev/null; then echo "ok   NFS readonly: mounted, not writable"; else echo "FAIL NFS readonly"; rc=1; fi
umount "$m" 2>/dev/null; rmdir "$m"
exit $rc
EOF
	;;
down) limactl stop "$NAME" ;;
delete) limactl delete -f "$NAME" ;;
*) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
