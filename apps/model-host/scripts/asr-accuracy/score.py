"""Auditable ASR scoring; stdlib only, never calls a model or changes settings."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import unicodedata

MAX_CELLS = 25_000_000
MAX_SPEAKERS = 8


def normalize(text: str, mode: str) -> str:
    text = unicodedata.normalize('NFC', text)
    if mode == 'normalized':
        text = ''.join(' ' if unicodedata.category(c)[0] == 'P' else c for c in text.casefold())
    return ' '.join(text.split())


def edits(reference, hypothesis) -> dict:
    """Levenshtein S/D/I. Ties prefer substitution, then deletion, then insertion."""
    if (len(reference) + 1) * (len(hypothesis) + 1) > MAX_CELLS:
        raise ValueError('Alignment exceeds bounded cell budget; score smaller reference utterances')
    previous = [(j, 0, 0, j) for j in range(len(hypothesis) + 1)]
    for i, ref in enumerate(reference, 1):
        current = [(i, 0, i, 0)]
        for j, hyp in enumerate(hypothesis, 1):
            if ref == hyp:
                current.append(previous[j - 1])
            else:
                cost, s, d, ins = previous[j - 1]
                sub = (cost + 1, s + 1, d, ins)
                cost, s, d, ins = previous[j]
                delete = (cost + 1, s, d + 1, ins)
                cost, s, d, ins = current[j - 1]
                insert = (cost + 1, s, d, ins + 1)
                current.append(min((sub, delete, insert), key=lambda x: x[0]))
        previous = current
    cost, s, d, ins = previous[-1]
    return {'substitutions': s, 'deletions': d, 'insertions': ins, 'errors': cost,
            'referenceUnits': len(reference), 'rate': cost / len(reference) if reference else None}


def text_scores(reference: str, hypothesis: str, mode: str) -> dict:
    r, h = normalize(reference, mode), normalize(hypothesis, mode)
    # CER includes single canonical spaces, case and punctuation in strict mode.
    return {'wer': edits(r.split(), h.split()), 'cer': edits(r, h)}


def assignment(costs: list[list[float]]) -> tuple[float, list[int]]:
    """Exact one-to-one assignment by subset DP, including padded dummy speakers."""
    n = len(costs)
    if n > MAX_SPEAKERS:
        raise ValueError('Speaker assignment exceeds eight-speaker diagnostic limit')
    states = {0: (0.0, [])}
    for row in costs:
        next_states = {}
        for mask, (cost, path) in states.items():
            for col in range(n):
                if mask & (1 << col):
                    continue
                key, value = mask | (1 << col), (cost + row[col], path + [col])
                if key not in next_states or value[0] < next_states[key][0]:
                    next_states[key] = value
        states = next_states
    return states[(1 << n) - 1] if n else (0.0, [])


def speaker_words(segments: list[dict], mode: str) -> dict:
    result = {}
    for segment in segments:
        speaker = segment.get('speaker')
        if not isinstance(speaker, str) or not speaker or speaker.casefold() in ('speaker unresolved', 'unknown speaker'):
            raise ValueError('Speaker labels unavailable; do not invent an identity')
        result.setdefault(speaker, []).extend(normalize(segment['text'], mode).split())
    return result


def cpwer(reference: list[dict], hypothesis: list[dict], mode: str) -> dict:
    """Concatenate each speaker in input chronological order, then optimally permute."""
    ref, hyp = speaker_words(reference, mode), speaker_words(hypothesis, mode)
    r, h = list(ref), list(hyp)
    n = max(len(r), len(h))
    if n > MAX_SPEAKERS:
        raise ValueError('Speaker count exceeds diagnostic budget')
    pairs = [[edits(ref[r[i]] if i < len(r) else [], hyp[h[j]] if j < len(h) else [])
              for j in range(n)] for i in range(n)]
    _, permutation = assignment([[p['errors'] for p in row] for row in pairs])
    selected = [pairs[i][j] for i, j in enumerate(permutation)]
    output = {key: sum(p[key] for p in selected) for key in ('errors', 'substitutions', 'deletions', 'insertions', 'referenceUnits')}
    output['rate'] = output['errors'] / output['referenceUnits'] if output['referenceUnits'] else None
    output['mapping'] = [{'reference': r[i] if i < len(r) else None, 'hypothesis': h[j] if j < len(h) else None}
                         for i, j in enumerate(permutation)]
    return output


def der(reference: list[dict], hypothesis: list[dict], duration: float) -> dict:
    """Exact time integration, zero collar, overlap included, full [0,duration] scoring region."""
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('DER needs explicit positive recording duration')
    for segment in reference + hypothesis:
        if (not isinstance(segment.get('speaker'), str) or not segment['speaker'] or
                any(not isinstance(segment.get(k), (int, float)) or not math.isfinite(segment[k]) for k in ('start', 'end')) or
                not 0 <= segment['start'] < segment['end'] <= duration):
            raise ValueError('Invalid timed speaker reference/hypothesis')
    r = sorted({s['speaker'] for s in reference})
    h = sorted({s['speaker'] for s in hypothesis})
    n = max(len(r), len(h))
    if n > MAX_SPEAKERS:
        raise ValueError('Speaker count exceeds diagnostic budget')
    points = sorted({0, duration, *(s[k] for s in reference + hypothesis for k in ('start', 'end'))})
    intervals, overlap = [], [[0.0] * n for _ in range(n)]
    for a, b in zip(points, points[1:]):
        mid = (a + b) / 2
        rs = {s['speaker'] for s in reference if s['start'] <= mid < s['end']}
        hs = {s['speaker'] for s in hypothesis if s['start'] <= mid < s['end']}
        intervals.append((b - a, rs, hs))
        for i, name in enumerate(r):
            for j, other in enumerate(h):
                if name in rs and other in hs:
                    overlap[i][j] += b - a
    _, permutation = assignment([[-v for v in row] for row in overlap])
    mapping = {r[i]: h[j] for i, j in enumerate(permutation) if i < len(r) and j < len(h)}
    miss = false_alarm = confusion = total = 0.0
    for length, rs, hs in intervals:
        correct = sum(mapping.get(name) in hs for name in rs)
        miss += length * max(0, len(rs) - len(hs))
        false_alarm += length * max(0, len(hs) - len(rs))
        confusion += length * (min(len(rs), len(hs)) - correct)
        total += length * len(rs)
    return {'missSeconds': miss, 'falseAlarmSeconds': false_alarm, 'confusionSeconds': confusion,
            'referenceSpeakerSeconds': total, 'rate': (miss + false_alarm + confusion) / total if total else None,
            'mapping': mapping, 'collarSeconds': 0, 'overlapIncluded': True, 'scoredDurationSeconds': duration}


def score(reference: dict, hypothesis: dict) -> dict:
    provenance = reference.get('provenance', {})
    if provenance.get('referenceKind') not in ('human', 'published-reference', 'public-dataset') or not provenance.get('source'):
        raise ValueError('Independent human/published reference provenance required; model output is not ground truth')
    refs, hyps = reference['items'], hypothesis['items']
    if not refs:
        raise ValueError('No reference items')
    for items in (refs, hyps):
        if len({s['id'] for s in items}) != len(items):
            raise ValueError('Duplicate item IDs')
    ref_ids = {r['id'] for r in refs}
    if any(h['id'] not in ref_ids for h in hyps):
        raise ValueError('Unexpected hypothesis ID')
    lookup = {h['id']: h for h in hyps}
    rows, failures = [], 0
    for ref in refs:
        hyp = lookup.get(ref['id'])
        missing = hyp is None or hyp.get('status', 'completed') != 'completed'
        failures += int(missing)
        if not isinstance(ref.get('audioSha256'), str) or len(ref['audioSha256']) != 64:
            raise ValueError('Each reference requires its exact audio SHA256')
        if hyp is not None and hyp.get('audioSha256') != ref['audioSha256']:
            raise ValueError('Reference/hypothesis audio hash mismatch')
        text = '' if missing else hyp['text']
        row = {'id': ref['id'], 'failedOrMissing': missing}
        for mode in ('strict', 'normalized'):
            row[mode] = text_scores(ref['text'], text, mode)
            if 'segments' in ref and not missing and 'segments' in hyp:
                try: row[mode]['cpwer'] = cpwer(ref['segments'], hyp['segments'], mode)
                except ValueError as error: row[mode]['cpwer'] = {'unavailable': str(error)}
        if 'timedSpeakers' in ref and not missing and 'timedSpeakers' in hyp:
            row['der'] = der(ref['timedSpeakers'], hyp['timedSpeakers'], ref.get('durationSeconds'))
        else:
            row['der'] = {'unavailable': 'Independent timed speaker annotations and matching hypothesis required'}
        rows.append(row)
    aggregate = {}
    for mode in ('strict', 'normalized'):
        aggregate[mode] = {}
        for metric in ('wer', 'cer'):
            total = {key: sum(row[mode][metric][key] for row in rows)
                     for key in ('errors', 'substitutions', 'deletions', 'insertions', 'referenceUnits')}
            total['rate'] = total['errors'] / total['referenceUnits'] if total['referenceUnits'] else None
            aggregate[mode][metric] = total
    policy = reference.get('selectionPolicy', {})
    eligible = (reference.get('purpose') == 'selection' and provenance.get('heldOut') is True and failures == 0 and
                isinstance(policy.get('minItems'), int) and policy['minItems'] > 0 and len(rows) >= policy['minItems'] and
                isinstance(policy.get('minReferenceWords'), int) and policy['minReferenceWords'] > 0 and
                aggregate['normalized']['wer']['referenceUnits'] >= policy['minReferenceWords'])
    return {'model': hypothesis.get('model'), 'provenance': provenance, 'purpose': reference.get('purpose'),
            'itemCount': len(rows), 'failedOrMissing': failures, 'aggregate': aggregate, 'items': rows,
            'selectionEligible': bool(eligible), 'defaultChanged': False,
            'selectionNote': 'Eligibility is only a predeclared coverage gate, not proof of representativeness or a default recommendation.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', required=True)
    parser.add_argument('--hypothesis', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    raw_ref, raw_hyp = Path(args.reference).read_bytes(), Path(args.hypothesis).read_bytes()
    result = score(json.loads(raw_ref), json.loads(raw_hyp))
    result['inputHashes'] = {k: hashlib.sha256(v).hexdigest() for k, v in [('reference', raw_ref), ('hypothesis', raw_hyp)]}
    with Path(args.out).open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2, allow_nan=False)
