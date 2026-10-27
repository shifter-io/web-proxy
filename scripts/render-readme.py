"""Render the README and engineering guide's Markdown subset to self-contained offline HTML (stdlib only).

Supports headings, paragraphs, simple lists/tables, inline links/code/emphasis,
and fenced code. GitHub remains the full Markdown renderer for README.md.

Before writing, every local link in README.md and ENGINEERING.md is validated:
heading ids must be unique, `#fragment` links must name a heading of the same
document, relative paths must stay inside the repository and name a tracked
file or directory, and fragments are allowed only on README.md, ENGINEERING.md
and their docs/*.html renderings. Links with a scheme (https:, mailto:) are not
checked; header images must be existing SVG files inside the repository.
Without arguments the script writes both pages (exit 0) or prints `file:line`
errors and writes nothing (exit 1); `--check` writes nothing and exits 1 when
a page under docs/ is missing or out of date; any other argument exits 2.
"""
from pathlib import Path
from typing import NamedTuple
import base64
import html
import posixpath
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]

DOCUMENTS = (
    ('README.md', 'readme.html', 'Free Web Proxy by Shifter — Online Proxy & Proxy Site'),
    ('ENGINEERING.md', 'engineering.html', 'Shifter Web Proxy — Engineering Guide'),
)
FRAGMENT_DOCUMENTS = {
    'README.md': 'README.md',
    'ENGINEERING.md': 'ENGINEERING.md',
    'docs/readme.html': 'README.md',
    'docs/engineering.html': 'ENGINEERING.md',
}
SCHEME = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')
USAGE = 'usage: python3 scripts/render-readme.py [--check]'


class HeaderImageError(ValueError):
    """A header `src` that is not an existing SVG file inside the repository; the message starts with its line."""

    def __init__(self, line, value):
        super().__init__(f'{line}: header image "{value}" must be an existing local SVG file')


class Rendered(NamedTuple):
    blocks: list[str]
    ids: list[tuple[int, str]]
    links: list[tuple[int, str]]


def heading_id(text):
    return re.sub(r'[^\w -]', '', text.lower()).replace(' ', '-')


def link_target(value):
    return value if re.match(r'^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)', value) else '../' + value


def header_html(source, line, links):
    """Preserve the repository-authored HTML masthead and embed its local SVG."""
    def asset(match):
        value = html.unescape(match[1])
        links.append((line, value))
        path = (root / value).resolve()
        if not path.is_relative_to(root) or path.suffix != '.svg' or not path.is_file():
            raise HeaderImageError(line, value)
        encoded = base64.b64encode(path.read_bytes()).decode('ascii')
        return 'src="data:image/svg+xml;base64,' + encoded + '"'

    def href(match):
        value = html.unescape(match[1])
        links.append((line, value))
        return 'href="' + html.escape(link_target(value), quote=True) + '"'

    source = re.sub(r'src="([^"]+)"', asset, source)
    return re.sub(r'href="([^"]+)"', href, source)


def inline(source, line, links):
    saved = []

    def keep(value):
        saved.append(value)
        return f'\x00{len(saved)-1}\x00'

    def link(match):
        links.append((line, match[2]))
        return keep('<a href="' + html.escape(link_target(match[2]), quote=True)
                    + '">' + re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', html.escape(match[1])) + '</a>')

    text = re.sub(r'`([^`]+)`', lambda m: keep('<code>' + html.escape(m[1]) + '</code>'), source)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, text)
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    for i, value in enumerate(saved):
        text = text.replace(f'\x00{i}\x00', value)
    return text


def block_end(lines, i):
    while i < len(lines) and lines[i].strip():
        i += 1
    return i


def render_table(lines, i, rendered):
    rows = []
    while i < len(lines) and lines[i].startswith('|'):
        cells = [s.strip() for s in lines[i].strip('|').split('|')]
        if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
            tag = 'th' if not rows else 'td'
            rows.append('<tr>' + ''.join(
                f'<{tag}>{inline(cell, i + 1, rendered.links)}</{tag}>' for cell in cells) + '</tr>')
        i += 1
    rendered.blocks.append('<div class="table"><table>' + ''.join(rows) + '</table></div>')
    return i


def render_list(lines, i, rendered):
    tag = 'ul' if lines[i].startswith('- ') else 'ol'
    marker = r'^' + (r'- ' if tag == 'ul' else r'\d+\. ') + r'(.+)$'
    items = []
    while i < len(lines):
        item = re.match(marker, lines[i])
        if not item:
            break
        items.append('<li>' + inline(item[1], i + 1, rendered.links) + '</li>')
        i += 1
    rendered.blocks.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
    return i


def render_block(lines, i, rendered):
    """Render the block starting at non-blank line `i`; return the index after it."""
    line, number, links = lines[i], i + 1, rendered.links
    if line.startswith(('<p align="center">', '<h1 align="center">')):
        end = block_end(lines, i)
        rendered.blocks.append(header_html('\n'.join(lines[i:end]), number, links))
        return end
    if line.startswith('```'):
        end = i + 1
        while end < len(lines) and not lines[end].startswith('```'):
            end += 1
        rendered.blocks.append('<pre><code>' + html.escape('\n'.join(lines[i + 1:end])) + '</code></pre>')
        return end + 1
    heading = re.match(r'^(#{1,6}) (.+)$', line)
    if heading:
        level, anchor = len(heading[1]), heading_id(heading[2])
        rendered.ids.append((number, anchor))
        rendered.blocks.append(f'<h{level} id="{anchor}">{inline(heading[2], number, links)}</h{level}>')
        return i + 1
    if line.startswith('|'):
        return render_table(lines, i, rendered)
    if re.match(r'^(?:- |\d+\. )(.+)$', line):
        return render_list(lines, i, rendered)
    end = block_end(lines, i)
    rendered.blocks.append('<p>' + inline(' '.join(lines[i:end]), number, links) + '</p>')
    return end


def render_document(lines):
    """Render Markdown lines; collect heading ids and link targets with 1-based line numbers."""
    rendered = Rendered([], [], [])
    i = 0
    while i < len(lines):
        i = render_block(lines, i, rendered) if lines[i].strip() else i + 1
    return rendered


STYLE = """*{box-sizing:border-box}html{scroll-behavior:smooth;color-scheme:light}body{margin:0;background:#ffffff;color:#1f2328;font:16px/1.65 system-ui,-apple-system,sans-serif}header,main,footer{max-width:1040px;margin:auto;padding:26px 40px}header{color:#59636e;font-size:12px;letter-spacing:1.5px;font-weight:600;border-bottom:1px solid #d1d9e0}main{padding-top:20px}h1,h2,h3{color:#1f2328;line-height:1.3}h1{font-size:34px;letter-spacing:-.9px;margin:28px 0 16px}h2{margin-top:42px;padding-bottom:10px;border-bottom:1px solid #d1d9e0;font-size:24px}h3{margin-top:28px;font-size:19px}p{margin:16px 0}p[align=center]{text-align:center}p[align=center] img{display:block;width:100%;max-width:960px;height:auto;margin:0 auto}h1[align=center]{text-align:center}a{color:#0969da;text-underline-offset:3px;text-decoration:none}a:hover{text-decoration:underline}code{font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;background:#eff1f3;border-radius:4px;padding:2px 5px}pre{padding:20px;overflow:auto;background:#f6f8fa;border:1px solid #d1d9e0;border-radius:8px}pre code{white-space:pre;overflow-wrap:normal;padding:0;background:none}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px 14px;border:1px solid #d1d9e0;text-align:left;vertical-align:top}th{background:#f6f8fa;color:#1f2328}tr:nth-child(even){background:#f6f8fa}li{margin:6px 0}footer{border-top:1px solid #d1d9e0;color:#59636e;font-size:13px}h2,h3{scroll-margin-top:18px}@media(max-width:650px){header,main,footer{padding:18px}h1{font-size:27px}table{min-width:540px}}@media print{html{color-scheme:light}body{background:white;color:#172235}header,main,footer{max-width:none;padding:12px}h1,h2,h3,th{color:#172235}h2,h3{break-after:avoid}pre,th,tr:nth-child(even){background:#f1f4f8}a{color:#1756a5}}"""


def page(title, blocks):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>' + html.escape(title) + '</title><style>'
            + STYLE + '</style></head><body><main>' + '\n'.join(blocks) + '</main></body></html>')


def tracked_paths():
    """Return the set of `git ls-files` paths relative to root, or None outside a git work tree."""
    try:
        result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=False)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return set(result.stdout.decode('utf-8', 'surrogateescape').split('\0')) - {''}


def is_tracked(path, tracked):
    """True when `path` (normalized, inside root) is a tracked file or a directory of tracked files."""
    if tracked is None:
        return (root / path).exists()
    prefix = '' if path == '.' else path + '/'
    return path in tracked or any(name.startswith(prefix) for name in tracked)


def link_problem(name, target, ids_by_doc, tracked):
    """Describe why `target` in document `name` is broken, or return None."""
    if SCHEME.match(target):
        return None
    path, has_fragment, fragment = target.partition('#')
    if not path:
        return None if fragment in ids_by_doc[name] else f'no heading for "#{fragment}" in {name}'
    normal = posixpath.normpath(path)
    if normal == '..' or normal.startswith(('../', '/')):
        return f'"{path}" leaves the repository'
    if not is_tracked(normal, tracked):
        return f'"{path}" is not a tracked file'
    if not has_fragment:
        return None
    document = FRAGMENT_DOCUMENTS.get(normal)
    if document is None:
        return 'fragment links are checked only for README.md, ENGINEERING.md and docs/*.html'
    return None if fragment in ids_by_doc[document] else f'no heading for "{path}#{fragment}"'


def check_links(name, rendered, ids_by_doc, tracked):
    """Return `name:line: message` errors for duplicate heading ids and broken local links."""
    errors = []
    first = {}
    for line, anchor in rendered.ids:
        if anchor in first:
            errors.append(f'{name}:{line}: duplicate heading id "{anchor}" (first at line {first[anchor]})')
        else:
            first[anchor] = line
    for line, target in rendered.links:
        problem = link_problem(name, target, ids_by_doc, tracked)
        if problem:
            errors.append(f'{name}:{line}: {problem}')
    return errors


def write_pages(pages):
    (root / 'docs').mkdir(exist_ok=True)
    for target, content in pages.items():
        (root / 'docs' / target).write_text(content, encoding='utf-8')
        print(f'Generated docs/{target}')
    return 0


def check_pages(pages):
    stale = [target for target, content in pages.items()
             if not (root / 'docs' / target).is_file()
             or (root / 'docs' / target).read_bytes() != content.encode('utf-8')]
    for target in stale:
        print(f'docs/{target} is out of date; run python3 scripts/render-readme.py', file=sys.stderr)
    if stale:
        return 1
    print('docs/readme.html and docs/engineering.html are current')
    return 0


def main(argv):
    if argv not in ([], ['--check']):
        print(USAGE, file=sys.stderr)
        return 2
    rendered = {}
    for source, _, _ in DOCUMENTS:
        try:
            rendered[source] = render_document((root / source).read_text(encoding='utf-8').splitlines())
        except HeaderImageError as error:
            print(f'{source}:{error}', file=sys.stderr)
            return 1
    ids_by_doc = {source: {anchor for _, anchor in doc.ids} for source, doc in rendered.items()}
    tracked = tracked_paths()
    errors = [error for source, doc in rendered.items()
              for error in check_links(source, doc, ids_by_doc, tracked)]
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    pages = {target: page(title, rendered[source].blocks) for source, target, title in DOCUMENTS}
    return check_pages(pages) if argv else write_pages(pages)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
