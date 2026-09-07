#!/usr/bin/env bash
#
# Empaqueta el .ehpk inyectando el dominio real en el whitelist.
#
# POR QUE EXISTE ESTE SCRIPT: `app.json` esta en el repositorio con un
# PLACEHOLDER a proposito. El dominio de tu servidor no es un secreto
# criptografico, pero es un PUNTERO: dice que maquina es tuya y que corre en
# ella. En un repo publico eso enlaza tu identidad de GitHub con tu servidor.
#
# El dominio real vive en `glasses/.env` (ignorado por git) y solo entra al
# paquete, nunca al repositorio.
#
set -euo pipefail
cd "$(dirname "$0")"

PLACEHOLDER='https://TU-SERVIDOR.example.org'

if [ ! -f .env ]; then
  echo "falta glasses/.env con VITE_API_BASE=https://tu-dominio" >&2
  exit 1
fi

BASE=$(grep -E '^[[:space:]]*VITE_API_BASE=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r' | xargs)
if [ -z "$BASE" ]; then
  echo "VITE_API_BASE vacio o ausente en glasses/.env" >&2
  exit 1
fi

VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' app.json | head -1)
if [ -z "$VER" ]; then
  echo "no se pudo leer version de app.json" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sed "s#${PLACEHOLDER}#${BASE}#g" app.json > "$TMP/app.json"

# GUARDA: si el placeholder sobrevive, el paquete saldria con un whitelist
# invalido y la app fallaria SOLO en el hardware (el simulador no lo aplica).
if grep -q 'TU-SERVIDOR.example.org' "$TMP/app.json"; then
  echo "el placeholder no se sustituyo; revisa app.json" >&2
  exit 1
fi

npx vite build
npx evenhub pack "$TMP/app.json" dist -o "vozgram-${VER}.ehpk"

echo "listo: glasses/vozgram-${VER}.ehpk  (whitelist apuntando a tu dominio real)"
