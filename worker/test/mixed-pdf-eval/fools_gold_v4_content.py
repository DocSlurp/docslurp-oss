"""New source-blind ATTEMPT4 writing and deterministic family worlds.

These thirty distinct page narratives were authored solely from the isolated
abstract contract, then edited against its strict word/character/line budgets.
No earlier generator, corpus, preview or external document was consulted.
"""
from decimal import Decimal, ROUND_HALF_UP
import random

# Observation, action, independent evidence, analytical commentary per page.
PROSE = {0: [('Moisture readings narrowed after the exhaust damper opened, although the ceramic trays '
      'still differed across four positions. Inspectors measured 184 to 217 grams during the first '
      'settling window; the central position cooled before its surface stopped releasing vapor.',
      'Retain the slower tray for a second weighing rather than extending every drying interval. '
      'That decision separates thermal delay from persistent absorption, while preserving '
      'comparable exposure histories for the remaining positions under the present ventilation '
      'setting.',
      '"The outlet cleared the haze before the heavy tray settled. We waited for the balance '
      'rather than the air to stop changing; warm drafts still moved inside the enclosure during '
      'the first weighing interval."',
      'Separate settling allowances follow from these readings. A common release time would hide '
      'the slow response and overstate agreement among trays that retain different amounts of '
      'heat.'),
     ('A pale rim appeared where condensate met the tray wall, suggesting that liquid migrated '
      'outward before evaporation became uniform. The second window recorded 193 to 226 grams, but '
      'those measurements cannot distinguish dissolved residue from retained water without another '
      'inspection.',
      'Reserve an untouched edge for microscopy and clean only the center of the test surface. '
      'Recording both locations prevents the cleaning operation from erasing the very boundary '
      'that motivates the proposed explanation of outward transport.',
      '"The deposit lay near the corner away from the inlet. Its edge remained visible after the '
      'fan slowed, so we preserved that area until another inspector could examine the surface '
      'during the second window."',
      'Location carries more evidence than color here. The readings quantify mass, while the '
      'preserved edge independently tests whether liquid moved outward before evaporation became '
      'uniform.'),
     ('Repeated weighing produced a smaller spread than the first transfer, yet the balance '
      'enclosure was opened between readings. Values ranged from 202 to 235 grams; stability '
      'therefore describes this handling sequence rather than uninterrupted operation under a '
      'sealed atmosphere.',
      'State the handling limitation beside the acceptance decision and retain the original '
      'transfer times. A repeat with the enclosure closed should precede any claim that the '
      "observed spread represents the instrument's intrinsic measurement repeatability alone.",
      '"Each tray returned close to its earlier reading, but opening the panel exposed the balance '
      'to room drafts. We exchanged positions between readings and cannot call this a continuous '
      'run inside the sealed enclosure."',
      'Repeatability depends on handling. These mass values support provisional use, but cannot '
      'establish performance with a sealed enclosure or with a different sequence of tray '
      'exchanges.'),
     ('One porous insert remained damp after its neighbors cleared, despite receiving the same '
      'scheduled exposure. The fourth window spanned 211 to 244 grams, with that insert closest to '
      'the outlet; position alone consequently offers an incomplete explanation of drying '
      'behavior.',
      'Quarantine that insert without changing the common ventilation setting. Compare its pore '
      'texture against a dry retained piece before assigning cause, because a material difference '
      'would require a different response from a localized airflow obstruction.',
      '"Nearby pieces cleared while this insert kept a dark center. Nothing moved during weighing '
      'and the outlet stayed open; the delay persisted without any change in equipment during the '
      'fourth observation window."',
      'The exception weakens a position-only explanation. Retained material tests variability, '
      'while the unchanged setup keeps these mass readings comparable within the declared '
      'inspection window.'),
     ('Inspection found a loose seal at the lid, creating a second escape route for moist air '
      'during the fifth window. Recorded masses extended from 220 to 253 grams, so the present '
      'comparison includes both intended exhaust flow and uncontrolled perimeter leakage.',
      'Replace the seal before increasing fan speed, then repeat the same four positions with the '
      'lid latched. Increasing flow first would combine two interventions and make the next '
      'comparison unable to isolate the contribution of leakage.',
      '"A plume escaped beside the latch when the fan paused. The outlet remained open and no tray '
      'touched the lid; we marked the seal position before removing the warm pieces during this '
      'weighing window."',
      'Repair supplies a clean intervention. These readings describe leakage, and a matched repeat '
      'can isolate sealing effects without changing the fan setting at the same time.'),
     ('Faster exhaust did not shorten the settling period for the thickest tray, even though the '
      'enclosure cleared sooner. The sixth window yielded 229 to 262 grams; this counterexample '
      'separates removal of airborne moisture from diffusion through a slowly cooling ceramic '
      'body.',
      'Keep enclosure clearing time and mass stability as separate observations in the next '
      'review. A single completion flag would hide their disagreement and encourage an unsupported '
      'increase in airflow for materials whose limiting process occurs internally.',
      '"Clear air preceded a stable indication by several minutes. The thick tray still felt warm '
      'at its center, so we kept observing instead of treating the disappearance of visible vapor '
      'as the release event."',
      'Clear air is a poor completion proxy. Interpret the readings alongside heat retention, '
      'since thick ceramic can lose mass after visible vapor has already disappeared from the '
      'enclosure.'),
     ('Two operators recorded different completion times because one watched the enclosure and the '
      'other watched the balance. Masses during the seventh window ranged from 238 to 271 grams; '
      'their disagreement concerns the decision rule rather than a contradiction between measured '
      'values.',
      'Reconcile the log using the first stable balance indication as the release event, while '
      'preserving both original observations. This explicit definition allows future timing '
      'comparisons without rewriting the earlier account or discarding evidence of visible '
      'clearing.',
      '"My entry marks the mist clearing; the later entry marks a stable balance. Both occurred '
      'during the same exposure, with no damper adjustment or tray exchange between those events '
      'in this observation window."',
      'A defined event resolves timing without altering mass. Keeping both observations shows that '
      'optical clearing and stable weight describe different stages within the same drying '
      'process.'),
     ('A short shutdown allowed humidity to accumulate before the eighth window, changing the '
      'initial condition while tray positions stayed unchanged. The balance registered 247 to 280 '
      'grams; these measurements should not be pooled with continuous windows without recording '
      'that pause.',
      'Tag the restart window separately and obtain a continuous follow-up before revising the '
      'operating interval. Treating the pause as ordinary variation would obscure whether the '
      'additional retained mass came from interrupted ventilation or a persistent material change.',
      '"The closed chamber grew humid during the stoppage, leaving a film on its wall. After '
      'restarting the fan we weighed sooner than in earlier continuous windows, and retained that '
      'difference in the timing record."',
      'Restart history confounds this comparison. Separate reporting preserves evidence without '
      'mistaking a brief humidity buildup for lasting deterioration in the drying behavior of all '
      'four trays.'),
     ('The revised transfer sequence reduced drafts near the balance without changing exhaust or '
      'tray positions. Ninth-window readings covered 256 to 289 grams, and settling traces became '
      'smoother; however, smoother traces alone cannot demonstrate that all residual water was '
      'removed.',
      'Adopt the quieter transfer method for routine weighing and retain a separate '
      'residual-moisture inspection. The method improves observation conditions, while an '
      'independent inspection addresses the material state that a balance trace cannot reliably '
      'establish by itself.',
      '"We sheltered each tray before closing the balance enclosure. Transfer no longer caused '
      'abrupt jumps, but the thick piece still lost mass slowly after room drafts stopped; '
      'smoother traces did not prove its pores were dry."',
      'Better handling strengthens each reading. It refines the matrix interpretation without '
      'turning smooth indications into proof that moisture has completely left material inside the '
      'tray pores.'),
     ('Final review found no further seal leakage, but the thick tray still needed longer '
      'observation than its neighbors. The tenth window ranged from 265 to 298 grams; handover '
      'distinguishes the repaired enclosure from the unresolved material-dependent delay in '
      'reaching stability.',
      'Transfer the seal inspection record with the weighing procedure and identify the thick tray '
      'explicitly. The receiving operator can preserve the successful repair while testing the '
      'remaining delay, without reopening a settled mechanical diagnosis during operation.',
      '"The latch stayed dry and no fresh deposit appeared at the retained edge. We kept the thick '
      'tray under observation because its reading continued changing after neighboring positions '
      'reached the agreed stability criterion."',
      'Handover separates repair from remaining questions. The matrix describes the sealed '
      'enclosure, while longer observation remains a precaution for the tray that retains more '
      'internal heat.')],
 6: [('Before handover, the gauge was checked at four stops spanning 162 to 195 micrometers. The '
      'return stroke approached from below, while forward travel settled sooner; observations '
      'describe directional behavior rather than a uniform error across the inspected travel span.',
      'Keep approach direction in the service log and establish the reference from the forward '
      'stroke only. Averaging both directions would mask the observed return behavior and could '
      'make a stable reference appear to drift during subsequent mechanical inspection.',
      '"The pointer returned slowly when travel reversed although the stop stayed fixed. We held '
      'each position before recording travel and used one approach speed, keeping direction fixed '
      'throughout this first check window."',
      'An average conceals directional history. Four travel readings remain in the matrix, while '
      'the approach rule makes the reference reproducible for the operator who receives the '
      'gauge.'),
     ('A fine ridge on the guide rail coincided with hesitation during the second window of 171 to '
      '204 micrometers. Motion resumed smoothly beyond that position, suggesting a localized '
      'contact effect rather than a uniform change in sensitivity across inspected travel.',
      'Mark the rail position before cleaning and compare motion across that mark after debris is '
      'removed. This preserves the suspected contact location and tests a specific mechanical '
      'explanation without prematurely changing the reference adjustment of the inspected gauge.',
      '"Resistance rose only at the marked rail section. Travel remained free on both sides and '
      'the stop stayed firm; preserving that mark lets us compare the same position after cleaning '
      'during the next inspection."',
      'Local testing sharpens diagnosis. Travel supplies the comparison scale, while hesitation '
      'identifies a position where another observation can challenge the proposed contact '
      'explanation.'),
     ('The gauge repeated its forward indication after cleaning, but inspection covered only '
      'central travel. Third-window values ranged from 180 to 213 micrometers; agreement within '
      "this span cannot establish linear response at either endpoint of the instrument's full "
      'operating range.',
      'Release the gauge for the inspected span and attach a range restriction to the handover. '
      'Endpoint checks remain open work, since broader approval would claim evidence that the four '
      'middle positions cannot provide in this particular inspection review.',
      '"The four stops occupied central travel, not the endpoints. Cleaning removed hesitation in '
      'that span, but the fixture could not reach either limit; we left those positions untested '
      'instead of inferring their indications."',
      'The restriction follows central evidence. Consistent readings support limited use, but '
      'cannot establish endpoint behavior or transform an untested position into an actual '
      'measured observation.'),
     ('A return indication rose when the cable loop brushed the carriage during the fourth window '
      'of 189 to 222 micrometers. Forward readings remained orderly; the exception suggests '
      'external loading that should be checked before assigning the event to internal wear.',
      'Restrain the cable outside the travel envelope and repeat the affected direction before '
      'opening the housing. This tests contact directly without adding a new disturbance to an '
      'instrument whose forward response remains consistent during the present mechanical checks.',
      '"The loop brushed the bracket before the pointer rose, then relaxed at rest. We recorded '
      'the cable route with the carriage stationary rather than moving it during the affected '
      'reading in the fourth inspection window."',
      'Cable contact offers an external cause. Keeping forward readings untouched separates that '
      'unusual load from general drift and provides a comparison when the return stroke is '
      'repeated.'),
     ('After cable restraint, both strokes settled without the abrupt rise, although a return lag '
      'persisted. Fifth-window travel measured 198 to 231 micrometers; removing contact resolves '
      'the excursion while leaving a separate gradual response that still requires timing and more '
      'study.',
      'Close the cable-routing action and retain the return-lag observation as a maintenance item. '
      'Combining them would imply that the gradual lag had the same cause as the excursion, a '
      'conclusion unsupported by the matched repeat after restraint.',
      '"No cable crossed the travel envelope after restraint. The abrupt rise disappeared, yet '
      'return remained slow; we kept that observation separate and made no stop adjustment during '
      'the fifth inspection window."',
      'The intervention separates effects. Readings describe the restrained setup, while the '
      'remaining lag requires a timing check rather than another change to the corrected cable '
      'route.'),
     ('Extra dwell barely changed return readings during the sixth window, spanning 207 to 240 '
      'micrometers. Not every stop converged steadily, challenging the claim that waiting removes '
      'the entire directional difference across the span inspected under the present fixed timing '
      'protocol.',
      'Compare fixed dwell periods instead of waiting until the pointer looks stable. Defined '
      'timing makes nonmonotonic behavior observable and prevents an operator from selecting a '
      'favorable instant that understates the uncertainty in measuring the return stroke.',
      '"At the third stop the pointer paused, then moved again. We used the scheduled observation '
      'time rather than calling that pause completion, because later motion showed that stillness '
      'was not a reliable event."',
      'Explicit timing tests this explanation. Four readings remain comparable when dwell is set '
      'independently of pointer behavior, which is the response this procedure intends to '
      'measure.'),
     ('The written log and indicator capture disagreed by one interval during the seventh window '
      'of 216 to 249 micrometers. Inspection showed that the log used motion onset while the '
      'capture used stop contact; the discrepancy therefore reflects two different temporal '
      'origins.',
      'Recalculate elapsed times from stop contact and preserve original timestamps in the '
      'handover record. Aligning the origin permits comparison of settling without silently '
      'altering evidence or suggesting that the gauge itself changed during the interval of '
      'observation.',
      '"I timed the start of travel; the capture timed stop contact. That contact is visible in '
      'both records, allowing alignment without inventing another event or deleting either '
      'original entry from the inspection log."',
      'A shared origin reconciles both records. Values stay unchanged, while fixed timing keeps '
      'reaction and carriage movement from being mistaken for additional delay inside the gauge.'),
     ('A new bracket narrowed clearance around the stem during the eighth window of 225 to 258 '
      'micrometers. Nothing touched at inspected stops, but the smaller gap changes installation '
      'conditions and limits comparison with the former fixture across unrestricted travel.',
      'Document bracket clearance and test the largest permitted movement before releasing the '
      'gauge for full service. Quiet operation at four positions cannot exclude contact elsewhere, '
      'particularly when the receiving fixture permits a wider excursion than the inspected span.',
      '"The stem stayed clear of the bracket but its nearest gap was smaller. We did not move '
      'beyond inspected stops; lack of contact in these positions leaves the rest of the permitted '
      'envelope unverified."',
      'No contact has limited meaning. The matrix supports inspected positions, while the new '
      'bracket still needs a clearance check across permitted travel before full release of the '
      'instrument.'),
     ('An endpoint fixture permitted four checks between 234 and 267 micrometers during the ninth '
      'window. Orderly progression supports the extended span, but central readings remain '
      'separate because support geometry changed before these further observations were recorded.',
      'Record endpoint extension as a new acceptance item instead of replacing the central '
      'sequence. Preserving both sets exposes the fixture change and allows later inspection to '
      'distinguish a response difference from an altered mechanical support condition during '
      'checks.',
      '"The longer fixture kept approach direction but shifted carriage support. Fasteners were '
      'checked before noting positions, and we retained the earlier sheet to make the mounting '
      'change explicit in the ninth window."',
      'Extension adds evidence with conditions. These readings support a broader span, while '
      'fixture records protect later comparisons from an unnoticed change in mechanical support '
      'for the carriage.'),
     ('Handover confirmed cable restraint and endpoint extension, leaving return timing open. '
      'Final readings covered 243 to 276 micrometers; the operator inherits a usable forward '
      'reference and a directional response needing more checks under the fixed dwell protocol.',
      'Transfer fixture records and demonstrate forward approach before release. Include the '
      'timing origin so the operator can reproduce the accepted reference while gathering evidence '
      'about return lag during the next scheduled instrument inspection at the receiving station.',
      '"Forward travel repeated after fixture inspection. Return timing remained open, and the new '
      'operator saw how contact defines the clock origin; no internal adjustment followed before '
      'the final instrument handover."',
      'Release states established behavior. Travel supports the forward reference, while the open '
      'timing item stays visible instead of being hidden inside a general claim of calibration '
      'success.')],
 12: [('The ledger exceeded counted ceramic sleeves after evening transfer, although sealed crates '
       'remained intact. Four shelf counts lay between 143 and 176 units; the discrepancy concerns '
       'loose stock near the packing bench rather than evidence of a broken transport seal.',
       'Reconcile loose stock before opening sealed crates, retaining the transfer slip beside the '
       'shelf count. This limits handling while testing whether ledger posting preceded the '
       "packing bench's physical receipt during the evening transfer between the two storage "
       'locations.',
       '"The crates kept their closures, but loose sleeves stood beside the bench without a '
       'ticket. We counted that group separately and left it in place until the transfer slip '
       'could be checked against the ledger."',
       'Posting order merits investigation first. Separate shelf and bench counts retain the '
       'inventory boundary without treating intact crates as the presumed cause of each recorded '
       'stock difference.'),
      ('A delayed receipt reached the next shift, temporarily overstating the previous shelf '
       'balance. Second-window counts ranged from 152 to 185 units; this timing mismatch explains '
       'the difference without requiring any change in the physical quantity transferred between '
       'the storage locations.',
       'Attach the receipt reference while preserving posting time. Matching the transfer resolves '
       'imbalance, but both timestamps distinguish this timing correction from an unexplained '
       'physical adjustment when the next shift reviews stock during quantity reconciliation.',
       '"Sleeves reached the bench before ledger closing; their ticket was posted next shift. Both '
       'entries refer to one transfer, and neither records another movement between the two '
       'locations during the second counting window."',
       'Chronology supplies the link. Counts describe physical stock, while paired timestamps '
       'explain how a ledger snapshot can disagree without implying another delivery or an '
       'unrecorded shipment.'),
      ('Reconciliation matched units without verifying condition inside sealed crates. '
       'Third-window counts covered 161 to 194 units; agreement establishes quantity at the '
       'counting boundary while leaving usability outside this review, since no one inspected '
       'inner surfaces during the count.',
       'Separate quantity acceptance from condition inspection and route crates through receiving. '
       'Combining decisions would turn a successful count into an unsupported quality claim about '
       'material nobody examined during reconciliation near the packing bench in the review.',
       '"We inspected labels and closures, not the enclosed surfaces. Loose sleeves were visible, '
       'but their condition cannot prove that of sealed stock; receiving inspection remains '
       'separate from this bench quantity review."',
       'Quantity and usability need separate evidence. Counts settle the balance, while open '
       'inspection prevents numerical agreement from becoming approval for immediate use of '
       'enclosed material.'),
      ('One ticket listed a full bundle although its wrapper held sleeves from two transfers. '
       'Fourth-window counts covered 170 to 203 units; familiar packaging cannot substitute for '
       'physical inspection when the closure has been disturbed and provenance is no longer '
       'singular.',
       'Count the open wrapper individually and preserve both transfer references on its ticket. '
       'Reusing nominal bundle quantity repeats the assumption; individual counting establishes a '
       'basis for later issue and remaining-stock calculations when material returns to storage.',
       '"From the aisle the wrapper looked full, but its end was open with two tickets beneath it. '
       'Each sleeve was counted before closing, and both references were kept rather than '
       'assigning the group to one receipt."',
       'Packaging hid mixed provenance. The replacement ticket uses counted units, while both '
       'transfer histories remain available to explain later issues and preserve a traceable '
       'balance at the shelf.'),
      ('Recounting confirmed the mixed wrapper and located an unposted dispatch issue. '
       'Fifth-window observations ranged from 179 to 212 units; the ledger difference now '
       'separates a counting assumption from a missing transaction instead of combining distinct '
       'causes into unexplained shrinkage.',
       'Post the supported issue and correct the wrapper ticket separately, preserving distinct '
       'evidence references. This explains adjustments without implying that dispatch paperwork '
       'validates quantities assumed from packaging rather than individual counting.',
       '"An authorized issue slip remained in dispatch without a ledger entry. It matched stock '
       'already removed; the wrapper needed a separate correction, and the changes need different '
       'evidence during this count window."',
       'Separate corrections preserve the explanation. Counts populate the matrix, while issue '
       'paperwork and wrapper inspection address different errors that remain distinct during the '
       'stock review.'),
      ('Recounting crates would never expose the missing dispatch entry found earlier. '
       'Sixth-window shelf values covered 188 to 221 units; physical inspection alone cannot '
       'resolve a discrepancy caused by delayed or omitted posting of an authorized transaction '
       'between the two count windows.',
       'Check transaction completeness alongside quantity instead of relying only on recount '
       'frequency. Both controls address counting and posting errors while avoiding repeated '
       'handling of sealed material whose boundary stayed consistent throughout this stock review.',
       '"Paperwork authorized dispatch, but the ledger omitted the issue. A crate recount would '
       'repeat the physical result; the explanation appeared when the slip was matched to stock '
       'already removed from its assigned shelf."',
       'Counting more does not always improve diagnosis. Shelf readings need transaction context, '
       'since correct counts can coexist with an incomplete ledger despite an authorized movement '
       'of stock.'),
      ('Evening and morning teams assigned one transfer to different windows, generating opposite '
       'differences. Seventh-window counts ranged from 197 to 230 units; totals reconcile when '
       'physical receipt defines the boundary instead of ledger entry, which occurred after '
       'material moved.',
       'Use receipt at the bench as the shared boundary and preserve the shift entries. The '
       'convention reconciles transfer ownership without hiding posting delay, which remains '
       'relevant when assessing how quickly the ledger reflects movements between counted '
       'locations.',
       '"Our count ended at receipt; the next shift used later posting. The transfer slip records '
       'physical receipt, allowing one boundary for both accounts without inventing another '
       'delivery or changing the counted quantity."',
       'A common boundary prevents double attribution. Counts retain physical meaning, while '
       'posting time separately measures the delay that caused disagreement between the records of '
       'the two shifts.'),
      ('A temporary rack brought sleeves closer to dispatch in the eighth window of 206 to 239 '
       'units. Handling shortened; unissued material now stood beside outbound orders; comparisons '
       'must preserve transaction status rather than treating proximity as proof of issue.',
       'Mark the temporary rack as storage and require an issue slip before units leave its '
       'boundary. This improves handling without silently changing dispatch recognition or '
       'creating an unrecorded category for loose material kept near the outbound tray between '
       'counts.',
       '"The rack stood beside packed orders but its sleeves had no issue slip. We counted them as '
       'stored stock and marked the boundary, preventing dispatch from being inferred merely from '
       'location during the next count."',
       'Convenience adds classification risk. Counts follow transaction status, while the marked '
       'rack gives later inspections a clear physical boundary for preserving the same inventory '
       'distinction.'),
      ('A trial rack issue reached the ledger before counting, leaving no unexplained ninth-window '
       'movement. Shelf observations covered 215 to 248 units; the controlled transfer supports '
       'revised recognition but supplies no evidence about receiving delays or completion of '
       'condition inspection.',
       'Retain the trial as evidence for rack issues while keeping receiving controls on their '
       'separate review track. Broader claims would overlook different documents, responsibilities '
       'and posting delays before an incoming movement reaches the ledger for stock '
       'reconciliation.',
       '"Posting preceded counting for the signed rack issue. We traced that movement to dispatch '
       'without opening an incoming crate; this trial never exercised receiving or condition '
       'checks, which still require separate evidence."',
       'The trial tests one control. Counts support timely posting of this rack issue, while '
       'receiving needs its own evidence before improvement can be claimed beyond the dispatch '
       'pathway.'),
      ('Closing review reconciled the wrapper and delayed issue while leaving condition inspection '
       'unfinished. Final counts ranged from 224 to 257 units; the next shift receives a balanced '
       'record with clear boundaries for rack stock and sealed crates that still await '
       'examination.',
       'Hand over corrected tickets, timestamps and rack boundaries before closing quantity '
       'review. Keep condition inspection visibly open so receiving can complete that task without '
       'mistaking ledger agreement for approval of every sleeve for immediate use in production.',
       '"The ledger matches all counted locations, including the rack. Wrapper and issue '
       'references are attached; unopened crates still await condition inspection, which we never '
       'inferred from success in the final quantity review."',
       'Handover retains uncertainty alongside resolution. Quantity reconciliation is complete, '
       'but condition inspection remains open and needs its own evidence within a clear boundary '
       'for stock.')]}


def family_world(family):
    """Facts are frozen before prose layout or any PDF exists."""
    fid = family['familyId']
    if family['classId']!='P':
        from fools_gold_v4_enriched import enriched_world
        return enriched_world(family)
    base = 0 if family['layoutId'] == 'A' else 6 if family['layoutId'] == 'B' else 12
    start = {0: 184, 6: 162, 12: 143}[base]
    rng = random.Random(family['worldSeed'])
    pages = []
    for p in range(10):
        lower = start + 9*p
        counts = [lower + j*11 for j in range(4)]
        durations = [137 + rng.randrange(90) for _ in range(4)]
        pages.append(dict(number=p+1, lower=lower, upper=lower+33,
                          readings=counts, durations=durations,
                          ratios=[str((Decimal(a)/Decimal(b)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)) for a,b in zip(counts,durations)],
                          purpose=['observation','mechanism','qualification','exception','decision','counterexample','reconciliation','qualification','decision','handover'][p],
                          prose=list(PROSE[base][p])))
    return dict(schema='mixed-pdf-world@4',familyId=fid,seed=family['worldSeed'],
                genre=family['genreSlot'],unit={0:'g',6:'um',12:'unit'}[base],
                title={0:'Ceramic tray moisture review',6:'Displacement gauge service handover',12:'Ceramic sleeve stock reconciliation'}[base],
                role={0:'Process inspection',6:'Instrument services',12:'Stock control'}[base],
                date='2026-04-%02d'%(1+fid%27),pages=pages)


def display_content(world, page, family):
    p = page['number']
    fid=family['familyId']
    heading={'A':'Ceramic tray moisture assessment','B':'Displacement gauge service handover','C':'Ceramic sleeve stock reconciliation'}[family['layoutId']]
    # Literal variables, values and unit statements all refer to the frozen world.
    symbols={'A':('yield','mass','time'),'B':('speed','travel','dwell'),'C':('issue','stock','hours')}[family['layoutId']]
    q,a,b=symbols
    unit=world['unit']
    x=page['readings'][0]; y=page['durations'][0]
    rule=f'Check rule {p:02d}: {q} = {a} / {b}'
    # Fixed print precision is explicit and is not changed to hide a bad render.
    constraint=f'Range {p:02d}: [{page["lower"]}, {page["upper"]}] {unit}; tolerance +/- 0.4 {unit}'
    if family['layoutId']=='A':
        constraint=f'Range {p:02d}: [{page["lower"]}, {page["upper"]}] grams; tolerance +/- 0.4 g'
    if family['layoutId']=='C':
        constraint=f'Range {p:02d}: [{page["lower"]}, {page["upper"]}] pcs; tolerance +/- 0.4 pcs'
    table=[['Sector','Time','Reading','Rate/h' if family['layoutId']=='C' else 'Rate/s']]
    for j in range(4): table.append([f'{chr(75+fid%12)}{p:02d}{j+1:02d}',str(page['durations'][j]),str(page['readings'][j]),f'{Decimal(page["ratios"][j]):04.1f}'])
    texts=dict(heading=heading,subheading=f'Service record / part {p:02d}',
               **{'body.1':page['prose'][0],'body.2':page['prose'][1],
                  'matrix.title':f'Window {p:02d} / data matrix',
                  'math.rule':rule,'math.constraint':constraint,
                  'discussion.title':f'Inspection commentary and evidence note {p:02d}',
                  'discussion.excerpt':page['prose'][2],
                  'discussion.commentary':page['prose'][3],
                  'footer':f'Operations review / record {p:02d}\nRetain with the signed inspection notes for the next shift.'})
    return texts,table,(q,a,b,x,y)

