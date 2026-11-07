"""Find a button in a screenshot. Pure image code, so it is testable anywhere."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

TEMPLATE_DIR = Path(__file__).parent / "templates"


@dataclass
class Match:
    score: float
    center: tuple[int, int]      # in screenshot pixels
    scale: float


def _gray(img: np.ndarray) -> np.ndarray:
    import cv2
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def load_template(name: str) -> np.ndarray:
    import cv2
    img = cv2.imread(str(TEMPLATE_DIR / name), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(TEMPLATE_DIR / name)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def find_template(screen: np.ndarray, template: np.ndarray,
                  region: tuple[float, float, float, float] = (0, 0, 1, 1),
                  scales: tuple[float, float, int] = (0.5, 2.0, 31)) -> Match | None:
    """Best multi-scale match of `template` inside `region` (fractions) of `screen`.

    Multi-scale because Windows display scaling (100/125/150 %) changes button
    sizes compared with the screenshots the templates were cut from.
    """
    import cv2
    h, w = screen.shape[:2]
    x0, y0 = int(region[0] * w), int(region[1] * h)
    x1, y1 = int(region[2] * w), int(region[3] * h)
    roi = _gray(screen[y0:y1, x0:x1])
    tpl = _gray(template)
    best: Match | None = None
    for s in np.linspace(*scales):
        tw, th = int(tpl.shape[1] * s), int(tpl.shape[0] * s)
        if tw < 8 or th < 8 or tw > roi.shape[1] or th > roi.shape[0]:
            continue
        t = cv2.resize(tpl, (tw, th), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
        res = cv2.matchTemplate(roi, t, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if best is None or score > best.score:
            best = Match(float(score), (x0 + loc[0] + tw // 2, y0 + loc[1] + th // 2), float(s))
    return best


def frac_to_screen(rect: tuple[int, int, int, int], frac: tuple[float, float]) -> tuple[int, int]:
    """rect = (left, top, right, bottom) in screen pixels."""
    l, t, r, b = rect
    return int(l + frac[0] * (r - l)), int(t + frac[1] * (b - t))
