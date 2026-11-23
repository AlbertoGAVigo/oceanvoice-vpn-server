#!/bin/sh
set -eu
umask 077

state=/var/lib/openvpn
export EASYRSA_PKI="$state/pki"
export EASYRSA_BATCH=1
easyrsa=/usr/share/easy-rsa/easyrsa

if [ ! -d "$EASYRSA_PKI" ]; then
    "$easyrsa" init-pki
fi
if [ ! -s "$EASYRSA_PKI/ca.crt" ]; then
    EASYRSA_REQ_CN=OceanVoice-VPN-CA "$easyrsa" build-ca nopass
fi
if [ ! -s "$EASYRSA_PKI/issued/oceanvoice-server.crt" ]; then
    "$easyrsa" build-server-full oceanvoice-server nopass
fi
if [ ! -s "$EASYRSA_PKI/crl.pem" ]; then
    "$easyrsa" gen-crl
fi
if [ ! -s "$state/tls-crypt.key" ]; then
    openvpn --genkey secret "$state/tls-crypt.key.tmp"
    mv "$state/tls-crypt.key.tmp" "$state/tls-crypt.key"
fi

# OpenVPN reopens the CRL and updates the pool file after dropping privileges.
chmod 0711 "$state" "$EASYRSA_PKI"
chmod 0644 "$EASYRSA_PKI/crl.pem"
touch "$state/ipp.txt"
chown nobody:nogroup "$state/ipp.txt"
exec openvpn --config /etc/openvpn/server.conf
