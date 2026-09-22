"""Summarize measured events, process-tree samples and V8 CPU samples."""
import collections
import html
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
resources = [json.loads(line) for line in (root / 'resources.jsonl').read_text().splitlines()]
run = json.loads((root / 'run.json').read_text())
starts = {e['name']: e['ms'] for e in events if e['type'] == 'task-start'}
spans = [{'name': e['name'], 'start': starts[e['name']], 'duration': e['elapsedMs'], 'ok': e['ok']}
         for e in events if e['type'] == 'task-duration']
worker_spans = []
for event in events:
    prefix = '[LocalEmbedder] Worker timing '
    if event['type'] == 'milestone' and event['message'].startswith(prefix):
        timing = json.loads(event['message'][len(prefix):])
        worker_spans.append({'name': timing['name'], 'start': event['ms'] - timing['elapsedMs'],
                             'duration': timing['elapsedMs'], 'ok': True, 'worker': True})
spans.extend(worker_spans)
heartbeats = [e for e in events if e['type'] == 'heartbeat']
renderer = [s for e in events if e['type'] == 'renderer-heartbeats' and e['id'] == 2 for s in e['samples']]
reveal = next((e['ms'] for e in events if e['type'] == 'milestone' and 'Main window revealed' in e['message']), None)
settled = next((e['ms'] for e in events if e['type'] == 'boot-settled'), None)
summary = dict(run, windowMs=reveal, bootSettledMs=settled,
    peakTreeGiB=max(sum(p['rss'] for p in r['processes']) for r in resources) / 1024**3,
    peakMainGiB=max(e['rss'] for e in heartbeats) / 1024**3,
    maxMainDelayMs=max(e['delayMs'] for e in heartbeats),
    maxRendererDelayMs=max((e['delayMs'] for e in renderer), default=None),
    stallsOver100Ms=[{'atMs': e['ms'], 'delayMs': e['delayMs']} for e in heartbeats if e['delayMs'] > 100],
    spans=spans)
cpu = []
previous = {}
for r in resources:
    value = 0
    for p in r['processes']:
        if p['pid'] in previous:
            old_time, old_cpu = previous[p['pid']]
            value += max(0, p['cpuSeconds'] - old_cpu) / max(.001, r['seconds'] - old_time)
        previous[p['pid']] = (r['seconds'], p['cpuSeconds'])
    cpu.append({'ms': r['seconds'] * 1000, 'cores': value,
                'gib': sum(p['rss'] for p in r['processes']) / 1024**3})
summary['peakCpuCoreEquivalents'] = max(r['cores'] for r in cpu)
profile_path = root / 'main.cpuprofile'
hot = []
if profile_path.exists():
    profile = json.loads(profile_path.read_text())
    nodes = {n['id']: n for n in profile['nodes']}
    totals = collections.Counter()
    for sample, delta in zip(profile.get('samples', []), profile.get('timeDeltas', [])):
        frame = nodes[sample]['callFrame']
        totals[(frame['functionName'] or '(anonymous)', frame.get('url', '').split('/')[-1], frame['lineNumber'] + 1)] += delta / 1000
    hot = [{'name': name, 'file': file, 'line': line, 'sampledMs': round(ms, 1)}
           for (name, file, line), ms in totals.most_common(18)]
summary['cpuSelfSamples'] = hot
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
trace = []
for span in spans:
    trace.append({'name': span['name'], 'cat': 'boot', 'ph': 'X', 'ts': span['start'] * 1000,
                  'dur': span['duration'] * 1000, 'pid': 2 if span.get('worker') else 1, 'tid': 1})
for e in heartbeats:
    if e['delayMs'] > 50:
        trace.append({'name': 'Main heartbeat lateness', 'cat': 'responsiveness', 'ph': 'X',
                      'ts': (e['ms'] - e['delayMs']) * 1000, 'dur': e['delayMs'] * 1000, 'pid': 1, 'tid': 2})
for r in cpu:
    trace.append({'name': 'App process tree', 'ph': 'C', 'ts': r['ms'] * 1000, 'pid': 1,
                  'args': {'CPU core equivalents': r['cores'], 'Working set GiB': r['gib']}})
(root / 'trace.json').write_text(json.dumps({'traceEvents': trace}))

data = json.dumps({'summary': summary, 'cpu': cpu, 'heartbeats': heartbeats})
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>HiDock startup performance</title>
<style>body{font:15px system-ui;background:#10171e;color:#e3ecf4;margin:32px;max-width:1400px}h1{font-size:27px}p{color:#bac8d6;line-height:1.5}button{background:#21313e;color:white;padding:8px;border:1px solid #607485;border-radius:5px}svg{width:100%;background:#16212b;border-radius:8px}text{fill:#d1deea;font:12px system-ui}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{text-align:left;border-bottom:1px solid #33414d;padding:9px}.cards{display:flex;gap:30px;flex-wrap:wrap;margin:25px 0}.cards b{display:block;font-size:26px;color:#75e1cf}.cards span{font-size:13px;color:#a7bac9}a{color:#75e1cf}</style>
<h1>HiDock startup: measured critical path</h1>
<p>Real Electron build, production-sized SQLite snapshot, existing model assets and vector cache. Six logical CPUs / below-normal priority. USB, paid transcription, connector sync and calendar network sync excluded; audio and wiki directories isolated. Local CPU search is measured when shown below. Unrestricted sync, transcription and GPU acceleration are not reproduced.</p>
<div class="cards" id="cards"></div><button id="toggle">Show startup only</button>
<p>Bars: task wall time (including asynchronous I/O). Red: main heartbeat late by more than 100 ms. Hover for measured duration. Gaps are deliberate scheduler delays, not CPU work.</p>
<svg id="waterfall" role="img" aria-label="Measured boot task waterfall"></svg>
<h2>CPU and memory through the run</h2><svg id="resources" role="img" aria-label="CPU and process working set over time"></svg>
<p>CPU is measured in logical-core equivalents (1 = one logical CPU fully occupied). Memory is summed process working set; shared pages may be counted more than once. Heartbeat lateness is sampled every 250 ms, not an exact blocking-stack duration.</p>
<h2>V8 sampled self time</h2><p>Native work is attributed to its calling frame. Idle and garbage collection are shown explicitly. The CPU profile can be opened in DevTools; trace.json contains the waterfall and counters.</p><table id="hot"></table>
<p><a href="trace.json">Chrome trace</a> · <a href="main.cpuprofile">V8 CPU profile</a> · <a href="summary.json">Measured summary</a></p>
<script>const data=DATA;const s=data.summary;let full=true;const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;');
document.getElementById('cards').innerHTML=[['Window',s.windowMs/1000,'s'],['Boot settled',s.bootSettledMs/1000,'s'],['Main loop worst delay',s.maxMainDelayMs,'ms'],['Renderer worst delay',s.maxRendererDelayMs,'ms'],['Peak app working set',s.peakTreeGiB,'GiB']].map(([n,v,u])=>`<div><b>${v.toFixed(2)} ${u}</b><span>${n}</span></div>`).join('');
function draw(){const end=full?s.elapsedSeconds*1000:s.bootSettledMs+1000;const W=1200,L=240,R=30;const x=t=>L+t/end*(W-L-R);let out='';const H=70+s.spans.length*38;
for(let i=0;i<=10;i++){const xx=x(end*i/10);out+=`<path d="M${xx} 25V${H}" stroke="#30404f"/><text x="${xx}" y="18">${(end*i/10000).toFixed(1)}s</text>`}
s.spans.forEach((r,i)=>{const y=40+i*38;out+=`<text x="10" y="${y+17}">${esc(r.name)}</text><rect x="${x(r.start)}" y="${y}" width="${Math.max(2,x(r.start+r.duration)-x(r.start))}" height="24" rx="3" fill="#40b9a8"><title>${esc(r.name)}: ${r.duration} ms; start ${(r.start/1000).toFixed(3)} s</title></rect>`});
data.heartbeats.filter(h=>h.delayMs>100&&h.ms<end).forEach(h=>{out+=`<rect x="${x(h.ms-h.delayMs)}" y="${H-20}" width="${Math.max(2,(h.delayMs/end)*(W-L-R))}" height="10" fill="#fa7769"><title>Heartbeat delay ${h.delayMs.toFixed(1)} ms at ${(h.ms/1000).toFixed(2)} s</title></rect>`});
const svg=document.getElementById('waterfall');svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=out;
let res='';[['cores',6,'CPU core equivalents','#77c9ff'],['gib',Math.max(2,Math.ceil(s.peakTreeGiB)),'Working set GiB','#dfb8ff']].forEach(([key,max,label,color],i)=>{const top=i*140+30;res+=`<text x="10" y="${top+35}">${label}</text><text x="10" y="${top+55}">0 — ${max}</text>`;const points=data.cpu.filter(p=>p.ms<end).map(p=>`${x(p.ms)},${top+100-p[key]/max*90}`).join(' ');res+=`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`});const chart=document.getElementById('resources');chart.setAttribute('viewBox','0 0 1200 290');chart.innerHTML=res;}
document.getElementById('toggle').onclick=()=>{full=!full;document.getElementById('toggle').textContent=full?'Show startup only':'Show full observation';draw()};
document.getElementById('hot').innerHTML='<tr><th>Frame</th><th>File / line</th><th>Sampled self time</th></tr>'+s.cpuSelfSamples.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.file)}:${r.line}</td><td>${r.sampledMs} ms</td></tr>`).join('');draw();</script></html>'''
(root / 'report.html').write_text(page.replace('DATA', data), encoding='utf-8')
print(json.dumps(summary, indent=2))
