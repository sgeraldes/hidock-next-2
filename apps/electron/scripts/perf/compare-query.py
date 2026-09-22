"""Same-snapshot comparison of the old and new cache validation queries."""
import json
from pathlib import Path
import sqlite3
import sys
import time
import psutil

root = Path(sys.argv[1]).resolve()
process = psutil.Process()
process.cpu_affinity(process.cpu_affinity()[:2])
process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
db = sqlite3.connect((root / 'library/data/hidock.db').as_uri() + '?mode=ro', uri=True)
results = []
queries = {
    'previous': '''SELECT embed_provider, embed_dims, COUNT(*) FROM vector_embeddings
      WHERE embed_provider = ? AND embed_dims IS NOT NULL GROUP BY embed_provider, embed_dims''',
    'replacement': 'SELECT COUNT(*) FROM vector_embeddings WHERE embed_provider = ?',
}
for name, query in queries.items():
    plan = list(db.execute('EXPLAIN QUERY PLAN ' + query, ['local-onnx-embed']))
    start = time.monotonic()
    db.set_progress_handler(lambda: int(time.monotonic() - start > 30), 10000)
    rows = list(db.execute(query, ['local-onnx-embed']))
    results.append({'name': name, 'elapsedMs': (time.monotonic() - start) * 1000, 'rows': rows, 'plan': plan})
db.close()
(root / 'query-comparison.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
