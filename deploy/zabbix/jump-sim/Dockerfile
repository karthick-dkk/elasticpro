# A stand-in for a Windows jump host, for testing the "Windows jump host (SSH)" template
# without one: OpenSSH, and curl answering to the name curl.exe. The template's command is
# written for cmd.exe; it parses the same way in sh, which is what this checks.
FROM alpine:3.20
RUN apk add --no-cache openssh-server curl \
 && printf '#!/bin/sh\nexec curl "$@"\n' > /usr/local/bin/curl.exe && chmod 755 /usr/local/bin/curl.exe \
 && adduser -D -s /bin/sh elasticpro && passwd -u elasticpro >/dev/null 2>&1; \
    sed -i -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
           -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
