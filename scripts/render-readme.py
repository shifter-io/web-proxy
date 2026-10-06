"""Render the README's Markdown subset to self-contained offline HTML (stdlib only).

Supports headings, paragraphs, simple lists/tables, inline links/code/emphasis,
and fenced code. GitHub remains the full Markdown renderer for README.md.
"""
from pathlib import Path
import html
import re

root = Path(__file__).resolve().parents[1]
lines = (root / 'README.md').read_text().splitlines()


def inline(source):
    saved = []

    def keep(value):
        saved.append(value)
        return f'\x00{len(saved)-1}\x00'

    text = re.sub(r'`([^`]+)`', lambda m: keep('<code>' + html.escape(m[1]) + '</code>'), source)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: keep(
        '<a href="' + html.escape(m[2] if m[2].startswith(('http://', 'https://', '#')) else '../' + m[2], quote=True)
        + '">' + html.escape(m[1]) + '</a>'), text)
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    for i, value in enumerate(saved):
        text = text.replace(f'\x00{i}\x00', value)
    return text


out = []
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith('```'):
        block = []
        i += 1
        while i < len(lines) and not lines[i].startswith('```'):
            block.append(lines[i])
            i += 1
        out.append('<pre><code>' + html.escape('\n'.join(block)) + '</code></pre>')
        i += 1
        continue
    heading = re.match(r'^(#{1,6}) (.+)$', line)
    if heading:
        level = len(heading[1])
        anchor = re.sub(r'[^\w -]', '', heading[2].lower()).replace(' ', '-')
        out.append(f'<h{level} id="{anchor}">{inline(heading[2])}</h{level}>')
        i += 1
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            cells = [s.strip() for s in lines[i].strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                tag = 'th' if not rows else 'td'
                rows.append('<tr>' + ''.join(f'<{tag}>{inline(cell)}</{tag}>' for cell in cells) + '</tr>')
            i += 1
        out.append('<div class="table"><table>' + ''.join(rows) + '</table></div>')
        continue
    item = re.match(r'^(?:- |\d+\. )(.+)$', line)
    if item:
        tag = 'ul' if line.startswith('- ') else 'ol'
        items = []
        while i < len(lines):
            item = re.match(r'^' + (r'- ' if tag == 'ul' else r'\d+\. ') + r'(.+)$', lines[i])
            if not item:
                break
            items.append('<li>' + inline(item[1]) + '</li>')
            i += 1
        out.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
        continue
    paragraph = []
    while i < len(lines) and lines[i].strip():
        paragraph.append(lines[i])
        i += 1
    out.append('<p>' + inline(' '.join(paragraph)) + '</p>')

style = '''*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f7f3;color:#19271f;font:16px/1.65 system-ui,-apple-system,sans-serif}header,main,footer{max-width:1100px;margin:auto;padding:30px 40px}header{border-bottom:1px solid #ced9ce;font-size:13px;letter-spacing:1.5px;font-weight:650}main{padding-top:14px}h1{font-size:38px;letter-spacing:-1.3px;line-height:1.2}h2{margin-top:52px;padding-top:18px;border-top:1px solid #d4dfd2;font-size:25px}h3{margin-top:28px;font-size:19px}p,li{max-width:960px}a{color:#156042;text-underline-offset:3px}code{font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}pre{padding:20px;overflow:auto;background:#e8eee5;border-radius:7px}pre code{white-space:pre;overflow-wrap:normal}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:11px 12px;border-bottom:1px solid #d4dfd2;text-align:left;vertical-align:top}th{background:#e7eee4}li{margin:7px 0}footer{border-top:1px solid #ced9ce;color:#5b6d60;font-size:13px}h2,h3{scroll-margin-top:18px}@media(max-width:650px){header,main,footer{padding:22px}h1{font-size:30px}table{min-width:600px}}@media print{body{background:white}header,main,footer{max-width:none;padding:12px}h2,h3{break-after:avoid}pre{white-space:pre-wrap}}'''
page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shifter Web Proxy — README</title><style>' + style + '</style></head><body><header>SHIFTER / WEB PROXY · ENGINEERING GUIDE</header><main>' + '\n'.join(out) + '</main><footer>Generated from README.md. Standalone HTML; no external assets, scripts, CDN, or development server required.</footer></body></html>'
(root / 'docs').mkdir(exist_ok=True)
(root / 'docs' / 'readme.html').write_text(page)
print('Generated docs/readme.html')
