"""Compare startup benchmark runs against a baseline, one panel per run.

Usage: python compare.py OUTPUT_DIR BASELINE_RUN [RUN ...] [--label=RUN_DIR_NAME=NAME ...]

Each run is a directory written by benchmark-startup.py (and report.py, for
summary.json). The first run is the baseline; every other run is compared with
it. Writes OUTPUT_DIR/compare.html, a single self-contained page:

  - a table of the numbers that decide responsiveness, with the change against
    the baseline;
  - per run, a timeline in the style of a profiler's process view: one lane per
    process with its CPU use over time, main- and renderer-thread lateness,
    main-thread stalls over 100 ms as red bands, and the measured startup tasks;
  - per run, a flame graph of the main process built from the V8 CPU profile.
"""
import html
import json
import sys
import zlib
from collections import defaultdict
from pathlib import Path

W = 1180  # drawing width in px
MAX_DEPTH = 28  # flame graph rows; deeper module-loading chains are cut off


def load(run: Path):
    summary = json.loads((run / 'summary.json').read_text())
    events = [json.loads(l) for l in (run / 'events.jsonl').read_text().splitlines() if l.strip()]
    resources = [json.loads(l) for l in (run / 'resources.jsonl').read_text().splitlines() if l.strip()]
    profile = json.loads((run / 'main.cpuprofile').read_text()) if (run / 'main.cpuprofile').exists() else None
    return summary, events, resources, profile


def cpu_seconds_total(resources):
    # A pid can be reused inside a run: when a counter goes down, the old
    # process's last value is banked and the new one counts from zero.
    last, banked = {}, 0.0
    for r in resources:
        for p in r['processes']:
            previous = last.get(p['pid'])
            if previous is not None and p['cpuSeconds'] < previous:
                banked += previous
            last[p['pid']] = p['cpuSeconds']
    return banked + sum(last.values())


def metrics(summary, events, resources):
    # A field the run did not produce is None and shows as n/a: a window that
    # never appeared must not read as a window that appeared at 0 s.
    def seconds(key):
        v = summary.get(key)
        return None if v is None else v / 1000

    stalls = summary.get('stallsOver100Ms', [])
    return {
        'Window shown (s)': seconds('windowMs'),
        'Startup settled (s)': seconds('bootSettledMs'),
        'Worst main-thread stall (s)': seconds('maxMainDelayMs'),
        'Main-thread stalls over 100 ms': len(stalls),
        'Time frozen in those stalls (s)': sum(s['delayMs'] for s in stalls) / 1000,
        'Worst renderer lateness (ms)': summary.get('maxRendererDelayMs'),
        'Peak memory, all processes (GiB)': summary.get('peakTreeGiB'),
        'Peak memory, main process (GiB)': summary.get('peakMainGiB'),
        'CPU time, all processes (s)': cpu_seconds_total(resources),
        'Run length (s)': summary.get('elapsedSeconds'),
    }


# Rows shown for context, never coloured better or worse.
NEUTRAL = {'Run length (s)'}


def fmt(v):
    if v is None:
        return 'n/a'
    if isinstance(v, int):
        return f'{v:,}'
    return f'{v:,.2f}'


def delta_cell(base, value, lower_is_better=True, neutral=False):
    if base in (None, 0) or value is None:
        return '<td class="num">n/a</td>'
    change = (value - base) / base * 100
    if neutral:
        return f'<td class="num same">{change:+.0f}%</td>'
    better = change < 0 if lower_is_better else change > 0
    cls = 'same' if abs(change) < 5 else ('good' if better else 'bad')
    return f'<td class="num {cls}">{change:+.0f}%</td>'


def color(name: str) -> str:
    h = zlib.crc32(name.encode()) & 0xFFFF
    hue = 8 + h % 48  # reds, oranges, yellows
    light = 38 + (h >> 8) % 18
    return f'hsl({hue},70%,{light}%)'


def timeline_svg(summary, events, resources):
    total = max(summary.get('elapsedSeconds') or 0, resources[-1]['seconds'] if resources else 0, 0.001)
    x = lambda s: 150 + (W - 160) * s / total
    rows = []
    y = 24
    # Axis
    ticks = ''.join(
        f'<line x1="{x(t):.1f}" y1="14" x2="{x(t):.1f}" y2="100%" class="grid"/>'
        f'<text x="{x(t):.1f}" y="10" class="tick">{t:g}s</text>'
        for t in range(0, int(total) + 1, max(1, int(total // 12) or 1))
    )
    # Process lanes: CPU % between samples, drawn as bars whose opacity is the load.
    by_pid = defaultdict(list)
    for r in resources:
        for p in r['processes']:
            by_pid[p['pid']].append((r['seconds'], p['cpuSeconds'], p.get('type'), p['rss']))
    order = sorted(by_pid, key=lambda pid: by_pid[pid][0][0])
    for i, pid in enumerate(order):
        samples = by_pid[pid]
        # Runs from before the harness recorded process types: the first
        # process to appear is the main one.
        kind = samples[-1][2] or ('main' if i == 0 else 'child')
        label = f'{kind} #{pid}'
        peak_rss = max(s[3] for s in samples) / 1024**2
        rows.append(f'<text x="4" y="{y+12}" class="lane">{html.escape(label[:22])}</text>')
        rows.append(f'<rect x="150" y="{y}" width="{W-160}" height="16" class="lanebg"/>')
        for (t0, c0, *_), (t1, c1, *_) in zip(samples, samples[1:]):
            if t1 <= t0:
                continue
            load = max(0.0, (c1 - c0) / (t1 - t0))  # cores busy
            if load < 0.02:
                continue
            op = min(1.0, 0.25 + load / 2)
            rows.append(f'<rect x="{x(t0):.1f}" y="{y}" width="{max(1, x(t1)-x(t0)):.1f}" height="16" '
                        f'fill="#ff8c1a" opacity="{op:.2f}"><title>{html.escape(label)}: {load*100:.0f}% of a core at {t0:.1f}s</title></rect>')
        rows.append(f'<text x="{W-6}" y="{y+12}" class="lanenote">{peak_rss:,.0f} MB peak</text>')
        y += 20
    # Main-thread lateness and stalls
    y += 6
    rows.append(f'<text x="4" y="{y+12}" class="lane">main thread late</text>')
    rows.append(f'<rect x="150" y="{y}" width="{W-160}" height="28" class="lanebg"/>')
    for e in events:
        if e['type'] == 'heartbeat' and e['delayMs'] > 0:
            h = min(28, 28 * e['delayMs'] / 1000)
            rows.append(f'<rect x="{x(e["ms"]/1000):.1f}" y="{y+28-h:.1f}" width="2" height="{h:.1f}" fill="#57cbb5">'
                        f'<title>{e["delayMs"]:.0f} ms late at {e["ms"]/1000:.1f}s</title></rect>')
    stall_bands = ''.join(
        f'<rect x="{x((s["atMs"]-s["delayMs"])/1000):.1f}" y="14" width="{max(2, x(s["atMs"]/1000)-x((s["atMs"]-s["delayMs"])/1000)):.1f}" '
        f'height="100%" class="stall"><title>main thread frozen {s["delayMs"]/1000:.2f}s</title></rect>'
        for s in summary.get('stallsOver100Ms', [])
    )
    y += 34
    renderer = [s for e in events if e['type'] == 'renderer-heartbeats' for s in e.get('samples', [])]
    rows.append(f'<text x="4" y="{y+12}" class="lane">renderer late</text>')
    rows.append(f'<rect x="150" y="{y}" width="{W-160}" height="20" class="lanebg"/>')
    for s in renderer:
        if s.get('delayMs', 0) > 0 and 'ms' in s:
            h = min(20, 20 * s['delayMs'] / 200)
            rows.append(f'<rect x="{x(s["ms"]/1000):.1f}" y="{y+20-h:.1f}" width="2" height="{h:.1f}" fill="#bfa0ff"/>')
    y += 28
    # Startup tasks
    for span in sorted(summary.get('spans', []), key=lambda s: s['start']):
        rows.append(f'<text x="4" y="{y+11}" class="lane">{html.escape(span["name"][:22])}</text>')
        rows.append(f'<rect x="{x(span["start"]/1000):.1f}" y="{y+1}" width="{max(2, x((span["start"]+span["duration"])/1000)-x(span["start"]/1000)):.1f}" '
                    f'height="12" fill="#3b82f6"><title>{html.escape(span["name"])}: {span["duration"]/1000:.2f}s</title></rect>')
        rows.append(f'<text x="{x((span["start"]+span["duration"])/1000)+4:.1f}" y="{y+11}" class="lanenote2">{span["duration"]/1000:.2f}s</text>')
        y += 16
    for label, key in (('window', 'windowMs'), ('settled', 'bootSettledMs')):
        v = summary.get(key)
        if v:
            rows.append(f'<line x1="{x(v/1000):.1f}" y1="14" x2="{x(v/1000):.1f}" y2="{y}" class="mark"/>'
                        f'<text x="{x(v/1000)+3:.1f}" y="24" class="marktext">{label} {v/1000:.1f}s</text>')
    return f'<svg viewBox="0 0 {W} {y+6}" class="tl">{ticks}{stall_bands}{"".join(rows)}</svg>'


def flame_svg(profile, threshold=0.003):
    if not profile:
        return '<p class="muted">No CPU profile in this run.</p>'
    nodes = {n['id']: n for n in profile['nodes']}
    self_us = defaultdict(float)
    for sid, dt in zip(profile['samples'], profile['timeDeltas']):
        self_us[sid] += max(dt, 0)
    parent = {}
    for n in profile['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    root_id = profile['nodes'][0]['id']
    total_us = {}

    def total(nid):
        if nid in total_us:
            return total_us[nid]
        # Busy time only: idle and program time would take most of the width
        # and squeeze the work that matters into a sliver.
        if nodes[nid]['callFrame']['functionName'] in ('(idle)', '(program)'):
            total_us[nid] = 0.0
            return 0.0
        t = self_us[nid] + sum(total(c) for c in nodes[nid].get('children', []))
        total_us[nid] = t
        return t

    sys.setrecursionlimit(20000)
    grand = total(root_id)
    if grand <= 0:
        return '<p class="muted">Empty CPU profile.</p>'

    def name(n):
        cf = n['callFrame']
        fn = cf['functionName'] or '(anonymous)'
        url = cf.get('url') or ''
        tail = url.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
        return f'{fn}' + (f'  {tail}:{cf.get("lineNumber", 0)+1}' if tail else '')

    rects = []
    max_depth = [0]
    row_h = 17

    def draw(nid, x0, depth):
        t = total_us[nid]
        width = (W - 20) * t / grand
        if t / grand < threshold or depth > MAX_DEPTH:
            return
        max_depth[0] = max(max_depth[0], depth)
        n = nodes[nid]
        label = name(n)
        rects.append((x0, depth, width, label, t, n['callFrame']['functionName'] in ('(idle)', '(program)', '(garbage collector)')))
        cx = x0
        for c in sorted(n.get('children', []), key=lambda c: -total_us.get(c, 0)):
            draw(c, cx, depth + 1)
            cx += (W - 20) * total_us.get(c, 0) / grand

    draw(root_id, 10, 0)
    height = (max_depth[0] + 1) * row_h + 10
    out = []
    for x0, depth, width, label, t, special in rects:
        y = height - (depth + 1) * row_h
        fill = '#5b6573' if special else color(label.split('  ')[0])
        pct = t / grand * 100
        text = ''
        if width > 40:
            chars = int(width / 6.4)
            shown = label if len(label) <= chars else label[: max(1, chars - 1)] + '…'
            text = f'<text x="{x0+3:.1f}" y="{y+12}" class="ft">{html.escape(shown)}</text>'
        out.append(f'<g><rect x="{x0:.1f}" y="{y}" width="{max(width-0.5, 0.5):.1f}" height="{row_h-1}" fill="{fill}">'
                   f'<title>{html.escape(label)}\n{t/1000:,.0f} ms ({pct:.1f}%)</title></rect>{text}</g>')
    return (f'<svg viewBox="0 0 {W} {height}" class="fg">{"".join(out)}</svg>'
            f'<p class="muted">Main process, {grand/1e6:.1f} s of busy CPU (idle excluded). Width is time on the stack; the bottom row is the root. '
            f'Frames under {threshold*100:.1f}% and stacks deeper than {MAX_DEPTH} are hidden. Grey is the garbage collector.</p>')


def hot_functions(profile, limit=12):
    if not profile:
        return ''
    nodes = {n['id']: n for n in profile['nodes']}
    self_us = defaultdict(float)
    for sid, dt in zip(profile['samples'], profile['timeDeltas']):
        cf = nodes[sid]['callFrame']
        if cf['functionName'] in ('(idle)', '(program)'):
            continue
        tail = (cf.get('url') or '').rsplit('/', 1)[-1]
        self_us[(cf['functionName'] or '(anonymous)', tail, cf.get('lineNumber', 0) + 1)] += max(dt, 0)
    top = sorted(self_us.items(), key=lambda kv: -kv[1])[:limit]
    rows = ''.join(f'<tr><td>{html.escape(fn)}</td><td>{html.escape(f"{u}:{ln}" if u else "")}</td>'
                   f'<td class="num">{us/1000:,.0f}</td></tr>' for (fn, u, ln), us in top)
    return f'<table class="small"><tr><th>Function (self time)</th><th>Where</th><th>ms</th></tr>{rows}</table>'


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--label')]
    labels = {}
    for a in sys.argv[1:]:
        if a.startswith('--label='):
            k, v = a[len('--label='):].split('=', 1)
            labels[k] = v
    out = Path(args[0])
    runs = [Path(a) for a in args[1:]]
    out.mkdir(parents=True, exist_ok=True)
    data = [(r, *load(r)) for r in runs]
    names = [labels.get(r.name, r.name) for r in runs]
    ms = [metrics(s, e, res) for _, s, e, res, _ in data]
    lower_better = {k: True for k in ms[0]}

    head = '<tr><th>Metric</th>' + ''.join(
        f'<th>{html.escape(n)}{" (baseline)" if i == 0 else ""}</th>' + ('' if i == 0 else '<th>vs baseline</th>')
        for i, n in enumerate(names)) + '</tr>'
    body = ''
    for k in ms[0]:
        body += f'<tr><td>{html.escape(k)}</td>'
        for i, m in enumerate(ms):
            body += f'<td class="num">{fmt(m[k])}</td>'
            if i:
                body += delta_cell(ms[0][k], m[k], lower_better[k], neutral=k in NEUTRAL)
        body += '</tr>'

    panels = ''
    for (run, s, e, res, prof), name in zip(data, names):
        panels += (f'<section><h2>{html.escape(name)}</h2><p class="muted">{html.escape(str(run))} · '
                   f'{s.get("reason", "")} · {s.get("elapsedSeconds", 0):.0f} s run · cache {s.get("cacheMode", "")}</p>'
                   f'<h3>Timeline</h3>{timeline_svg(s, e, res)}'
                   f'<h3>Main process flame graph</h3>{flame_svg(prof)}'
                   f'<h3>Hottest functions</h3>{hot_functions(prof)}</section>')

    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Startup comparison</title>
<style>
:root {{ --bg:#101820; --panel:#16212c; --ink:#e6edf3; --muted:#8fa1b3; --line:#2a3847; }}
body {{ background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,Segoe UI,sans-serif; margin:0; padding:16px; }}
h1 {{ font-size:22px; margin:0 0 4px }} h2 {{ font-size:18px; margin:28px 0 2px }} h3 {{ font-size:14px; margin:18px 0 6px; color:var(--muted) }}
table {{ border-collapse:collapse; margin:12px 0; }} th,td {{ border-bottom:1px solid var(--line); padding:5px 10px; text-align:left }}
td.num {{ text-align:right; font-variant-numeric:tabular-nums }} .good {{ color:#5fd38a }} .bad {{ color:#ff6b61; font-weight:600 }} .same {{ color:var(--muted) }}
table.small td, table.small th {{ font-size:12px; padding:3px 8px }}
section {{ background:var(--panel); border-radius:6px; padding:4px 14px 12px; margin-top:18px }}
svg {{ width:100%; height:auto; display:block; background:#0c131a }}
.muted {{ color:var(--muted); font-size:12px }} .tick {{ fill:var(--muted); font-size:10px; text-anchor:middle }}
.grid {{ stroke:#1d2a37 }} .lane {{ fill:var(--ink); font-size:11px }} .lanenote {{ fill:var(--muted); font-size:10px; text-anchor:end }}
.lanenote2 {{ fill:var(--muted); font-size:10px }} .lanebg {{ fill:#132029 }} .stall {{ fill:#ff4d40; opacity:.22 }}
.mark {{ stroke:#e6edf3; stroke-dasharray:3 3 }} .marktext {{ fill:var(--ink); font-size:10px }}
.ft {{ fill:#111; font-size:11px; font-family:Consolas,monospace }}
.wrap {{ overflow-x:auto }}
</style></head><body>
<h1>Startup comparison</h1>
<p class="muted">Real Electron startup on an isolated copy of the library; USB, transcription jobs and network sync excluded.
The first run is the baseline. Changes of 5% or less are grey; worse is red, better is green.</p>
<div class="wrap"><table>{head}{body}</table></div>
{panels}
</body></html>'''
    (out / 'compare.html').write_text(page, encoding='utf-8')
    print(out / 'compare.html')


if __name__ == '__main__':
    main()
