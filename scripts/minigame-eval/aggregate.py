#!/usr/bin/env python3
"""Aggregate Test 2 (skill/*.jsonl) into per-game markdown tables (mean ± sd).

Usage: python3 -I scripts/minigame-eval/aggregate.py <out_dir> [skill_subdir]
"""
import glob
import json
import os
import statistics as st
import sys

out = sys.argv[1]
sub = sys.argv[2] if len(sys.argv) > 2 else 'skill'


def ms(xs, fmt='{:.1f}'):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = st.mean(xs)
    s = st.stdev(xs) if len(xs) > 1 else 0
    return (fmt + ' ± ' + fmt).format(m, s)


rows = {}
for f in sorted(glob.glob(os.path.join(out, sub, '*.jsonl'))):
    for line in open(f):
        d = json.loads(line)
        rows.setdefault(d['character'], []).append(d)

print(f'### Fleet Battle ({sub})\n')
print('| Character | games | shots to sink all | hit rate | follow-up % | sink span (shots/ship) | race wins vs baseline | illegal / game | retries | failed turns | stuck | s / turn | $ / game |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for ch, rs in rows.items():
    bs = [r for r in rs if r['game'] == 'bs']
    if not bs:
        continue
    print('| {} | {} | {} | {} | {} | {} | {}/{} | {} | {} | {} | {} | {} | {} |'.format(
        ch, len(bs),
        ms([r['aiShots'] for r in bs if r['finishedAll']], '{:.0f}'),
        ms([r['hitRate'] * 100 for r in bs], '{:.0f}') + '%',
        ms([r['followUpRate'] * 100 for r in bs if r['followUpRate'] == r['followUpRate']], '{:.0f}'),
        ms([st.mean(r['sinkSpans']) for r in bs if r['sinkSpans']], '{:.1f}'),
        sum(1 for r in bs if r['raceWin']), len(bs),
        ms([r['illegal'] or 0 for r in bs], '{:.1f}'),
        sum(r['retries'] or 0 for r in bs),
        sum(r['failedTurns'] or 0 for r in bs),
        sum(1 for r in bs if r['stuck']),
        ms([r['turnMsAvg'] / 1000 for r in bs if r['turnMsAvg']], '{:.1f}'),
        ms([r['llm']['cost'] for r in bs], '{:.3f}'),
    ))
base = [r['baselineShotsOnPlayerFleet'] for rs in rows.values() for r in rs if r['game'] == 'bs']
if base:
    seen = {}
    for rs in rows.values():
        for r in rs:
            if r['game'] == 'bs':
                seen[r['seed']] = r['baselineShotsOnPlayerFleet']
    print(f'\nBaseline (hunt/target + parity) on the same player fleets: {ms(list(seen.values()), "{:.0f}")} shots.')

print(f'\n### Four in a Row ({sub})\n')
print('| Character | games | W-D-L | as red (W-D-L) | as yellow (W-D-L) | missed wins | missed forced blocks | gave a win | illegal | failed turns | s / turn | $ / game |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for ch, rs in rows.items():
    c4 = [r for r in rs if r['game'] == 'c4']
    if not c4:
        continue

    def wdl(xs):
        return '{}-{}-{}'.format(sum(1 for r in xs if r['outcome'] == 'win'), sum(1 for r in xs if r['outcome'] == 'draw'), sum(1 for r in xs if r['outcome'] == 'loss'))

    print('| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |'.format(
        ch, len(c4), wdl(c4), wdl([r for r in c4 if r['aiColor'] == 'r']), wdl([r for r in c4 if r['aiColor'] == 'y']),
        sum(r['missedWins'] for r in c4), sum(r['missedBlocks'] for r in c4), sum(r['gaveWins'] for r in c4),
        sum(r['illegal'] or 0 for r in c4), sum(r['failedTurns'] or 0 for r in c4),
        ms([r['turnMsAvg'] / 1000 for r in c4 if r['turnMsAvg']], '{:.1f}'),
        ms([r['llm']['cost'] for r in c4], '{:.4f}'),
    ))
