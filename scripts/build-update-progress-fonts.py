#!/usr/bin/env python3
"""Build the TTF fonts for the Windows update progress window (261030).

The helper (resources/update-progress/update-progress.ps1) is a WPF window,
and WPF reads TTF/OTF only: no WOFF2, and no variable-font instances (it draws
a variable font's default instance whatever FontWeight asks for). So the app's
own Oswald and Rajdhani WOFF2 files (src/renderer/public/fonts) are converted
here into static TTFs, each under its own family name with one weight, which
the script asks for by name with FontWeight Normal. No weight matching or bold
synthesis can pick a different face that way.

Both fonts are SIL OFL 1.1 without Reserved Font Names, so renamed and
instanced copies are allowed; the license texts sit next to the files.

Run from the repo root after changing a source font:
  pip install fonttools brotli
  python3 scripts/build-update-progress-fonts.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src/renderer/public/fonts'
OUT = ROOT / 'resources/update-progress/fonts'

# (source woff2, wght for a variable source or None, family name, weight class, file)
FACES = [
    ('oswald-600.woff2', 600, 'Sei Oswald SemiBold', 600, 'sei-oswald-600.ttf'),
    ('rajdhani-500.woff2', None, 'Sei Rajdhani Medium', 500, 'sei-rajdhani-500.ttf'),
    ('rajdhani-600.woff2', None, 'Sei Rajdhani SemiBold', 600, 'sei-rajdhani-600.ttf'),
]


def rename(font: TTFont, family: str, weight: int) -> None:
    name = font['name']
    # Drop typographic/WWS names so every reader sees the one family below.
    for nid in (16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    ps = family.replace(' ', '')
    for nid, value in ((1, family), (2, 'Regular'), (3, f'{ps};sei-update-progress'), (4, family), (6, ps)):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    os2 = font['OS/2']
    os2.usWeightClass = weight
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | 0b1000000  # REGULAR only
    font['head'].macStyle = 0


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for src, wght, family, weight, out in FACES:
        font = TTFont(SRC / src)
        if wght is not None and 'fvar' in font:
            font = instantiateVariableFont(font, {'wght': wght}, updateFontNames=False)
        for table in ('STAT', 'HVAR', 'MVAR', 'avar'):
            if table in font:
                del font[table]
        font.flavor = None
        rename(font, family, weight)
        font.save(OUT / out)
        print(f'{out}: {family} ({weight}), {(OUT / out).stat().st_size} bytes')


if __name__ == '__main__':
    main()
