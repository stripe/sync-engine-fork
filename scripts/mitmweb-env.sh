#!/bin/bash
# Source this file to route Node/Bun/curl fetch traffic through mitmweb.
#   source scripts/mitmweb-env.sh
#
# mitmweb must already be running on port 8080 with upstream proxy:
#   mitmweb --listen-port 8080 --web-port 8081 --no-web-open-browser \
#     --mode "upstream:http://dynamic-egress-proxy.service.envoy:10071" \
#     --ssl-insecure --set connection_strategy=lazy

MITM_PROXY="http://127.0.0.1:8080"
MITM_CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"

if ! ss -tlnp 2>/dev/null | grep -q ':8080 '; then
  echo "mitmweb is not running on port 8080. Starting it..."
  mitmweb \
    --listen-port 8080 \
    --web-port 8081 \
    --no-web-open-browser \
    --mode "upstream:http://dynamic-egress-proxy.service.envoy:10071" \
    --ssl-insecure \
    --set connection_strategy=lazy \
    2>/dev/null &
  sleep 3
  if ! ss -tlnp 2>/dev/null | grep -q ':8080 '; then
    echo "ERROR: Failed to start mitmweb"
    return 1 2>/dev/null || exit 1
  fi
fi

# -- Proxy settings (both cases for compat) --
export HTTP_PROXY="$MITM_PROXY"
export HTTPS_PROXY="$MITM_PROXY"
export http_proxy="$MITM_PROXY"
export https_proxy="$MITM_PROXY"

# Override no_proxy so traffic actually goes through mitmweb
export NO_PROXY="localhost,127.0.0.1,::1,*.local,*.localhost"
export no_proxy="$NO_PROXY"

# -- Node.js (--use-env-proxy makes undici/fetch respect HTTP_PROXY) --
export NODE_EXTRA_CA_CERTS="$MITM_CA"
export NODE_TLS_REJECT_UNAUTHORIZED="0"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy"

# -- npm/pnpm --
export npm_config_proxy="$MITM_PROXY"
export npm_config_https_proxy="$MITM_PROXY"
export npm_config_no_proxy="$NO_PROXY"

# -- curl / system TLS --
export CURL_CA_BUNDLE="$MITM_CA"
export SSL_CERT_FILE="$MITM_CA"
export SSL_CERT_DIR="$HOME/.mitmproxy"

# -- Go --
export GOPROXY="$MITM_PROXY,direct"
export GOFLAGS="-insecure"

# -- Python --
export REQUESTS_CA_BUNDLE="$MITM_CA"

# -- Git --
export GIT_SSL_CAINFO="$MITM_CA"

# -- global-agent (used by some Node libs) --
export GLOBAL_AGENT_HTTP_PROXY="$MITM_PROXY"
export GLOBAL_AGENT_NO_PROXY="$NO_PROXY"

echo "----------------------------------------------"
echo "--------  MITMWEB INTERCEPT ACTIVE  ----------"
echo "----------------------------------------------"
echo "Proxy:   $MITM_PROXY"
echo "Web UI:  http://127.0.0.1:8081"
echo "CA Cert: $MITM_CA"
echo ""
echo "All HTTP/HTTPS from this shell is routed through mitmweb."
echo "Supports: Node fetch, Bun fetch, curl, Python requests, Go net/http"
echo ""
echo "To stop: unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS"
