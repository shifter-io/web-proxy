"""Build the README banner with the site's Geist font and Shifter logo.

Optional asset-generation dependencies: pip install fonttools brotli
The generated SVG uses outlined text and needs no external fonts or assets.
"""
from pathlib import Path
import re
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / 'web/control/assets/geist-latin.woff2'
fonts = {}

def text(value, x, y, size, color, weight=400):
    if weight not in fonts:
        font = TTFont(FONT)
        if 'fvar' in font:
            font = instantiateVariableFont(font, {'wght': weight})
        fonts[weight] = font
    font = fonts[weight]
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font['head'].unitsPerEm
    pen = SVGPathPen(glyphs)
    cursor = x
    for character in value:
        name = cmap[ord(character)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, y)))
        cursor += font['hmtx'][name][0] * scale
    return f'<path fill="{color}" d="{pen.getCommands()}"/>'

logo = (ROOT / 'web/control/assets/shifter-logo.svg').read_text()
logo = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', logo, flags=re.S)
parts = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="380" viewBox="0 0 1200 380" role="img" aria-labelledby="title desc">
<title id="title">Free Web Proxy by Shifter</title>
<desc id="desc">Your browser. A different perspective. Free online proxy with country selection, residential exits, and no downloads.</desc>
<defs><radialGradient id="glow" cx="95%" cy="30%" r="85%"><stop stop-color="#122d53"/><stop offset="1" stop-color="#0b0e17"/></radialGradient><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#698ab3" stroke-opacity=".08"/></pattern></defs>
<rect width="1200" height="380" rx="20" fill="url(#glow)"/>
<rect width="1200" height="380" rx="20" fill="url(#grid)"/>
<rect x=".5" y=".5" width="1199" height="379" rx="20" fill="none" stroke="#25354b"/>''']
parts += [text('Web Proxy',56,94,38,'#fafafa',650), '<path d="M277 57v41" stroke="#354157"/>', text('by',298,89,23,'#9ba8ba'), f'<g transform="translate(344 49) scale(.38)">{logo}</g>', text('Powered by Shifter',946,85,20,'#9ba8ba')]
parts += [text('Your browser.',56,184,52,'#fafafa',650), text('A different perspective.',56,249,52,'#579dff',650), text('Choose a country. Enter a website. Explore.',56,297,23,'#b0bdce')]
for value, x, color in [('FREE WEB PROXY',58,'#76b1ff'),('NO DOWNLOADS',244,'#b0bdce'),('RESIDENTIAL IPS',433,'#b0bdce'),('COUNTRY SELECTION',632,'#b0bdce')]:
    parts.append(text(value,x,347,14,color,500))
parts += ['''<rect x="830" y="145" width="314" height="176" rx="16" fill="#0c1524" stroke="#2a405e"/>
<circle cx="853" cy="169" r="4" fill="#58bea2"/>
<path d="M846 190H1128" stroke="#293d55"/>
<rect x="850" y="239" width="274" height="42" rx="8" fill="#142943" stroke="#2a405e"/>
<path d="m1092 254 5 6-5 6m-9-6h14" fill="none" stroke="#76b1ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>''',text('Browse from another country',868,175,16,'#dce7f7'),text('EXIT LOCATION',850,222,11,'#91a7c5',500),text('United States',866,265,17,'#f4f7fb',500),text('No extension. No browser setup.',850,304,12,'#91a7c5')]
parts.append('</svg>')
path = ROOT / 'docs/assets/readme-header.svg'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text('\n'.join(parts) + '\n')
print(f'Generated {path.relative_to(ROOT)}')
