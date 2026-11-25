export const dashboardHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>HiDock Model Host monitor</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#090f1a;color:#e5edf6}
body{max-width:1050px;margin:0 auto;padding:32px 24px}h1{font-size:28px;margin:0 0 12px}
h2{font-size:18px;margin:32px 0 12px}p{color:#aab9cc;line-height:1.5}.status{color:#55cda5}
dl{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:24px 0}dt,dd{padding:12px 0;border-bottom:1px solid #293549}
dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #293549;overflow-wrap:anywhere}
th{color:#aab9cc;font-weight:500}td{font-variant-numeric:tabular-nums}#jobs{overflow-x:auto}
@media(max-width:600px){body{padding:20px 16px}table{min-width:600px}}
</style><body><h1>HiDock Model Host</h1><p id="state" role="status">Connecting to this host…</p>
<p>Current consumption is for the whole host. Job history is for this service session.</p>
<dl id="metrics"></dl><h2>Active and recent work</h2><div id="jobs"></div>
<p>Voice separation has no generated-token count. Unknown metrics stay unavailable.</p>
<script src="/dashboard.js"></script></body></html>`

export const dashboardScript = `
const state = document.getElementById('state'), metrics = document.getElementById('metrics');
const format = (n, unit) => Number.isFinite(n) ? n.toFixed(1) + unit : 'Unavailable';
const mibToDecimalGb = (value) => Number.isFinite(value) ? value * 1048576 / 1000000000 : value;
function render(data) {
 state.textContent = data.hostname + ' · ' + (data.activeJobs.length ? 'Working' : data.hostState) +
   ' · measured ' + new Date(data.sampledAt).toLocaleTimeString();
 state.className = 'status'; metrics.replaceChildren();
 const values = [
  ['CPU · all ' + data.logicalCores + ' logical cores', format(data.cpuPercent, '%')],
  ['Host RAM', format(mibToDecimalGb(data.memoryUsedMiB), ' GB') + ' / ' + format(mibToDecimalGb(data.memoryTotalMiB), ' GB')],
  ['Service RAM · excludes model workers', format(mibToDecimalGb(data.serviceRssMiB), ' GB')],
  ['GPU', data.gpu?.name || 'Unavailable'], ['GPU use', format(data.gpu?.utilizationPercent, '%')],
  ['GPU memory', format(mibToDecimalGb(data.gpu?.usedMiB), ' GB') + ' / ' + format(mibToDecimalGb(data.gpu?.totalMiB), ' GB')],
  ['GPU measured', data.gpuSampledAt ? new Date(data.gpuSampledAt).toLocaleTimeString() : 'Unavailable'],
  ['Completed jobs', String(data.completedJobs)], ['Total job wall time', format(data.totalJobMs / 1000, ' s')],
  ['Reported output tokens · measured jobs only', format(data.tokens, '')],
  ['Token coverage · completed jobs reporting usage', String(data.tokenMeasuredJobs ?? 0) + ' / ' + String(data.completedJobs)],
  ['Output rate · measured job wall-time average', format(data.outputTokensPerSecondAverage, ' tk/s')]
 ];
 for (const [label, value] of values) { const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value; metrics.append(dt, dd); }
 const container = document.getElementById('jobs'); container.replaceChildren();
 const jobs = [...data.activeJobs, ...data.recentJobs];
 if (!jobs.length) { container.textContent = 'No work has arrived in this service session.'; return; }
 const table = document.createElement('table'), head = document.createElement('tr');
 for (const label of ['Stage / model', 'Recording / job', 'Status', 'Device', 'Elapsed', 'Output tokens', 'Average tk/s']) {
  const th = document.createElement('th'); th.textContent = label; head.append(th); }
 table.append(head);
 for (const job of jobs) { const tr = document.createElement('tr');
  for (const value of [job.stage + ' · ' + job.model, job.recordingId || job.hostJobId || job.id, job.status,
    job.device || 'Awaiting result', format(job.elapsedMs / 1000, ' s'),
    format(job.outputTokens, ''), format(job.outputTokensPerSecondAverage, '')]) {
   const td = document.createElement('td'); td.textContent = value; tr.append(td); }
  table.append(tr); }
 container.append(table);
}
async function tick() {
 try { const response = await fetch('/telemetry', {signal:AbortSignal.timeout(3000),cache:'no-store'});
  if (!response.ok) throw Error('Host unavailable'); render(await response.json()); }
 catch { state.textContent = 'No current measurement · host not responding. Last values may be stale.';
  state.className = ''; }
 setTimeout(tick, 5000);
}
tick();`

