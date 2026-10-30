#!/usr/bin/env python3
"""取模 sidecar：文字 / 图片 → 点阵 → C 数组（+ 放大预览 PNG）。

stdin 一个 JSON，stdout 一个 JSON。字段见 DEFAULT_SPEC。
"""
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_SPEC = {
    "text": "",
    "image": None,
    "width": 16,
    "height": 16,
    "font": "C:\\Windows\\Fonts\\simsun.ttc",
    "fontIndex": 0,
    "threshold": 128,
    "invert": False,
    "scan": "row",
    "bitOrder": "msb",
    "preview": True,
    "previewPath": None,
    "scale": 8,
    "varName": "glyph",
    "inputIsDark": True,
}


def load_font(path, index, height):
    from PIL import ImageFont

    return ImageFont.truetype(path, size=height, index=index)


def is_cjk(ch):
    return any(ord(c) > 0x2E80 for c in ch)


def render_char(ch, spec, font):
    """汉字在 12/14/16 这类小字号下用「原尺寸点阵」最清楚；英文与大字用 4 倍渲染再缩小更平滑。"""
    from PIL import Image, ImageDraw, ImageFont

    w, h = int(spec["width"]), int(spec["height"])
    direct = is_cjk(ch) and h <= 24
    render_size = h if direct else max(h * 4, 32)
    try:
        use_font = ImageFont.truetype(spec["font"], size=render_size, index=int(spec.get("fontIndex") or 0))
    except Exception:
        use_font = font

    canvas_w, canvas_h = max(render_size * 3, 48), max(render_size * 3, 48)
    img = Image.new("L", (canvas_w, canvas_h), 0)
    draw = ImageDraw.Draw(img)
    cx, cy = canvas_w // 2, canvas_h // 2
    try:
        draw.text((cx, cy), ch, font=use_font, fill=255, anchor="mm")
    except Exception:
        draw.text((0, 0), ch, font=use_font, fill=255)
    box = img.getbbox()
    glyph = img.crop(box) if box else Image.new("L", (w, h), 0)
    # 等比缩放到目标尺寸内，再居中贴到 W×H 画布（本来就刚好时是 1:1 拷贝）
    ratio = min(w / max(glyph.width, 1), h / max(glyph.height, 1))
    target = (max(1, round(glyph.width * ratio)), max(1, round(glyph.height * ratio)))
    if target != glyph.size:
        glyph = glyph.resize(target, Image.LANCZOS)
    cell = Image.new("L", (w, h), 0)
    cell.paste(glyph, ((w - target[0]) // 2, (h - target[1]) // 2))
    return cell


def render_image(path, spec):
    from PIL import Image

    w, h = int(spec["width"]), int(spec["height"])
    img = Image.open(path)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    img = img.convert("L")
    img = img.resize((w, h), Image.LANCZOS)
    return img


def to_bits(cell, spec):
    """L 图 → 二维 0/1（1 = 需要点亮的点）。"""
    w, h = cell.size
    threshold = int(spec.get("threshold") or 128)
    invert = bool(spec.get("invert"))
    px = cell.load()
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            v = px[x, y]
            bit = 1 if v >= threshold else 0
            if invert:
                bit ^= 1
            row.append(bit)
        rows.append(row)
    return rows


def pack_row(rows, spec):
    w = len(rows[0])
    h = len(rows)
    msb = (spec.get("bitOrder") or "msb").lower() == "msb"
    per_row = (w + 7) // 8
    out = []
    for y in range(h):
        for b in range(per_row):
            byte = 0
            for i in range(8):
                x = b * 8 + i
                bit = rows[y][x] if x < w else 0
                if msb:
                    byte |= bit << (7 - i)
                else:
                    byte |= bit << i
            out.append(byte)
    return out


def pack_col(rows, spec):
    w = len(rows[0])
    h = len(rows)
    msb = (spec.get("bitOrder") or "msb").lower() == "msb"
    pages = (h + 7) // 8
    out = []
    for page in range(pages):
        for x in range(w):
            byte = 0
            for i in range(8):
                y = page * 8 + i
                bit = rows[y][x] if y < h else 0
                if msb:
                    byte |= bit << (7 - i)
                else:
                    byte |= bit << i
            out.append(byte)
    return out


def ascii_art(rows, on="#", off="."):
    return "\n".join("".join(on if b else off for b in row) for row in rows)


def main():
    raw_bytes = sys.stdin.buffer.read()
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raw = raw_bytes.decode("gbk", errors="replace")
    try:
        spec = dict(DEFAULT_SPEC)
        spec.update(json.loads(raw or "{}"))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "BAD_SPEC", "message": str(exc)}, ensure_ascii=False))
        return 1

    try:
        font = None if spec.get("image") else load_font(spec["font"], int(spec.get("fontIndex") or 0), int(spec["height"]))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "FONT_FAILED", "message": str(exc), "font": spec["font"]}, ensure_ascii=False))
        return 2

    targets = []
    if spec.get("text"):
        targets = [ch for ch in str(spec["text"]) if not ch.isspace()] or list(str(spec["text"]))
    if spec.get("image"):
        targets = ["(image)"]

    if not targets:
        print(json.dumps({"ok": False, "error": "NO_INPUT", "message": "既没有 text 也没有 image"}, ensure_ascii=False))
        return 2

    chars = []
    previews = []
    for ch in targets:
        if spec.get("image"):
            cell = render_image(spec["image"], spec)
        else:
            cell = render_char(ch, spec, font)
        rows = to_bits(cell, spec)
        data = pack_row(rows, spec) if (spec.get("scan") or "row") == "row" else pack_col(rows, spec)
        chars.append(
            {
                "char": ch,
                "bytes": data,
                "hex": ["0x%02X" % b for b in data],
                "bits": ascii_art(rows),
            }
        )
        previews.append((ch, cell, rows))

    if spec.get("preview", True) and spec.get("previewPath"):
        from PIL import Image

        scale = max(1, int(spec.get("scale") or 8))
        w, h = int(spec["width"]), int(spec["height"])
        gap = 4
        total_w = len(previews) * (w * scale + gap) + gap
        total_h = h * scale + gap * 2
        canvas = Image.new("L", (total_w, total_h), 230)
        for idx, (_, _cell, rows) in enumerate(previews):
            ox = gap + idx * (w * scale + gap)
            for y, row in enumerate(rows):
                for x, bit in enumerate(row):
                    if bit:
                        for dy in range(scale):
                            for dx in range(scale):
                                canvas.putpixel((ox + x * scale + dx, gap + y * scale + dy), 0)
        canvas.save(spec["previewPath"])

    var = spec.get("varName") or "glyph"
    lines = []
    lines.append("/* %d×%d %s取模，%s，%s */" % (
        int(spec["width"]),
        int(spec["height"]),
        "列" if (spec.get("scan") or "row") == "col" else "行",
        (spec.get("bitOrder") or "msb").upper() + "-first",
        "阴码" if spec.get("invert") else "阳码",
    ))
    if len(chars) == 1:
        c = chars[0]
        lines.append("unsigned char code %s[] = {" % var)
        for i in range(0, len(c["hex"]), 8):
            lines.append("    " + ", ".join(c["hex"][i : i + 8]) + ",")
        lines.append("};")
    else:
        lines.append("/* 每个字 %d 字节，顺序：%s */" % (len(chars[0]["bytes"]), "".join(c["char"] for c in chars)))
        lines.append("unsigned char code %s[] = {" % var)
        for c in chars:
            lines.append("    /* '%s' */" % c["char"])
            for i in range(0, len(c["hex"]), 8):
                lines.append("    " + ", ".join(c["hex"][i : i + 8]) + ",")
        lines.append("};")

    print(
        json.dumps(
            {
                "ok": True,
                "width": int(spec["width"]),
                "height": int(spec["height"]),
                "scan": spec.get("scan") or "row",
                "bitOrder": spec.get("bitOrder") or "msb",
                "invert": bool(spec.get("invert")),
                "bytesPerChar": len(chars[0]["bytes"]),
                "chars": chars,
                "cArray": "\n".join(lines),
                "previewPath": spec.get("previewPath") if previews else None,
                "font": spec["font"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
