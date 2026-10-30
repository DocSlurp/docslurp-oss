"""Package read-only Round 1 evidence; never changes or reexports native candidates."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import html
import json
import shutil

OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1')
ROOT=Path(__file__).resolve().parent

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    now=datetime.now(timezone.utc).isoformat()
    inspection=json.loads((OUT/'actual-original-inspection.json').read_text())
    freeze=json.loads((OUT/'FREEZE.json').read_text())
    assert all(sha(OUT/n)==h for n,h in freeze['files'].items())
    objects=[]
    for before_path in sorted(OUT.glob('*.readback-before.json')):
        before=json.loads(before_path.read_text());after_path=OUT/before_path.name.replace('before','reloaded')
        after=json.loads(after_path.read_text());a={r['identity']:r for r in before['objects']};b={r['identity']:r for r in after['objects']}
        changed=[{'id':id,'before':a[id]['properties'],'after':b[id]['properties']} for id in a if a[id]['properties']!=b[id]['properties']]
        objects.append({'document':before_path.name.removesuffix('.readback-before.json'),'stableIdsBeforeAndAfter':set(a)==set(b),
                        'allActualPageAnchorsOne':all(o['properties']['AnchorPageNo']==1 for o in b.values()),
                        'actualObjectCount':len(b),'parentLookupUnresolvedCount':sum(isinstance(o['parent'],dict) for o in b.values()),
                        'realizedZOrderChanges':[{'id':r['id'],'before':r['before']['ZOrder'],'after':r['after']['ZOrder']} for r in changed if r['before']['ZOrder']!=r['after']['ZOrder']],
                        'allPropertyChanges':changed,'status':'unresolved parent proxy lookups and changed realized properties retained; no body fallback',
                        'persistedEvidence':'actual-original-inspection.json contains XML page anchors and object/table containment'})
    findings=[
        {'id':'R1-WRITER-PAINT','severity':'substantive','families':[10,16],
         'finding':'White native frame fills interrupt the genuine fraction rules. At 300 DPI the expected horizontal rule probe finds dark ink in 22/46 E1 columns and 225/406 E2 columns; the corresponding ReportLab probes find 45/46 and 405/406. Endpoint antialiasing affects one ReportLab column. Complete mathematical stroke conservation is not established.',
         'evidence':['fraction-stroke-visibility.json','evidence-inspection2/f0010-E1-B-p01-writer-original-technical-300.png','evidence-inspection2/f0016-E2-C-p01-writer-original-technical-300.png']},
        {'id':'R1-WRITER-DUPLICATES','severity':'substantive','families':[10,2],
         'finding':'Untouched Writer output repeats the Elapsed | header in E1 and Nominal | header in E3, eight meaningful glyph operations each, at identical origins. Raw operations, native text traces and effective clip descriptions remain intact. No deduplication or stream rewrite was performed.',
         'evidence':['actual-original-inspection.json','evidence-inspection2/f0010-E1-B-p01-writer-original.texttrace.json','evidence-inspection2/f0002-E3-A-p01-writer-original.texttrace.json']},
        {'id':'R1-WRITER-FRAMES','severity':'substantive','families':[10,16,2],
         'finding':'Original Writer pages paint white rectangular text-frame fills inside the blue-gray discussion panels. These fills also contribute to fraction-rule occlusion. The panel is visually fragmented.',
         'evidence':['evidence-inspection2/']},
        {'id':'R1-E1-EDITORIAL','severity':'substantive','families':[10],
         'finding':'The commentary says a dry vessel weakens a collection-loss explanation. Initial dryness addresses residual liquid or a starting tare, but does not demonstrate absence of collection loss. The outlet-coupling observation is relevant to leakage, but the written causal link assigns the inference to the wrong evidence. It needs deliberate revision in a later authorized round.',
         'evidence':['f0010-E1-B-p01.exact-authoring.json','evidence-inspection2/f0010-E1-B-p01-reportlab-original-discussion-300.png']},
        {'id':'R1-E1-QUALIFICATION','severity':'review required','families':[10],
         'finding':'The sentence excluding falling level from between-trial differences relies only on equal initial head. No time-resolved head record is supplied. The causal exclusion should be qualified or supported in a later round.',
         'evidence':['f0010-E1-B-p01.exact-authoring.json']},
        {'id':'R1-WRITER-READBACK','severity':'unresolved','families':[10,16,2],
         'finding':'Actual object names and page anchors survive ODT reload, and XML confirms the native table owner frames and exact cells/spans. UNO Anchor.Text lookups are unresolved for every page-anchored object. Several realized heights and E3 ZOrder values differ across persistence; the record does not assume requested order or proxy ownership succeeded.',
         'evidence':['writer-persistence-reconciliation.json','actual-original-inspection.json']},
        {'id':'R1-GLYPH-DIAGNOSTICS','severity':'diagnostic','families':[10,16,2],
         'finding':'The inspector additionally applies IoU >=0.70 to individual glyph ink boxes. It records 77/52/71 Writer glyph diagnostics for E1/E2/E3, mostly thin glyphs affected by small native advance quantization. This is a stricter diagnostic than paragraph/cell support IoU: all measured text-block/cell aggregates exceed 0.95. These diagnostic counts are not substituted for the definite paint and duplicate-operation defects.',
         'evidence':['actual-original-inspection.json']},
    ]
    (OUT/'writer-persistence-reconciliation.json').write_text(json.dumps({'observedAtUtc':now,'documents':objects},indent=2)+'\n')
    (OUT/'editorial-and-native-findings.json').write_text(json.dumps({'observedAtUtc':now,'reviewer':'source-blind Builder self-review; not independent adjudication',
        'actualPagesRead':['all six full pages at 150 DPI','Writer E1/E2 technical crops at 300 DPI','Writer E3 chart at 300 DPI'],
        'strongest':'f0002 E3-A ReportLab: conversion model and hold residuals support a clear, appropriately limited handover decision.',
        'weakest':'f0010 E1-B, especially Writer: incorrect dry-vessel inference plus broken fraction ink and duplicated native header operations.',
        'findings':findings},indent=2)+'\n')
    files=[]
    lines=['# Attempt 7 — formal Round 1 handoff','',f'Prepared {now}.',
           '', 'Six one-page native previews and three editable Writer ODTs are delivered. These are partial diagnostic documents. No score, fixture acceptance, pilot or complete ten-page conformance is claimed.',
           '', '**Stop point:** Round 1 is preserved for coordinator review. No candidate correction, stream permutation, transform, bulk family export or Round 2 was run.',
           '', '| Family / page | ReportLab original | Writer original | Editable Writer |', '|---|---|---|---|']
    family_order=[(10,'E1','B'),(16,'E2','C'),(2,'E3','A')]
    cards=[]
    for fid,cls,layout in family_order:
        stem=f'f{fid:04d}-{cls}-{layout}-p01'
        rp=stem+'-reportlab-original.pdf';wp=stem+'-writer-original.pdf';odt=stem+'-writer-original.odt'
        lines.append(f'| f{fid:04d} / {cls}-{layout} / page 1 | [PDF]({rp}) | [PDF]({wp}) | [ODT]({odt}) |')
        for producer,label in [('reportlab','ReportLab original'),('writer','Writer original')]:
            result=next(r for r in inspection['pdfs'] if Path(r['pdf']).name==stem+'-'+producer+'-original.pdf')
            glyph=f"{result['actualMeaningfulGlyphs']} native / {result['expectedMeaningfulGlyphs']} expected meaningful glyphs"
            image=str(OUT/'evidence-inspection2'/(stem+'-'+producer+'-original-full-150.png'))
            detail=str(OUT/'evidence-inspection2'/(stem+'-'+producer+'-original-technical-300.png'))
            cards.append(f'<article><h3>f{fid:04d} · {cls}-{layout} · {label}</h3><p>{html.escape(glyph)}</p><a href="{html.escape(str(OUT/(rp if producer=="reportlab" else wp)))}"><img alt="Actual {cls}-{layout} {label} full page" src="{html.escape(image)}"></a><details><summary>Readable technical close-up · 300 DPI</summary><img alt="Actual technical close-up" src="{html.escape(detail)}"></details></article>')
    lines.extend(['','The untouched Writer exports have unresolved substantive defects. E1/E3 duplicate eight meaningful header glyph operations; E1/E2 fraction bars are interrupted; all Writer discussion panels have white frame fills. Native editable cell counts are 20, 31 and 20, with the E2 B1:C1 span retained.',
                  '', '**Strongest:** f0002/E3-A ReportLab. **Weakest:** f0010/E1-B, particularly Writer. E1 also contains an unsupported inference from initial vessel dryness and an overly strong head-related exclusion.',
                  '', '## Authorship and frozen inputs','',
                  '- [Purposes and ten-page outlines](outlines.md)',
                  '- [Frozen code/literal/support hash inventory](FREEZE.json)',
                  '- [Runtime, package trees, font and source-hash receipt](runtime-source-receipt.json)',
                  '- [Literal metric checks](literal-metric-validation.json)',
                  '- [All-row exact semantic recomputation and executed mutation controls](pre-export-semantic-validation.json)',
                  '- [Novelty token arrays, all pair statistics and retained review-flag population](intra-candidate-novelty.json)',
                  '- [Self-review and substantive findings](editorial-and-native-findings.json)',
                  '- [Original PDF/ODT inspection](actual-original-inspection.json)',
                  '- [Actual persistence comparison, including unresolved fields](writer-persistence-reconciliation.json)',
                  '- [Fraction stroke raster probes](fraction-stroke-visibility.json)',
                  '- [Actual rendered pages, prose/table/formula/chart close-ups and raw traces](evidence-inspection2/)',
                  '- [Separate noncandidate setup, failed controls and pre-freeze records](mechanism-setup/)',
                  '- [Read-only inspection failure and corrected-inspector receipt](inspection-v1-failure.json)',
                  '', 'Each family prefix has `.world.json`, `.exact-authoring.json`, `.drawing-plan.json`, `.support.json` and `.execution.json`. Exact tables, source decimal lexemes, formula/interval ASTs, units, scopes, line breaks, glyph IDs, font hashes and expected ink were frozen before candidate export.',
                  '', '## Checks and limits','',
                  'All eleven handoff hashes and all 32 installed package versions/tree hashes match. Both pinned font identities and runtime executable hashes match. There were no downloads, model calls, remote workers, nested agents or Git mutations. Writer used isolated sequential profiles; no more than one Writer workload ran at once.',
                  '', 'All six originals contain one US-letter page and report PDF 1.7. The ReportLab meaningful-glyph multisets match exactly (1258 E3, 1532 E1, 1215 E2). Native fonts, glyph origins, supports, raw paints and 300 DPI ink-box probes were inspected. This does not certify complete glyph masks or every clip path. Native trace duplication was never removed to make counts agree.',
                  '', 'Actual ODT XML confirms all semantic cell literals and native spans, and actual names/page anchors were compared before/after reload. Unavailable Layer/Size/Anchor properties and changed realized state are preserved explicitly. No successful proxy-parent lookup is invented.',
                  '', 'Novelty review currently covers the three authorized authored pages, not the unwritten remainder of the outlines. It found no shared-eight-token or >0.35 substantive fivegram flags; token arrays and every pair statistic are retained. That result does not establish semantic originality or clear future ten-page diversity.',
                  '', 'Only the five reported semantic mutation controls and the separately recorded helper/native controls were executed. Identifier/synonym-only rewrites, generic filler, misleading-header, undefined-unit, dimensionally wrong caption, extra-native-operation and missing-glyph negative-control suites remain incomplete. Source-overlap and protected-name tests remain coordinator-owned; this source-blind task did not access a source or denylist.',
                  '', 'All fifteen ten-page families, thirty complete canonical/permuted producer controls, transforms, downstream visibility/leakage gates and independent editorial review remain future work. No acceptance gate is inferred from these previews.',
                  '', '## Resource and failure reconciliation','',
                  'External API/remote-compute spend: $0. Local runtime only. Candidate exports completed 2026-10-27 14:46:35–14:46:42 UTC. Mechanism setup includes two UNO table-name failures, two successful-but-defective font/format controls before correction, and later calibrated controls. All exported control PDFs/ODTs, failures, stdout and stderr remain preserved. The first read-only inspection failed to serialize PyMuPDF Rect objects; a versioned inspector reran unchanged native PDFs into a separate evidence directory.',
                  '', 'Temporary isolated profiles are removed only after durable evidence is saved. Build source remains under `core/worker/test/mixed-pdf-eval/a7/`; the original build code snapshot is preserved in `frozen-code/`.'])
    (OUT/'HANDOFF.md').write_text('\n'.join(lines)+'\n')
    page='''<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;color:var(--foreground,#16202a);font:14px system-ui}h2{font-size:18px;margin:0 0 8px}p{line-height:1.5;margin:6px 0}h3{font-size:13px;margin:8px 0}small{color:var(--muted-foreground,#64707c)}
    .status{background:var(--warning-surface,#fff4d4);padding:16px;border-radius:12px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 12px}article{min-width:0}article p{font-size:11px}img{width:100%;height:auto;display:block}a{color:inherit}summary{cursor:pointer;font-size:12px;padding:8px 0}details[open]{grid-column:span 2}footer{margin-top:16px;font-size:12px;line-height:1.6}@media(max-width:500px){.grid{grid-template-columns:1fr}}
    </style></head><body><h2>Attempt 7 · formal Round 1 · frozen originals</h2><small>Actual page renders · native exports 2026-10-27 14:46:35–14:46:42 UTC</small><div class="status"><p>Awaiting coordinator review. Writer originals have duplicate header operations and interrupted fraction rules; all artifacts are preserved.</p><p>Strongest: E3-A ReportLab. Weakest: E1-B Writer; its prose also overstates what a dry collection vessel establishes.</p></div><div class="grid">'''+''.join(cards)+'''</div><footer>Click each page for its original PDF. Expand a technical close-up to inspect real 300 DPI output. These one-page previews do not establish ten-page conformance, a score or fixture acceptance. No revision or second round was run.</footer></body></html>'''
    (OUT/'preview-gallery.html').write_text(page)
    for name in ['inspect_round1_v2.py','handoff.py']:
        shutil.copyfile(ROOT/name,OUT/name.replace('.py','.validation-code.txt'))
    manifest={'attempt':7,'formalRound':1,'preparedAtUtc':now,'status':'delivered for coordinator review; substantive unresolved findings',
              'nativePdfs':[str(p) for p in sorted(OUT.glob('*-original.pdf'))],'editableWriter':[str(p) for p in sorted(OUT.glob('*.odt'))],
              'candidateReexports':0,'streamRewrites':0,'nextRoundStarted':False,'remoteOrModelCostUSD':'0',
              'files':{str(p.relative_to(OUT)):sha(p) for p in sorted(OUT.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'}}
    (OUT/'artifact-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(str(OUT/'HANDOFF.md'))

if __name__=='__main__':main()
