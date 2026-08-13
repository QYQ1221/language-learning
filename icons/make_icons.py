"""生成 PWA 应用图标（无第三方依赖，手写 PNG 编码）"""
import zlib
import struct
import os

OUT = os.path.dirname(os.path.abspath(__file__))

SS = 4  # 超采样倍数，用于抗锯齿


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_cover(px, py, x, y, w, h, r):
    """点 (px,py) 是否落在圆角矩形内"""
    if px < x or px > x + w or py < y or py > y + h:
        return False
    # 四角圆弧判定
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy <= r * r


def make_icon(size, maskable=False):
    """返回 RGBA 像素数据"""
    if maskable:
        # maskable 图标：背景铺满，内容收缩到安全区
        bg_x, bg_y, bg_w, bg_h, bg_r = 0, 0, size, size, 0
        content_scale = 0.60
    else:
        bg_x, bg_y, bg_w, bg_h = 0, 0, size, size
        bg_r = size * 0.22
        content_scale = 0.78

    # 内容区（三条文本线）
    cw = size * content_scale
    ch = size * content_scale
    cx0 = (size - cw) / 2
    cy0 = (size - ch) / 2

    # 三条横线：相对内容区的比例 (y_center, width_ratio)
    bars = [
        (0.22, 1.00),
        (0.50, 0.72),
        (0.78, 0.86),
    ]
    bar_h = ch * 0.145
    bar_r = bar_h / 2

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r_acc = g_acc = b_acc = a_acc = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    fy = py + (sy + 0.5) / SS

                    # 背景
                    if rounded_rect_cover(fx, fy, bg_x, bg_y, bg_w, bg_h, bg_r):
                        t = (fx / size * 0.55 + fy / size * 0.45)
                        cr = lerp(0x3b, 0x7a, t)
                        cg = lerp(0x6e, 0x5a, t)
                        cb = lerp(0xf5, 0xf0, t)
                        ca = 255.0
                    else:
                        cr = cg = cb = ca = 0.0

                    # 文本线（白色）
                    if ca > 0:
                        for (ycr, wr) in bars:
                            by = cy0 + ch * ycr - bar_h / 2
                            bw = cw * wr
                            bx = cx0
                            if rounded_rect_cover(fx, fy, bx, by, bw, bar_h, bar_r):
                                cr, cg, cb = 255.0, 255.0, 255.0
                                break

                    r_acc += cr
                    g_acc += cg
                    b_acc += cb
                    a_acc += ca

            n = SS * SS
            row += bytes((
                int(r_acc / n + 0.5),
                int(g_acc / n + 0.5),
                int(b_acc / n + 0.5),
                int(a_acc / n + 0.5),
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        c += struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
        return c

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp)
    png += chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(png)
    print(f'  {os.path.basename(path)}  {size}x{size}  {len(png) / 1024:.1f} KB')


if __name__ == '__main__':
    print('生成应用图标：')
    for s in (192, 512):
        write_png(os.path.join(OUT, f'icon-{s}.png'), s, make_icon(s))
    write_png(os.path.join(OUT, 'icon-maskable-512.png'), 512, make_icon(512, maskable=True))
    print('完成')
