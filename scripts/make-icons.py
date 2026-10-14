"""Draws the Capture and Annotate icon (blue tile, white selection corners) at every size the manifest uses.

Run: python3 scripts/make-icons.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
BIG = 512  # draw large, then downscale for smooth edges


def draw() -> Image.Image:
    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((16, 16, BIG - 16, BIG - 16), radius=112, fill=BLUE)

    # Four selection corners.
    w, inset, arm = 40, 120, 92
    lo, hi = inset, BIG - inset
    for x, y, dx, dy in ((lo, lo, 1, 1), (hi, lo, -1, 1), (lo, hi, 1, -1), (hi, hi, -1, -1)):
        d.line((x, y, x + dx * arm, y), fill=WHITE, width=w)
        d.line((x, y, x, y + dy * arm), fill=WHITE, width=w)
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=WHITE)
        for ex, ey in ((x + dx * arm, y), (x, y + dy * arm)):
            d.ellipse((ex - w / 2, ey - w / 2, ex + w / 2, ey + w / 2), fill=WHITE)

    # Shutter dot in the middle.
    r = 46
    c = BIG / 2
    d.ellipse((c - r, c - r, c + r, c + r), fill=WHITE)
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
