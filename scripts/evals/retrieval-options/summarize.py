"""Summarize completed campaign receipts without network access."""
import argparse, collections, json, statistics
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=Path(a.directory)
r=json.loads((root/'live.json').read_text()); d=json.loads((root/'diagnostics.json').read_text())
events=collections.defaultdict(list)
for e in d['events']: events[e['metadata']['sessionId']].append(e)
rows=[]; baseline={x['query']:x for x in r['results'] if x['arm']=='baseline'}
for arm in dict.fromkeys(x['arm'] for x in r['results']):
 hits=[x for x in r['results'] if x['arm']==arm]; es=[e for x in hits for e in events[x.get('body',{}).get('sessionId')]]
 lat=sorted(x['ms'] for x in hits if 'ms' in x)
 rows.append(dict(arm=arm,total=len(hits),complete=sum(x['status']=='completed' for x in hits),correct=sum(bool(x.get('judge',{}).get('correct')) for x in hits),mrr=sum(1/x['judge']['rank'] if x.get('judge',{}).get('rank') else 0 for x in hits)/len(hits),medianMs=statistics.median(lat),p95Ms=lat[min(len(lat)-1,int(len(lat)*.95))],customerUsd=sum(float(e['cost_cents'])/100 for e in es),providerUsd=sum(float(e['metadata'].get('providerCostCents',0))/100 for e in es),events=len(es),improved=[x['query'] for x in hits if x.get('judge',{}).get('correct') and not baseline[x['query']].get('judge',{}).get('correct')],regressed=[x['query'] for x in hits if not x.get('judge',{}).get('correct') and baseline[x['query']].get('judge',{}).get('correct')]))
(root/'summary.json').write_text(json.dumps(rows,indent=2)+'\n')
lines=['# Retrieval controls: production development pilot','',f"Status: {r['status']}; {len(r['results'])} searches. All questions were previously exposed. These are evidence-retrieval checks, not generated-answer accuracy. Exact session attribution excludes concurrent workspace activity.",'','| Arm | Correct | MRR | Median / p95 seconds | Customer USD | Provider USD |','|---|---:|---:|---:|---:|---:|']
for x in rows: lines.append(f"| {x['arm']} | {x['correct']}/{x['total']} | {x['mrr']:.3f} | {x['medianMs']/1000:.2f} / {x['p95Ms']/1000:.2f} | {x['customerUsd']:.8f} | {x['providerUsd']:.8f} |")
lines+=['',f"Exact session-attributed totals: customer ${sum(x['customerUsd'] for x in rows):.9f}; provider ${sum(x['providerUsd'] for x in rows):.9f}. Provider values come from recorded usage metadata, not independently reconciled invoices. Short questions and cached embeddings make this an optimistic cost sample.",'','## Query flips','']
for x in rows:
 if x['improved'] or x['regressed']: lines.append(f"- {x['arm']}: recovered {', '.join(x['improved']) or 'none'}; regressed {', '.join(x['regressed']) or 'none'}.")
lines+=['','## Limits','', 'One invocation per query/arm, fixed arm execution order, no randomized repeats. Model-backed output can vary and cache/warmth can affect latency. Shared production traffic can influence timing. Graph/community flags were exercised against pipelines without graph capabilities, so they do not test actual graph retrieval. Persisted diagnostics are in diagnostics.json; request flags and response usage are in live.json. The deployed service predates the local MMR and hybrid-search fixes. No production defaults changed.']
(root/'summary.md').write_text('\n'.join(lines)+'\n');print('\n'.join(lines[:25]))
