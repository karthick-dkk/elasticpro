# nginx for the hosted stack, one layer above the official image.
#
# Why this exists: nginx:1.30-alpine is the current stable line and still scans with two
# HIGH advisories (pcre2 and libexpat), both of which Alpine has already published fixes
# for. The official image is only rebuilt periodically, so between rebuilds it ships
# packages that `apk upgrade` would fix in seconds. This layer does exactly that and
# nothing else — no configuration, no added packages, no new attack surface.
#
# Delete this file and go back to the plain image the day upstream rebuilds often enough
# that it scans clean on its own.
FROM nginx:1.30-alpine
RUN apk --no-cache upgrade
