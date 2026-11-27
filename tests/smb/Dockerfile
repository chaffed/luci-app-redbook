# A Samba server for tests/network.test.sh: one share, "logs", for user
# rbuser (the password is set when the container starts).
FROM alpine:3.20
RUN apk add --no-cache samba-server samba-common-tools
RUN printf '[global]\n  server min protocol = SMB2\n  map to guest = never\n  log level = 1\n[logs]\n  path = /share\n  read only = no\n  valid users = rbuser\n  force user = root\n' > /etc/samba/smb.conf \
	&& mkdir -p /share && adduser -D -H rbuser
CMD ["sh", "-c", "printf '%s\\n%s\\n' \"$SMB_PASS\" \"$SMB_PASS\" | smbpasswd -a -s rbuser >/dev/null && exec smbd -F --no-process-group -d 1"]
