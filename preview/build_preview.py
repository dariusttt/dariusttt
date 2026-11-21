#!/usr/bin/env python3
"""Build the website preview: one self-contained HTML page of the app that runs
in the browser with no server (preview/mock-api.js stands in for the backend).

    python3 preview/build_preview.py [output.html]     # default: preview/petrokenya-preview.html

The page is meant for showing the app (e.g. as a claude.ai artifact). It keeps
everything in the viewer's own browser and starts with marked example data.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")

# Things a sandboxed preview page can't do: print, download files, install the app
PREVIEW_CSS = """
/* ════ WEBSITE PREVIEW ONLY ════ */
:root{color-scheme:dark}
body.preview [onclick*="print"],body.preview [onclick*="exportCSV"],
body.preview [onclick*="downloadReportCSV"],body.preview #installBtn,body.preview #bkList a{display:none!important}
.preview-bar{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;margin-bottom:16px;padding:12px 16px;
  border:1px dashed rgba(91,184,224,.4);border-radius:10px;background:rgba(91,184,224,.06);
  font-family:var(--mono);font-size:.74rem;color:var(--blue);line-height:1.6}
.preview-bar span{flex:1;min-width:200px}
.demo-accounts{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--brd)}
.demo-accounts .btn{width:100%}
.demo-title{font-family:var(--mono);font-size:.7rem;color:var(--acc2);letter-spacing:1px;text-transform:uppercase}
.demo-note{font-family:var(--mono);font-size:.66rem;color:var(--mut);line-height:1.5}
"""


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def build():
    html = read(FRONTEND, "index.html")
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    scripts = {
        "js/i18n.js": read(FRONTEND, "js", "i18n.js"),
        "js/app.js": read(ROOT, "preview", "mock-api.js") + "\n" + read(FRONTEND, "js", "app.js"),
    }

    def inline(match):
        src = match.group(1).split("?")[0]
        return "<script>\n%s\n</script>" % scripts[src]
    body, n = re.subn(r'<script src="([^"]+)"></script>', inline, body)
    assert n == 2, "expected the i18n and app scripts in index.html"

    head = "\n".join([
        "<title>PetroKenya Station Dashboard</title>",
        '<meta name="description" content="Website preview of the PetroKenya station app with example data.">',
        '<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:'
        'wght@400;500;600&display=swap" rel="stylesheet">',
        "<style>\n%s\n%s</style>" % (read(FRONTEND, "css", "styles.css"), PREVIEW_CSS),
    ])
    return head + "\n" + body


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "preview", "petrokenya-preview.html")
    page = build()
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print("Wrote %s (%d KB)" % (out, len(page.encode("utf-8")) // 1024))
