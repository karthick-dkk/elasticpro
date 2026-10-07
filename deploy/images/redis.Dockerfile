# Redis for the hosted fleet cache, one layer above the official image.
#
# redis:8-alpine is the right base — redis:7-alpine carried four HIGH OpenSSL advisories
# and 8-alpine carries none — but it still ships whatever Alpine packages were current at
# its last rebuild, which at the time of writing means zlib 1.3.2-r0 and CVE-2026-85091.
# One `apk upgrade` takes it to zero. Redis itself is untouched.
#
# Delete this file and use the plain tag the day upstream rebuilds often enough to scan
# clean on its own.
FROM redis:8-alpine
RUN apk --no-cache upgrade
