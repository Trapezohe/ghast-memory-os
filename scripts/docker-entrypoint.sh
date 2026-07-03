#!/bin/sh
set -eu

set -- serve \
  --db /data/gmos.db \
  --host-iface 0.0.0.0 \
  --port "${GMOS_SERVE_PORT:-4787}" \
  --rate-limit "${GMOS_SERVE_RATE_LIMIT:-600}"

case "${GMOS_SERVE_ALLOW_NON_LOOPBACK:-1}" in
  1|true|TRUE|yes|YES|on|ON) set -- "$@" --allow-non-loopback ;;
esac

case "${GMOS_SERVE_KEYS:-1}" in
  1|true|TRUE|yes|YES|on|ON) set -- "$@" --keys ;;
esac

if [ "${GMOS_SERVE_AUDIT_RETENTION_DAYS:-}" != "" ]; then
  set -- "$@" --audit-retention-days "$GMOS_SERVE_AUDIT_RETENTION_DAYS"
fi

exec gmos "$@"
