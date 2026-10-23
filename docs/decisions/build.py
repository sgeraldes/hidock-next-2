"""Builds index.html, the decision matrix, from decisions.json. Run from this folder:  python build.py

The weighted totals are computed here, so the page cannot disagree with its own scores. A decision whose chosen
option does not have the highest total must say why (tie, provisional); otherwise the build fails.
"""
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def esc(v):
    return html.escape(str(v), quote=True)


def main():
    with open(os.path.join(HERE, 'decisions.json'), encoding='utf-8') as fh:
        data = json.load(fh)
    weights = [c['weight'] for c in data['criteria']]
    problems = []
    cards = []
    counts = {'alta': 0, 'media': 0, 'baja': 0}

    head = ''.join(f'<th title="{esc(c["hint"])}">{esc(c["label"])}<br><small>peso {c["weight"]}</small></th>' for c in data['criteria'])
    for d in data['decisions']:
        totals = [sum(s * w for s, w in zip(o['scores'], weights)) for o in d['options']]
        best = max(totals)
        chosen = d['choice']
        if totals[chosen] != best and not (d.get('provisional') or d.get('override')):
            problems.append(f'{d["id"]}: la opción elegida suma {totals[chosen]} y la mejor suma {best}; falta "override" con su razón')
        if totals.count(best) > 1 and totals[chosen] == best and not d.get('tie'):
            problems.append(f'{d["id"]}: empate en {best} sin marcar "tie"')
        counts[d['confidence']] += 1
        rows = []
        for i, o in enumerate(d['options']):
            cells = ''.join(f'<td class="n">{s}</td>' for s in o['scores'])
            cls = 'chosen' if i == chosen else ''
            mark = ' <span class="tag">elegida</span>' if i == chosen else ''
            if i == chosen and d.get('provisional'):
                mark = ' <span class="tag prov">provisoria</span>'
            rows.append(f'<tr class="{cls}"><th scope="row">{esc(o["name"])}{mark}</th>{cells}<td class="n total">{totals[i]}</td></tr>')
        ask = ' <span class="tag ask">se pregunta al dueño</span>' if d['confidence'] == 'baja' else ''
        if d.get('answered'):
            ask = f' <span class="tag">{esc(d["answered"])}</span>'
        cards.append(
            f'<section class="dec" id="d{esc(d["id"])}"><header><span class="id">{esc(d["id"])}</span><span class="spec">{esc(d["spec"])}</span>'
            f'<span class="conf c-{esc(d["confidence"])}">confianza {esc(d["confidence"])}</span>{ask}</header>'
            f'<h2>{esc(d["question"])}</h2>'
            f'<div class="tbl"><table><thead><tr><th>Opción</th>{head}<th>Total</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
            f'<p class="why">{esc(d["why"])}</p></section>'
        )
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        return 1

    crit = ''.join(f'<li><b>{esc(c["label"])}</b>, peso {c["weight"]}. {esc(c["hint"])}</li>' for c in data['criteria'])
    summary = f'{len(data["decisions"])} decisiones: confianza alta {counts["alta"]}, media {counts["media"]}, baja {counts["baja"]}.'
    page = TEMPLATE.format(title=esc(data['title']), date=esc(data['date']), intro=esc(data['intro']), crit=crit, summary=esc(summary), body=''.join(cards))
    out = os.path.join(HERE, 'index.html')
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(page)
    print(f'wrote {out}: {summary}')
    return 0


TEMPLATE = """<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg: #f4f3ef; --surface: #ffffff; --fg: #1d1f1c; --muted: #5c615a; --line: #d9d8d0; --accent: #234e73;
  --ok: #1f6b45; --ok-bg: #e0f0e7; --warn: #8a5a0f; --warn-bg: #f7ecd4; --bad: #a3282a; --bad-bg: #f8e1e1; --pick: #e8eff6;
  --mono: ui-monospace, "Cascadia Mono", Consolas, monospace; --sans: "Segoe UI", system-ui, sans-serif;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #151714; --surface: #1d201c; --fg: #e6e8e3; --muted: #9ba197; --line: #31352f; --accent: #8bb6dc;
  --ok: #7cc79c; --ok-bg: #1b3326; --warn: #e1b564; --warn-bg: #352b16; --bad: #f08a8c; --bad-bg: #3a1d1e; --pick: #1f2b38; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --bg: #151714; --surface: #1d201c; --fg: #e6e8e3; --muted: #9ba197; --line: #31352f; --accent: #8bb6dc;
  --ok: #7cc79c; --ok-bg: #1b3326; --warn: #e1b564; --warn-bg: #352b16; --bad: #f08a8c; --bad-bg: #3a1d1e; --pick: #1f2b38; color-scheme: dark }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); }}
.wrap {{ max-width: 62rem; margin: 0 auto; padding-inline: 16px; padding-block: 2rem 4rem; display: grid; gap: 1.4rem; }}
h1 {{ font-size: 1.7rem; margin: 0; }} h2 {{ font-size: 1.05rem; margin: .2rem 0 .5rem; }}
.sub {{ color: var(--muted); max-width: 72ch; margin: .3rem 0 0; }}
ul.crit {{ margin: 0; padding-left: 1.1rem; display: grid; gap: .25rem; max-width: 75ch; }}
.dec {{ background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem; min-width: 0; }}
.dec header {{ display: flex; flex-wrap: wrap; gap: .5rem .7rem; align-items: center; font-size: .8rem; }}
.id {{ font: .78rem var(--mono); color: var(--muted); }} .spec {{ color: var(--muted); }}
.conf, .tag {{ font: 600 .7rem var(--sans); text-transform: uppercase; letter-spacing: .05em; padding: .1rem .5rem; border-radius: 999px; }}
.c-alta {{ background: var(--ok-bg); color: var(--ok); }} .c-media {{ background: var(--warn-bg); color: var(--warn); }} .c-baja {{ background: var(--bad-bg); color: var(--bad); }}
.tag {{ background: var(--pick); color: var(--accent); }} .tag.prov {{ background: var(--warn-bg); color: var(--warn); }} .tag.ask {{ background: var(--bad-bg); color: var(--bad); }}
.tbl {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; min-width: 40rem; font-size: .88rem; }}
th, td {{ border-bottom: 1px solid var(--line); padding: .4rem .55rem; text-align: left; vertical-align: top; }}
thead th {{ font-size: .74rem; color: var(--muted); font-weight: 600; text-align: center; }} thead th:first-child {{ text-align: left; }}
thead small {{ font-weight: 400; }} td.n {{ text-align: center; font-variant-numeric: tabular-nums; }} td.total {{ font-weight: 700; }}
tr.chosen {{ background: var(--pick); }}
.why {{ margin: .6rem 0 0; max-width: 78ch; }}
footer {{ color: var(--muted); font-size: .8rem; }}
</style>
</head>
<body>
<div class="wrap">
  <header><h1>{title}</h1><p class="sub">{date}. {intro}</p></header>
  <section><h2>Criterios y pesos</h2><ul class="crit">{crit}</ul><p class="sub">{summary}</p></section>
  {body}
  <footer>Generado con build.py desde decisions.json. Los totales son la suma de puntaje por peso.</footer>
</div>
</body>
</html>
"""

if __name__ == '__main__':
    sys.exit(main())
