"""Tile screenshots into contact sheets for fast visual review of many pages.
usage: python3 contact_sheet.py <out-prefix> <cols> <tile-width> <png> [<png> ...]
Each tile shows the top of a screenshot (height = 3.2 x width) labelled with its file name."""
import sys, os
from PIL import Image, ImageDraw
out, cols, tw, files = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
th = int(tw * 3.2)
per = cols * 2
for n, start in enumerate(range(0, len(files), per)):
    chunk = files[start:start + per]
    sheet = Image.new("RGB", (cols * tw, 2 * (th + 20)), "white")
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(chunk):
        im = Image.open(f).convert("RGB")
        im = im.resize((tw, int(im.height * tw / im.width))).crop((0, 0, tw, th))
        x, y = (i % cols) * tw, (i // cols) * (th + 20)
        sheet.paste(im, (x, y + 20))
        d.text((x + 3, y + 3), os.path.basename(f)[:40], fill="red")
    sheet.save(f"{out}-{n}.png")
    print(f"{out}-{n}.png")
