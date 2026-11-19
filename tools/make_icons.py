#!/usr/bin/env python3
"""Render the app's icons into web/. Stdlib only.

App icons: a green ring with gaps on night blue, amber centre.
Status icons (the notification's picture): the ring full when there is power, an empty outline
when there is none, dashed during switching.
Badges (the status-bar glyph, where Android keeps only the alpha channel): a disc, a hollow ring,
a half-filled ring.
"""
import math
import struct
import zlib
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
BG, POWER, NOW, MUTED = (14, 26, 43), (76, 203, 127), (242, 169, 59), (143, 160, 181)
ARCS = [(0, 45), (82.5, 135), (202.5, 225), (277.5, 315), (352.5, 360)]
SS = 3


def polar(x, y):
    return math.hypot(x, y), math.degrees(math.atan2(x, -y)) % 360


def dial(ring):
    """The amber centre on night blue, with the ring band coloured by ring(r, deg), None for no ink."""
    def colour(x, y):
        r, deg = polar(x, y)
        if r <= 0.085:
            return (*NOW, 255)
        return (*(0.25 <= r <= 0.36 and ring(r, deg) or BG), 255)
    return colour


app = dial(lambda r, deg: POWER if any(a <= deg <= b for a, b in ARCS) else None)


def status(state):
    def ring(r, deg):
        if state == "on" or (state == "maybe" and int(deg // 15) % 2 == 0):
            return POWER
        if state == "off" and not 0.27 < r < 0.34:
            return MUTED
    return dial(ring)


def badge(state):
    def colour(x, y):
        r, _ = polar(x, y)
        inked = r <= 0.4 and (state == "on" or r >= 0.3 or (state == "maybe" and x <= 0))
        return (255, 255, 255, 255 if inked else 0)
    return colour


def render(colour, size):
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = colour((px + (sx + .5) / SS) / size - .5, (py + (sy + .5) / SS) / size - .5)
                    for i in range(4):
                        acc[i] += c[i]
            rows.extend(v // (SS * SS) for v in acc)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


ICONS = [("icon-192.png", app, 192), ("icon-512.png", app, 512), ("apple-touch-icon.png", app, 180)]
for state in ("on", "off", "maybe"):
    ICONS += [(f"status-{state}.png", status(state), 192), (f"badge-{state}.png", badge(state), 96)]

for name, colour, size in ICONS:
    (WEB / name).write_bytes(render(colour, size))
    print(name, size)
