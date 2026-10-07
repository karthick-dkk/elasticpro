# PostgreSQL for the hosted stack, rebuilt from the official image to carry no known
# vulnerabilities.
#
# Every advisory against postgres:16-alpine — one CRITICAL and twenty-one HIGH — is in
# /usr/local/bin/gosu, a statically linked Go binary with an old Go standard library.
# No package manager can patch it, and 17-alpine and 18-alpine report the identical
# twenty-two, so moving the database major would not have helped. The Debian variants are
# worse: 16-bookworm reports 4 CRITICAL / 84 HIGH, 16-trixie 2 CRITICAL / 82 HIGH.
# PostgreSQL itself was never the problem — 16.15 is the current patch of a supported line.
#
# So: replace gosu with su-exec, Alpine's few-hundred-lines-of-C equivalent, which does the
# one thing the entrypoint asks of it (`gosu postgres …`) and has no runtime of its own to
# go stale. Then flatten.
#
# The flattening matters and is not cosmetic. Deleting a file in a later layer leaves it in
# the earlier one, and a scanner walking layers still finds and reports it — verified: the
# unflattened version still reported all twenty-two even with a cold cache, while the same
# container's live filesystem scanned clean. Copying the finished tree into `scratch` gives
# one layer with no history behind it, so the binary is gone in the only sense that can be
# audited from outside.
FROM postgres:16-alpine AS patched
RUN apk --no-cache upgrade \
  && apk add --no-cache su-exec \
  && rm -f /usr/local/bin/gosu \
  && ln -s /sbin/su-exec /usr/local/bin/gosu

FROM scratch
COPY --from=patched / /
# Reproduced from `docker inspect postgres:16-alpine`. GOSU_VERSION is deliberately dropped:
# gosu is no longer present and advertising a version for it would be a lie.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=en_US.utf8 \
    PG_MAJOR=16 \
    PG_VERSION=16.15 \
    PGDATA=/var/lib/postgresql/data
EXPOSE 5432
VOLUME /var/lib/postgresql/data
WORKDIR /
STOPSIGNAL SIGINT
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]
