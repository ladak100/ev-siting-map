"""Shared Ontario-wide bounding box. Every fetch script filters/clips to this
box so all layers line up on the same map extent.

Based on OEB's own real Ontario-wide LDC Territories extent (xmin -95.15,
ymin 41.68, xmax -74.34, ymax 56.86), with a little padding added — same
"slightly generous on edges" reasoning as the box this replaced (avoids
provincial boundary polygons getting clipped weirdly at the edge)."""

WEST = -95.5
EAST = -74.0
SOUTH = 41.4
NORTH = 57.0

# "west,south,east,north" — the order ArcGIS REST expects for an envelope geometry
ARCGIS_ENVELOPE = f"{WEST},{SOUTH},{EAST},{NORTH}"

# "south,west,north,east" — the order Overpass QL's [bbox:...] filter expects
OVERPASS_BBOX = f"{SOUTH},{WEST},{NORTH},{EAST}"
