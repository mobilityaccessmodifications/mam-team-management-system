#!/bin/sh
set -eu
umask 077

reject() {
    printf '%s\n' 'UAT gateway configuration rejected.' >&2
    exit 78
}

validate_key() {
    case "$1" in ''|*[!A-Za-z0-9_.-]*) reject ;; esac
    [ "${#1}" -le 4096 ] || reject
    case "$1" in *.*.*) ;; *) reject ;; esac
    key_header=${1%%.*}
    key_tail=${1#*.}
    key_payload=${key_tail%%.*}
    key_signature=${key_tail#*.}
    [ -n "$key_header" ] && [ -n "$key_payload" ] && [ -n "$key_signature" ] || reject
    case "$key_signature" in *.*) reject ;; esac
}

validate_key "${MAM_UAT_ANON_KEY:-}"
validate_key "${MAM_UAT_SERVICE_ROLE_KEY:-}"
[ "$MAM_UAT_ANON_KEY" != "$MAM_UAT_SERVICE_ROLE_KEY" ] || reject
export NGINX_ENVSUBST_FILTER='^(MAM_UAT_ANON_KEY|MAM_UAT_SERVICE_ROLE_KEY)$'
export NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/templates
export NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d
export NGINX_ENVSUBST_TEMPLATE_SUFFIX=.template
export NGINX_ENTRYPOINT_QUIET_LOGS=1
mkdir -p /tmp/client_body /tmp/proxy
/bin/sh /docker-entrypoint.d/20-envsubst-on-templates.sh
[ -s /etc/nginx/conf.d/uat.conf ] || reject
if [ "$#" -eq 0 ]; then
    set -- nginx -g 'daemon off;'
fi
exec "$@"
