"""python -m carcal.dspgui serve | inspect | test-export PATH | test-import PATH | screenshot PATH"""

import argparse
import logging
import sys
from pathlib import Path


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m carcal.dspgui")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run the MCP server (stdio)")
    s = sub.add_parser("inspect", help="dump windows + control tree to a text file")
    s.add_argument("-o", "--output", default="dspgui_inspect.txt")
    s = sub.add_parser("test-export", help="click through Save once, no MCP")
    s.add_argument("path")
    s = sub.add_parser("test-import", help="click through Call once, no MCP")
    s.add_argument("path")
    s = sub.add_parser("screenshot", help="save a screenshot of the app window")
    s.add_argument("path")
    s = sub.add_parser("config", help="print the effective configuration")
    a = ap.parse_args(argv)

    if a.cmd == "serve":
        from .server import main as serve
        serve()
        return

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    from .config import dump, load
    cfg = load()
    if a.cmd == "config":
        print(dump(cfg))
        return
    from .app import RainbowApp
    app = RainbowApp(cfg)
    if a.cmd == "inspect":
        print(f"wrote {app.inspect(Path(a.output))}")
    elif a.cmd == "test-export":
        notes = app.export_preset(Path(a.path))
        print(f"exported {a.path}; click methods {app.last_click_method}; notes {notes}")
    elif a.cmd == "test-import":
        notes = app.import_preset(Path(a.path))
        print(f"imported {a.path}; click methods {app.last_click_method}; notes {notes}")
    elif a.cmd == "screenshot":
        app.screenshot().save(a.path)
        print(f"wrote {a.path}")


if __name__ == "__main__":
    main()
