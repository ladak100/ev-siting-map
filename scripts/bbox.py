"""Shared GGH bounding box, per ev-siting-map-architecture.md. Every fetch script
filters/clips to this box so all layers line up on the same map extent."""

WEST = -80.5
EAST = -78.0
SOUTH = 43.0
NORTH = 45.0

# "west,south,east,north" — the order ArcGIS REST expects for an envelope geometry
ARCGIS_ENVELOPE = f"{WEST},{SOUTH},{EAST},{NORTH}"

# "south,west,north,east" — the order Overpass QL's [bbox:...] filter expects
OVERPASS_BBOX = f"{SOUTH},{WEST},{NORTH},{EAST}"
