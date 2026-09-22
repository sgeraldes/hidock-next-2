import json
from pathlib import Path
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(sys.argv[1])
s = json.loads((root / 'summary.json').read_text())
resources = [json.loads(line) for line in (root / 'resources.jsonl').read_text().splitlines()]
plt.style.use('dark_background')
fig, (ax, mem) = plt.subplots(2, 1, figsize=(12, 7), gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
fig.patch.set_facecolor('#111a24')
for a in (ax, mem):
    a.set_facecolor('#111a24')
    a.grid(axis='x', alpha=.18)
spans = s['spans']
for i, span in enumerate(spans):
    ax.barh(i, span['duration']/1000, left=span['start']/1000, color='#57cbb5', height=.6)
    ax.text((span['start']+span['duration'])/1000+.2, i, f"{span['duration']/1000:.2f}s", va='center', fontsize=9)
ax.set_yticks(range(len(spans)), [r['name'] for r in spans])
ax.invert_yaxis()
ax.set_title('HiDock · measured startup waterfall', loc='left', fontsize=20, pad=25)
for stall in s['stallsOver100Ms']:
    ax.axvspan((stall['atMs']-stall['delayMs'])/1000, stall['atMs']/1000, color='#ff756b', alpha=.2)
mem.plot([r['seconds'] for r in resources], [sum(p['rss'] for p in r['processes'])/1024**3 for r in resources], color='#bfa0ff')
mem.set_ylabel('App working set\nGiB')
mem.set_xlabel('Seconds since benchmark app launch')
mem.set_xlim(0, s['elapsedSeconds']+1)
fig.text(.04, .02, '6 logical CPUs · isolated database · USB / transcription jobs / network sync excluded\nRed bands: main heartbeat lateness >100 ms. Task durations include I/O; gaps include scheduler delays.', fontsize=9, color='#bacada')
fig.tight_layout(rect=(0,.09,1,1))
fig.savefig(root / 'waterfall.png', dpi=140)
