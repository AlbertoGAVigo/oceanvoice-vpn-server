FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openvpn easy-rsa ca-certificates iproute2 \
    && rm -rf /var/lib/apt/lists/*
COPY server.conf /etc/openvpn/server.conf
COPY entrypoint.sh /usr/local/bin/vpn-entrypoint
RUN chmod 0755 /usr/local/bin/vpn-entrypoint
ENTRYPOINT ["/usr/local/bin/vpn-entrypoint"]
