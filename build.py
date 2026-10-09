"""Bundle Skunk into one page for publishing as a claude.ai Artifact.

The Artifact publisher wraps the page in its own <html>/<head>/<body>, so this
keeps the <title>, inlines styles.css and app.js, and drops the outer document
tags. Output: dist/skunk.html

Run: python3 build.py
"""

import re
from pathlib import Path

here = Path(__file__).parent
html = (here / "index.html").read_text()
css = (here / "styles.css").read_text()
js = (here / "app.js").read_text()

title = re.search(r"<title>.*?</title>", html, re.S).group(0)
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
body = body.replace('<script src="app.js"></script>', f"<script>\n{js}</script>")

out = here / "dist" / "skunk.html"
out.parent.mkdir(exist_ok=True)
out.write_text(f"{title}\n<style>\n{css}</style>\n{body.strip()}\n")
print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")
