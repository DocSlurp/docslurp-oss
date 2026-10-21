"""Reference-only scoring; never imported by inference adapters.

One-to-one matching greedily selects the globally highest class-aware IoU pair.
These fixed-confidence F1 scores are not COCO mAP. Unsupported classes count as
misses in all-class results and are explicitly excluded in supported-only scores.
"""
from collections import defaultdict

CANONICAL_LABELS = ('paragraph','title','list','table','chart','photo','logo','formula',
                    'caption','header','footer','form','mind_map','illustration')


def iou(a, b):
    intersection = max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area = lambda r: max(0,r[2]-r[0])*max(0,r[3]-r[1])
    union = area(a)+area(b)-intersection
    return intersection/union if union else 0.


def match_boxes(truth, predicted, threshold=.5, class_aware=True):
    candidates = sorted(((iou(t['bbox'],p['bbox']),ti,pi) for ti,t in enumerate(truth)
                         for pi,p in enumerate(predicted) if not class_aware or t['label']==p['label']),reverse=True)
    used_t,used_p,matches=set(),set(),[]
    for overlap,ti,pi in candidates:
        if overlap < threshold: break
        if ti not in used_t and pi not in used_p:
            used_t.add(ti); used_p.add(pi); matches.append((ti,pi,overlap))
    return matches


def metrics(tp,fp,fn):
    return dict(tp=tp,fp=fp,fn=fn,precision=tp/(tp+fp) if tp+fp else None,
                recall=tp/(tp+fn) if tp+fn else None,f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None)


def score_pages(pages,supported_labels):
    output={'matching':'greedy-global-descending-iou-class-aware','supported_labels':sorted(supported_labels),
            'unsupported_labels':sorted(set(CANONICAL_LABELS)-set(supported_labels))}
    for threshold in (.5,.75):
        counts=defaultdict(lambda:[0,0,0]); boundary=[]; overlaps=[]; agnostic=[0,0,0]
        order_good=order_pairs=0
        for page in pages:
            truth,predicted=page['truth'],page['regions']
            pairs=match_boxes(truth,predicted,threshold)
            matched_t,matched_p={x[0] for x in pairs},{x[1] for x in pairs}
            for ti,pi,overlap in pairs:
                counts[truth[ti]['label']][0]+=1; overlaps.append(overlap)
                boundary.append(sum(abs(x-y) for x,y in zip(truth[ti]['bbox'],predicted[pi]['bbox']))/4)
            for ti,t in enumerate(truth):
                if ti not in matched_t: counts[t['label']][2]+=1
            for pi,p in enumerate(predicted):
                if pi not in matched_p: counts[p['label']][1]+=1
            matches=match_boxes(truth,predicted,threshold,class_aware=False)
            for index,value in enumerate((len(matches),len(predicted)-len(matches),len(truth)-len(matches))): agnostic[index]+=value
            ordered=[(truth[ti].get('reading_order'),predicted[pi].get('reading_order')) for ti,pi,_ in pairs]
            ordered=[(a,b) for a,b in ordered if a is not None and b is not None]
            for index,(a,b) in enumerate(ordered):
                for c,d in ordered[index+1:]:
                    if a!=c and b!=d:
                        order_pairs+=1; order_good+=(a-c)*(b-d)>0
        totals=[sum(v[index] for v in counts.values()) for index in range(3)]
        supported=[sum(v[index] for label,v in counts.items() if label in supported_labels) for index in range(3)]
        output[f'iou{int(threshold*100)}']={'all_classes':metrics(*totals),'supported_only':metrics(*supported),
            'class_agnostic_localization':metrics(*agnostic),
            'per_class':{label:dict(metrics(*counts[label]),supported=label in supported_labels) for label in sorted(counts)},
            'matched_mean_iou':sum(overlaps)/len(overlaps) if overlaps else None,
            'matched_mean_boundary_error_normalized':sum(boundary)/len(boundary) if boundary else None,
            'reading_order_pair_accuracy':order_good/order_pairs if order_pairs else None,'reading_order_pairs':order_pairs}
    return output
