#!/usr/bin/env bash
# Builds backend/data/map/brasil.pmtiles: the map of Brazil the site serves itself, so that a visitor's address reaches
# no outside map service (RNF34). Run once per server, and again only to refresh the streets. Outside Brazil there is
# no map, on purpose: the event shows the written location.
# Needs the pmtiles tool (https://github.com/protomaps/go-pmtiles/releases): 4.6 GB of download, 4.4 GB on disk.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD="${1:-$(date -v-2d +%Y%m%d 2>/dev/null || date -d '2 days ago' +%Y%m%d)}"
mkdir -p backend/data/map
pmtiles extract "https://build.protomaps.com/$BUILD.pmtiles" backend/data/map/brasil.pmtiles \
  --region=infra/map/brasil.geojson --maxzoom="${MAX_ZOOM:-15}"
pmtiles verify backend/data/map/brasil.pmtiles
