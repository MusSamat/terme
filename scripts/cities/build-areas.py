#!/usr/bin/env python3
"""Build city_areas: жилмассивы / микрорайоны of Бишкек and Ош from OSM
(sources/osm-places.json, places inside the city boundary). Output:
prisma/seed-data/city-areas.json — used to label meeting-point pins
(«Бишкек · Асанбай») and to search a pin inside the city.

  python3 scripts/cities/build-areas.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(__file__).resolve().parent / 'sources' / 'osm-places.json'
OUT = ROOT / 'prisma' / 'seed-data' / 'city-areas.json'

CITY_BOUNDARY = {'Бишкек': 8493930, 'Ош': 19059632}
KINDS = ('suburb', 'quarter', 'neighbourhood', 'village', 'hamlet', 'locality')
SKIP = {'заправка', 'пмк'}

SUFFIX = re.compile(
    r'\s*(ж/м|ж\.м\.|жил\.?\s*массив|жилмассив|жилой массив|турак жай массиви|микрорайон|мкр\.?|'
    r'кичирайону|кичи району|кичи район|жилгородок|жилой городок)\s*', re.I)
PREFIX = re.compile(r'^(жил\s*массив|жилмассив|жилгородок|микрорайон)\s+', re.I)


def clean(name):
    n = re.sub(r'\s+', ' ', name).strip()
    m = re.match(r'^(\d+)\s*-?\s*\S*\s*кичи\s*район[уы]?$', n, re.I)
    if m:
        return f'{m.group(1)} мкр', f'{m.group(1)}-кичи район'
    n = PREFIX.sub('', n)
    n = SUFFIX.sub(' ', n).strip(' -')
    n = re.sub(r'\s+', ' ', n)
    return n, n


def key(s):
    s = s.lower().replace('дж', 'ж').translate(str.maketrans('ёөүң', 'еоун'))
    return re.sub(r'[^a-zа-я0-9]+', '', s)


def main():
    d = json.loads(SRC.read_text(encoding='utf-8'))
    rank = {k: i for i, k in enumerate(KINDS)}
    out = []
    for city, rid in CITY_BOUNDARY.items():
        seen = {}
        pts = [p for p in d['places'] if p['oblast'] == rid and p['place'] in KINDS and p.get('name')]
        pts.sort(key=lambda p: (rank[p['place']], 0 if str(p['id']).startswith('n') else 1))
        for p in pts:
            ru_src = p.get('name_ru') or p['name']
            ky_src = p.get('name_ky') or p['name']
            ru, _ = clean(ru_src)
            _, kg = clean(ky_src)
            if re.fullmatch(r'\d+-й', ru):
                ru += ' мкр'
            if not re.search('[өүңӨҮҢ]|кичи', ky_src) and not p.get('name_ky'):
                kg = ru  # no Kyrgyz spelling in OSM
            # Directory rule: Дж → Ж in both languages (Жал, Жалал-Абад).
            ru = ru.replace('Дж', 'Ж').replace('дж', 'ж')
            kg = kg.replace('Дж', 'Ж').replace('дж', 'ж')
            if not ru or key(ru) in SKIP or ru.lower() == city.lower():
                continue
            k = key(ru)
            if k in seen:
                continue
            seen[k] = True
            out.append({'city': city, 'name_ru': ru, 'name_kg': kg, 'lat': p['lat'], 'lng': p['lng'],
                        'osm_id': str(p['id'])})
    out.sort(key=lambda a: (a['city'], a['name_ru']))
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0) + '\n', encoding='utf-8')
    print(len(out), 'areas;', sum(a['city'] == 'Бишкек' for a in out), 'in Бишкек')


if __name__ == '__main__':
    main()
