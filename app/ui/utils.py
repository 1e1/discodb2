def format_data(data: bytes) -> str:
    return " ".join(f"{byte:02X}" for byte in data)


def format_ascii(data: bytes) -> str:
    chars = []
    for byte in data:
        if 32 <= byte <= 126:
            chars.append(chr(byte))
        else:
            chars.append(".")
    return "".join(chars)


def heat_color(ratio: float) -> str:
    ratio = max(0.0, min(ratio, 1.0))
    r = 255
    g = int(245 - ratio * 120)
    b = int(245 - ratio * 200)
    g = max(0, min(g, 255))
    b = max(0, min(b, 255))
    return f"#{r:02x}{g:02x}{b:02x}"

