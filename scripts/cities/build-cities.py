#!/usr/bin/env python3
"""Build the canonical Kyrgyzstan settlements directory.

Inputs (committed under scripts/cities/sources/):
  soate-2026.xlsx   official SOATE classifier (stat.gov.kg, 2026), ru + kg names
  osm-places.json   OSM place nodes with their raion/oblast membership
  legacy-cities.json  coordinates from the previous directory (fallback only)
  wikidata-places.json  Wikidata settlements in KG (last-resort fallback)

Output:
  prisma/seed-data/cities.json    one row per admin unit / settlement
  scripts/cities/out/review.csv   rows that need a human look (no coords,
                                  ambiguous match, matched only by oblast)

Only the Python standard library is used. Run:  python3 scripts/cities/build-cities.py

Refreshing osm-places.json: Overpass, area ISO3166-1=KG, for every
boundary=administrative relation with admin_level 4|6 ("foreach ... map_to_area")
collect place=city|town|village|hamlet nodes, ways and relations (out tags center).
"""
import csv
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / 'sources'
OUT_JSON = ROOT / 'prisma' / 'seed-data' / 'cities.json'
OUT_REVIEW = Path(__file__).resolve().parent / 'out' / 'review.csv'

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

# SOATE raion (kg) -> OSM raion (kg) where the name changed after the 2024 reform.
RAION_ALIASES = {'Айтматов району': 'Кара-Буура району'}

# Official SOATE Russian spelling differs from the one people use and search.
RU_OVERRIDES = {
    'Таш-Комур': 'Таш-Кумыр', 'Кызыл-Кыя': 'Кызыл-Кия', 'Кайынды': 'Каинды',
    'Шамалдуу-Сай': 'Шамалды-Сай',
}

# Extra search aliases (lower case) for renamed or commonly misspelled places.
ALIASES = {'41703410000010': ['жалал-абад', 'джалал-абад', 'jalal-abad']}

# Airports are places of their own (airport transfers are a first-class ride
# kind). Parent = the raion they lie in (SOATE code), else the oblast.
AIRPORTS = [
    {'iata': 'FRU', 'parent': '41708222000000', 'name_ru': 'Аэропорт «Манас»',
     'name_kg': '«Манас» эл аралык аэропорту', 'lat': 43.0613, 'lng': 74.4776,
     'aliases': ['аэропорт манас', 'манас аэропорт', 'fru', 'airport manas']},
    {'iata': 'OSS', 'parent': '41706226000000', 'name_ru': 'Аэропорт Ош',
     'name_kg': 'Ош эл аралык аэропорту', 'lat': 40.609, 'lng': 72.7932,
     'aliases': ['аэропорт ош', 'ош аэропорт', 'oss', 'airport osh']},
    {'iata': 'IKU', 'parent': '41702215000000', 'name_ru': 'Аэропорт «Иссык-Куль» (Тамчы)',
     'name_kg': '«Ысык-Көл» эл аралык аэропорту (Тамчы)', 'lat': 42.5881, 'lng': 76.7136,
     'aliases': ['аэропорт тамчы', 'аэропорт иссык-куль', 'iku']},
    {'iata': 'JUL', 'parent': '41703000000000', 'name_ru': 'Аэропорт Жалал-Абад',
     'name_kg': 'Жалал-Абад аэропорту', 'lat': 40.9441, 'lng': 72.9775,
     'aliases': ['аэропорт жалал-абад', 'аэропорт манас жалал-абад']},
    {'iata': 'BAT', 'parent': '41705214000000', 'name_ru': 'Аэропорт Баткен',
     'name_kg': 'Баткен аэропорту', 'lat': 40.0433, 'lng': 70.8380,
     'aliases': ['аэропорт баткен']},
]

LATIN_TO_CYR = str.maketrans('ABCEHKMOPTXaceopxy', 'АВСЕНКМОРТХасеорху')


def read_soate():
    with zipfile.ZipFile(DATA / 'soate-2026.xlsx') as z:
        strings = [
            ''.join(t.text or '' for t in si.iter('{%s}t' % NS['m']))
            for si in ET.fromstring(z.read('xl/sharedStrings.xml'))
        ]
        sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    rows = []
    for r in sheet.iter('{%s}row' % NS['m']):
        d = {}
        for c in r.findall('m:c', NS):
            col = re.match(r'[A-Z]+', c.get('r')).group()
            v = c.find('m:v', NS)
            if v is not None:
                d[col] = (strings[int(v.text)] if c.get('t') == 's' else v.text).strip()
        code = d.get('A', '')
        if len(code) == 14 and code.isdigit():
            rows.append({'code': code, 'ru': clean(d.get('B', '')), 'kg': clean(d.get('F') or d.get('B', ''))})
    return rows


def clean(name):
    name = re.sub(r'\s+', ' ', name).strip()
    if re.search('[а-яА-ЯёЁөүңӨҮҢ]', name):
        name = name.translate(LATIN_TO_CYR)
    name = re.sub(r'\s*-\s*', '-', name)
    name = re.sub(r'\s(ш|а)\.$', '', name)
    # SOATE editorial notes, not part of the name.
    name = re.sub(r'\s*\((в СОАТЕ[^)]*|двойное наименование|[Чч]асть|бөлүгү|участогу)\)', '', name)
    name = re.sub(r'^уч\.\s*', '', name)
    name = re.sub(r'\s*\(([^)]*)\)$', lambda m: '' if key(m.group(1)) == key(name[:m.start()]) else m.group(0), name)
    if name.count(')') > name.count('('):
        name = name.replace(')', '')
    name = re.sub(r'^(г|с)\.\s*', '', name)
    name = re.sub(r'^[Ии]м\.\s*', 'им. ', name)
    return name


def ru_name(name):
    # Product rule: Russian names keep Russian spelling, except Дж -> Ж
    # (Жалал-Абад, Жети-Огуз) — matches what prod already uses.
    name = RU_OVERRIDES.get(name, name)
    return name.replace('Дж', 'Ж').replace('дж', 'ж')


def classify(code):
    rr, ddd, aaa, ss = code[3:5], code[5:8], code[8:11], code[11:14]
    if rr == '00':
        return None
    if ddd == '000':
        return 'capital' if rr in ('11', '21') else 'oblast'
    if aaa == '000' and ss == '000':
        return None if ddd[1:] == '00' else ('raion' if ddd[0] == '2' else None)
    if aaa == '000' and ddd[0] == '4':
        return 'city'
    if ss == '000':
        return 'aiyl_aimak' if aaa[0] == '8' and aaa[1:] != '00' else None
    return 'village' if aaa[0] == '8' else 'town'


def parent_code(code, kind):
    rr, ddd, aaa = code[3:5], code[5:8], code[8:11]
    if kind in ('oblast', 'capital'):
        return None
    if kind == 'raion':
        return f'417{rr}000000000' if rr not in ('11', '21') else f'417{rr}000000000'
    if kind == 'city':
        return f'417{rr}000000000'
    if kind in ('aiyl_aimak', 'town'):
        return f'417{rr}{ddd}000000'
    return f'417{rr}{ddd}{aaa}000'


FOLD = str.maketrans({'ө': 'о', 'ү': 'у', 'ң': 'н', 'ё': 'е', 'ъ': '', 'ь': '', 'й': 'и', 'э': 'е'})


def key(name):
    if not name:
        return ''
    s = name.lower().replace('дж', 'ж')
    s = re.sub(r'\b(им\.?|имени|айылы|село|с\.|г\.|шаары|ш\.)\s*', '', s)
    s = s.translate(FOLD)
    s = re.sub(r'\(.*?\)', '', s)
    s = re.sub(r'[^a-zа-я0-9]+', '', s)
    return s


def lev1(a, b):
    if abs(len(a) - len(b)) > 1 or min(len(a), len(b)) < 5:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) <= 1
    if len(a) > len(b):
        a, b = b, a
    return any(a == b[:i] + b[i + 1:] for i in range(len(b)))


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def main():
    soate = read_soate()
    osm = json.loads((DATA / 'osm-places.json').read_text(encoding='utf-8'))
    admin = {int(k): v for k, v in osm['admin'].items()}
    places = osm['places']

    def rkey(n):
        return key(re.sub(r'\s(району|шаары)$', '', n or ''))

    osm_raion_by_key = {rkey(v['name_ky']): rid for rid, v in admin.items() if v['level'] == 6}
    osm_oblast_by_key = {rkey(re.sub(r'\sоблусу$', '', v['name_ky'] or '')): rid for rid, v in admin.items() if v['level'] == 4}

    by_raion, by_oblast = defaultdict(list), defaultdict(list)
    for p in places:
        p['keys'] = {key(p[f]) for f in ('name', 'name_ru', 'name_ky', 'alt', 'old') if p.get(f)}
        by_oblast[p['oblast']].append(p)
        if p['raion']:
            by_raion[p['raion']].append(p)

    nodes, by_code = [], {}
    for r in soate:
        kind = classify(r['code'])
        if not kind:
            continue
        n = {
            'code': r['code'], 'type': kind, 'parent': parent_code(r['code'], kind),
            'name_ru': ru_name(r['ru']), 'name_kg': r['kg'], '_ru_raw': r['ru'],
            'lat': None, 'lng': None, 'osm_id': None, 'match': None,
        }
        if kind == 'raion' and r['code'][3:5] in ('11', '21'):
            n['type'] = 'city_district'
        if r['code'] in by_code:
            continue
        twin = next((m for m in nodes if m['parent'] == n['parent'] and m['name_ru'] == n['name_ru']
                     and m['type'] == n['type']), None) if kind == 'village' else None
        if twin:
            # SOATE lists some villages twice under one aiyl aimak (split parts).
            twin.setdefault('merged', []).append(r['code'])
            by_code[r['code']] = twin
            continue
        nodes.append(n)
        by_code[r['code']] = n

    def oblast_rel(n):
        ob = by_code[f"417{n['code'][3:5]}000000000"]
        name = re.sub(r'\s(облусу|ш\.)$', '', ob['name_kg'])
        return osm_oblast_by_key.get(rkey(name))

    def raion_rel(n):
        r = by_code.get(f"417{n['code'][3:8]}000000")
        if not r:
            return None
        return osm_raion_by_key.get(rkey(RAION_ALIASES.get(r['name_kg'], r['name_kg'])))

    def candidates(n, pool, fuzzy=False):
        ks = {key(n['name_kg']), key(n['_ru_raw']), key(n['name_ru'])} - {''}
        if not fuzzy:
            return [p for p in pool if p['keys'] & ks]
        return [p for p in pool if any(lev1(a, b) for a in ks for b in p['keys'])]

    legacy = json.loads((DATA / 'legacy-cities.json').read_text(encoding='utf-8'))
    legacy_by_raion = defaultdict(list)
    for p in legacy:
        p['keys'] = {key(p['name_ru']), key(p['name_kg'])} - {''}
        p['id'] = None
        legacy_by_raion[key(re.sub(r'\sрайон$', '', p['district_ru'] or ''))].append(p)

    def legacy_pool(n):
        r = by_code.get(f"417{n['code'][3:8]}000000")
        if not r:
            return []
        k = key(re.sub(r'\sрайон$', '', r['name_ru']))
        return [p for rk, ps in legacy_by_raion.items() if rk and (rk == k or lev1(rk, k) or rk[:6] == k[:6]) for p in ps]

    review = []
    settlements = [n for n in nodes if n['type'] in ('capital', 'city', 'town', 'village')]
    used = set()
    pending = []
    for n in settlements:
        rel = raion_rel(n) if n['type'] in ('town', 'village') else None
        c = candidates(n, by_raion[rel]) if rel else []
        how = 'raion'
        if not c and rel:
            c, how = candidates(n, by_raion[rel], fuzzy=True), 'raion~'
        if not c:
            c, how = candidates(n, by_oblast[oblast_rel(n)]), 'oblast'
        if not c and n['type'] in ('town', 'village'):
            c, how = candidates(n, legacy_pool(n)), 'legacy'
        if n['type'] in ('capital', 'city'):
            big = [p for p in c if p['place'] in ('city', 'town')]
            c = big or c
        c = sorted(c, key=rank)
        if c and rank(c[0])[0] == 0:
            c = [p for p in c if rank(p)[0] == 0]
        limit = 15 if n['type'] in ('capital', 'city', 'town') else 3
        if c and spread(c) < limit:
            set_coords(n, c[0], how)
            used.add(c[0]['id'])
        elif c:
            pending.append((n, c, how))
        else:
            review.append(n)

    # Ambiguous names: choose the candidate nearest to the already-placed
    # siblings (same aiyl aimak / raion), never one taken by another row.
    for n, c, how in pending:
        sib = [s for s in settlements if s['parent'] == n['parent'] and s['lat'] is not None]
        c = [p for p in c if p['id'] is None or p['id'] not in used] or c
        if sib:
            cen = (sum(s['lat'] for s in sib) / len(sib), sum(s['lng'] for s in sib) / len(sib))
            c.sort(key=lambda p: km(cen, (p['lat'], p['lng'])))
            best = c[0]
            if km(cen, (best['lat'], best['lng'])) < 40:
                set_coords(n, best, how + '+nearest')
                used.add(best['id'])
                continue
        n['match'] = f'ambiguous:{len(c)}'
        review.append(n)

    # Last resort for still-unplaced rows: Wikidata / legacy by name, accepted
    # only when the point sits close to the already-placed siblings.
    wiki = json.loads((DATA / 'wikidata-places.json').read_text(encoding='utf-8'))['places']
    for p in wiki:
        p['keys'] = {key(p['name_ky']), key(p['name_ru'])} - {''}
    for n in settlements:
        if n['lat'] is not None or n['type'] not in ('town', 'village'):
            continue
        sib = [s for s in settlements if s['parent'] == n['parent'] and s['lat'] is not None]
        if not sib:
            continue
        cen = (sum(s['lat'] for s in sib) / len(sib), sum(s['lng'] for s in sib) / len(sib))
        c = candidates(n, wiki) + candidates(n, legacy_pool(n))
        c = [p for p in c if km(cen, (p['lat'], p['lng'])) < 25]
        if c:
            c.sort(key=lambda p: km(cen, (p['lat'], p['lng'])))
            set_coords(n, c[0], 'near-siblings')
            review[:] = [r for r in review if r is not n]

    # Far from siblings = probably the wrong homonym.
    for n in settlements:
        if n['lat'] is None or n['type'] != 'village':
            continue
        sib = [s for s in settlements if s['parent'] == n['parent'] and s['lat'] is not None and s is not n]
        if len(sib) >= 2:
            cen = (sum(s['lat'] for s in sib) / len(sib), sum(s['lng'] for s in sib) / len(sib))
            if km(cen, (n['lat'], n['lng'])) > 60:
                if n['match'].startswith('oblast'):
                    # Same name elsewhere in the oblast — not this village.
                    n['lat'] = n['lng'] = n['osm_id'] = None
                n['match'] = (n['match'] or '') + ':far'
                review.append(n)

    # Admin units: centroid of children (aiyl aimak, raion), oblast from children too.
    for kind in ('aiyl_aimak', 'raion', 'city_district', 'oblast'):
        for n in nodes:
            if n['type'] != kind or n['lat'] is not None:
                continue
            kids = [k for k in nodes if k['parent'] == n['code'] and k['lat'] is not None]
            if kids:
                n['lat'] = round(sum(k['lat'] for k in kids) / len(kids), 5)
                n['lng'] = round(sum(k['lng'] for k in kids) / len(kids), 5)
                n['match'] = 'centroid'

    # SOATE lists a few villages under two aiyl aimaks; when both rows land on
    # the same OSM point under the same name, keep one (prefer town over village).
    rank_type = {'capital': 0, 'city': 1, 'town': 2, 'village': 3}
    by_point = defaultdict(list)
    for n in settlements:
        if n['osm_id']:
            by_point[(n['osm_id'], key(n['name_ru']))].append(n)
    for twins in by_point.values():
        if len(twins) < 2:
            continue
        twins.sort(key=lambda t: (rank_type[t['type']], t['code']))
        keep = twins[0]
        for t in twins[1:]:
            keep.setdefault('merged', []).append(t['code'])
            keep['merged'] += t.get('merged', [])
            nodes.remove(t)
            settlements.remove(t)

    # OSM villages SOATE doesn't list separately (resorts like Бостери, villages
    # merged into other units): fix an approximate SOATE row of the same name in
    # that raion, otherwise add the village under its raion (code 'osm:<id>').
    raion_by_rel = {}
    for n in nodes:
        if n['type'] == 'raion':
            rel = osm_raion_by_key.get(rkey(RAION_ALIASES.get(n['name_kg'], n['name_kg'])))
            if rel:
                raion_by_rel[rel] = n
    placed_pts = [(n['lat'], n['lng']) for n in settlements if n['lat'] is not None]
    used_osm = {n['osm_id'] for n in settlements if n['osm_id']}
    for p in places:
        pid = str(p['id'])
        if p['place'] not in ('village', 'town') or not p.get('name') or not pid.startswith('n') or pid in used_osm:
            continue
        raion = raion_by_rel.get(p['raion'])
        if not raion or re.search(r'станция|дачи|парк|новостройк|кольцо|гидропарт', p['name'] + (p.get('name_ru') or ''), re.I):
            continue
        nearest = min(((km((p['lat'], p['lng']), (n['lat'], n['lng'])), n) for n in settlements
                       if n['lat'] is not None), default=(99, None), key=lambda t: t[0])
        if nearest[0] <= 2:
            # A different OSM name on (almost) the same spot is a former name
            # («Семёновка» → Кожояр): searchable alias of that place.
            if not (p['keys'] & {key(nearest[1]['name_ru']), key(nearest[1]['name_kg'])}):
                nearest[1].setdefault('extra_aliases', set()).update(
                    x for x in (p.get('name_ru'), p.get('name')) if x)
            continue
        # Same name already in the raion within 15 km → it's that place.
        if any(n['lat'] is not None and n['code'][:8] == raion['code'][:8]
               and p['keys'] & {key(n['name_kg']), key(n['_ru_raw']), key(n['name_ru'])}
               and km((p['lat'], p['lng']), (n['lat'], n['lng'])) <= 15 for n in settlements):
            continue
        twin = next((n for n in settlements if n['lat'] is None and n['code'][:8] == raion['code'][:8]
                     and p['keys'] & {key(n['name_kg']), key(n['_ru_raw'])}), None)
        if twin:
            set_coords(twin, p, 'osm-extra')
            review[:] = [r for r in review if r is not twin]
            continue
        ru = ru_name(clean(p.get('name_ru') or p['name']))
        kg = clean(p.get('name_ky') or p['name'])
        n = {'code': f"osm:{pid}", 'type': 'village', 'parent': raion['code'], 'name_ru': ru, 'name_kg': kg,
             '_ru_raw': ru, 'lat': p['lat'], 'lng': p['lng'], 'osm_id': pid, 'match': 'osm-only'}
        nodes.append(n)
        settlements.append(n)
        by_code[n['code']] = n
        placed_pts.append((p['lat'], p['lng']))

    # A village named like a nearby city / town (≤ 5 km) is the same place
    # listed twice (e.g. Кочкор-Ата) — keep the city / town.
    for c in [n for n in settlements if n['type'] in ('capital', 'city', 'town') and n['lat'] is not None]:
        for v in [n for n in settlements if n['type'] == 'village' and n['lat'] is not None]:
            if key(v['name_ru']) == key(c['name_ru']) and km((c['lat'], c['lng']), (v['lat'], v['lng'])) <= 5:
                c.setdefault('merged', []).append(v['code'])
                nodes.remove(v)
                settlements.remove(v)

    for a in AIRPORTS:
        n = {'code': f"airport:{a['iata']}", 'type': 'airport', 'parent': a['parent'],
             'name_ru': a['name_ru'], 'name_kg': a['name_kg'], '_ru_raw': a['name_ru'],
             'lat': a['lat'], 'lng': a['lng'], 'osm_id': None, 'match': 'manual',
             'extra_aliases': set(a['aliases'] + ['аэропорт', 'airport'])}
        nodes.append(n)
        settlements.append(n)
        by_code[n['code']] = n

    # Settlements without a point get their aiyl aimak's centroid, flagged
    # as approximate so the map can draw them differently.
    for n in settlements:
        n['approx'] = n['lat'] is None
        if n['approx']:
            par = by_code.get(n['parent'])
            while par and par['lat'] is None:
                par = by_code.get(par['parent'])
            if par:
                n['lat'], n['lng'] = par['lat'], par['lng']

    by_id = {p['id']: p for p in places}
    rows = []
    for n in nodes:
        o = by_id.get(n['osm_id']) or {}
        alias = {x.lower() for x in (o.get('name_ru'), o.get('old'), o.get('alt'), n['_ru_raw']) if x}
        alias |= {x.lower() for x in n.get('extra_aliases', ())}
        alias |= set(ALIASES.get(n['code'], []))
        alias -= {n['name_ru'].lower(), n['name_kg'].lower()}
        rows.append({
            'code': n['code'], 'parent': n['parent'], 'type': n['type'],
            'name_ru': n['name_ru'], 'name_kg': n['name_kg'],
            'lat': n['lat'], 'lng': n['lng'], 'approx': bool(n.get('approx')),
            'osm_id': n['osm_id'], 'aliases': sorted(alias),
            'merged_codes': n.get('merged', []),
            'searchable': n['type'] in ('capital', 'city', 'town', 'village', 'airport'),
        })
    OUT_JSON.write_text(json.dumps(rows, ensure_ascii=False, indent=0) + '\n', encoding='utf-8')

    OUT_REVIEW.parent.mkdir(exist_ok=True)
    seen = set()
    with OUT_REVIEW.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['code', 'type', 'name_ru', 'name_kg', 'parent_ru', 'raion_ru', 'issue', 'lat', 'lng'])
        for n in review:
            if n['code'] in seen:
                continue
            seen.add(n['code'])
            par = by_code.get(n['parent'], {})
            rai = by_code.get(f"417{n['code'][3:8]}000000", {})
            w.writerow([n['code'], n['type'], n['name_ru'], n['name_kg'], par.get('name_ru', ''),
                        rai.get('name_ru', ''), n['match'] or 'no_osm_match', n['lat'], n['lng']])

    stats = defaultdict(int)
    for n in nodes:
        stats[n['type']] += 1
    placed = sum(1 for n in settlements if not n['approx'])
    print(dict(stats))
    print(f'settlements: {len(settlements)}, with coords: {placed}, review rows: {len(seen)}')


SETTLEMENT_PLACES = ('city', 'town', 'village', 'hamlet')


def rank(p):
    # Real settlements before suburbs/localities; points before areas.
    pid = str(p.get('id') or '')
    return (0 if p.get('place') in SETTLEMENT_PLACES or p.get('place') is None else 1,
            0 if pid.startswith('n') else 1)


def spread(ps):
    return max(km((a['lat'], a['lng']), (b['lat'], b['lng'])) for a in ps for b in ps)


def set_coords(n, p, how):
    pid = p.get('id')
    n['lat'], n['lng'], n['match'] = p['lat'], p['lng'], how
    n['osm_id'] = pid if isinstance(pid, str) and pid[:1] in ('n', 'w', 'r') and not pid.startswith('wQ') else None


if __name__ == '__main__':
    sys.exit(main())
