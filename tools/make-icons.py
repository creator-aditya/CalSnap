"""Generate the CalSnap app icon (run once, output committed to the repo)."""
import math
import os

from PIL import Image, ImageDraw

ROOT = r"D:\CalSnap"


def star(draw, cx, cy, r, fill=(99, 102, 241, 255)):
    points = []
    for i in range(10):
        angle = math.radians(-90 + i * 36)
        radius = r if i % 2 == 0 else r * 0.45
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    draw.polygon(points, fill=fill)


size = 512
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Indigo -> purple background, rounded like the in-app logo.
for y in range(size):
    t = y / (size - 1)
    red = int(99 + (168 - 99) * t)
    green = int(102 + (85 - 102) * t)
    blue = int(241 + (247 - 241) * t)
    draw.line([(0, y), (size, y)], fill=(red, green, blue, 255))

mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=110, fill=255)
img.putalpha(mask)

# Calendar body with a header band, binding rings and a star that hints at "snap".
draw.rounded_rectangle([104, 122, 408, 404], radius=34, fill=(255, 255, 255, 255))
draw.rounded_rectangle([104, 122, 408, 196], radius=34, fill=(67, 70, 160, 255))
draw.rectangle([104, 168, 408, 196], fill=(67, 70, 160, 255))
draw.rounded_rectangle([168, 88, 200, 152], radius=16, fill=(52, 55, 130, 255))
draw.rounded_rectangle([312, 88, 344, 152], radius=16, fill=(52, 55, 130, 255))
star(draw, 330, 340, 62, fill=(129, 132, 245, 255))

img.save(os.path.join(ROOT, "icon.png"))
for dimension in (192, 512):
    img.resize((dimension, dimension), Image.LANCZOS).save(
        os.path.join(ROOT, "icon-%d.png" % dimension)
    )

print("icons written")
