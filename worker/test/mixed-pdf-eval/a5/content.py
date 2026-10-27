"""Fresh source-blind attempt-5 worlds and finalized metric-constrained prose."""
from decimal import Decimal, ROUND_HALF_UP
import random
from support import freeze

NARRATIVES = [['Initial weighing found uneven retention across the {part} despite unchanged loading. Four readings '
  'describe the first inspection window; their spread suggests a local drainage problem rather than a '
  'uniform rise in liquid held across the complete assembly.',
  'Record each position before changing the outlet arrangement. Keeping the initial sequence lets a later '
  'comparison separate a real drainage improvement from a change in which part was weighed during the '
  'inspection at the receiving station.',
  '"We kept the loading order and weighed every position separately. The outlet remained untouched during '
  'window {p}, covering {lo} to {hi} grams; the heavier location therefore belongs to the unchanged setup '
  'recorded here."',
  'Position matters before adjustment. Mass readings define the initial boundary, while a further drainage '
  'check can test the proposed cause without replacing evidence from this review window.'],
 ['A blocked vent could explain the mass difference at the {part}. Liquid leaves slowly when air cannot '
  'escape, but this record cannot show whether the blockage lasted through every loading interval or '
  'affected only one position during the inspection.',
  'Inspect the vent while keeping the mass record as a separate observation. A clear passage after opening '
  'would not prove that it stayed clear during loading, since moving the cap can disturb material near the '
  'internal vent opening.',
  '"The vent was clear after opening, but the cap had already moved. Window {p} retains {lo} through {hi} '
  'grams as observed; we cannot use the later inspection to establish the earlier condition inside the '
  'assembled passage."',
  'Opening changes the evidence boundary. The matrix records retained mass, whereas a later clear passage '
  'describes another state and cannot alone resolve the proposed cause of slow drainage.'],
 ['Repeat loading reduced variation at the {part}, although the holding interval also increased. Both '
  'conditions changed together, so the reduced spread cannot be linked solely to revised handling without a '
  'controlled comparison made at the original holding time.',
  'Keep timing and handling as separate acceptance items. A repeat using the original interval would test '
  'the handling change directly, while longer holding can be assessed independently before a permanent '
  'operating instruction is sent to the receiving team.',
  '"We changed handling and waited longer before weighing. The {lo} to {hi} gram range in window {p} shows '
  'the combined outcome, but it does not tell us which change caused the narrower spread across inspected '
  'positions."',
  'This qualification limits the claim. Mass readings support the combined procedure, while testing either '
  'change needs another comparison that keeps the other condition fixed during inspection.'],
 ['One position on the {part} retained extra liquid after a brief loading pause. Nearby readings stayed '
  'orderly, making the interruption a plausible local influence; this result does not justify treating all '
  'material measured in this window as uniformly affected.',
  'Retain the interrupted position as a separate observation instead of removing it. Its handling history '
  'explains how a local exception can coexist with otherwise consistent readings and provides a defined '
  'condition for comparison during the next scheduled inspection.',
  '"The loading pause occurred before the third position was weighed. We retained that observation with the '
  '{lo} to {hi} gram window {p} record, since discarding it would hide the condition that made this reading '
  'different."',
  'An exception carries context. The table preserves observed masses, while the pause record directs testing '
  'toward one handling event instead of an assumed general defect in the material.'],
 ['The review chose a vent inspection before changing the {part} loading rate. This decision follows earlier '
  'local evidence and keeps a reversible sequence; it does not mean that a restricted vent has already been '
  'proved the sole cause of liquid retention.',
  'Record the inspection before approving a rate change. Keeping decisions sequential prevents two combined '
  'actions from producing an gain whose cause cannot be assigned when the revised procedure reaches use '
  'during operation at the receiving station.',
  '"We chose a vent check first and left loading unchanged. Window {p} records {lo} to {hi} grams retained; '
  'that reference will test one intervention before any further operating change is considered by the '
  'receiving team."',
  'The decision preserves a testable sequence. Mass provides a reference, while one change lets the next '
  'observation address the proposed cause without combining unrelated actions in this window.'],
 ['Longer holding failed to equalize mass across the {part}, challenging the claim that waiting resolves the '
  'gap. The lasting pattern points toward angle or handling history, though these readings cannot separate '
  'those causes without a further physical check.',
  'Compare the affected locations with the assembly drawing before adding delay again. More waiting would '
  'repeat an action that failed to remove the pattern, while inspection can test whether drainage paths '
  'differ between the positions already measured.',
  '"The longer hold left the same location heavier. We measured {lo} to {hi} grams in window {p}; the extra '
  'delay did not erase the pattern, so another increase in waiting time needs a separate justification."',
  'This failed trial narrows the explanation. Mass still varies by position after extra holding, supporting '
  'a geometry check while keeping initial readings for comparison with the next condition.'],
 ['Two records gave different times for the {part}, creating an apparent dispute about drainage duration. '
  'Review found that one clock began at loading and the other at outlet opening; retained masses were copied '
  'correctly between the two inspection records.',
  'Use outlet opening as the shared time origin and preserve earlier timestamps. Reconciliation should '
  'explain the difference rather than replace an entry, allowing reviewers to reproduce the alignment '
  'without guessing when the drainage interval began during inspection.',
  '"Our clock began at loading; the other clock began at outlet opening. Window {p} retains {lo} through '
  '{hi} grams; using the shared event aligns duration without changing the mass recorded on either '
  'inspection sheet."',
  'A shared event reconciles timing. The matrix retains its masses, while timestamps explain the dispute and '
  'prevent a clerical alignment from being mistaken for improved drainage performance.'],
 ['A new support changed the resting angle of the {part} before weighing. Access improved but drainage '
  'geometry also changed; comparison with earlier windows thus needs a mounting note rather than an unbroken '
  'claim about performance during routine operation.',
  'Measure the installed angle and attach the support record before acceptance. Easier access does not prove '
  'equal drainage, and qualification should stay visible until a comparison separates mounting effects from '
  'changes in material charged during the inspection window.',
  '"The new support gave easier access but tilted the assembly. Window {p} retains {lo} to {hi} grams under '
  'this mounting; unchanged material alone cannot prove that drainage stayed equal to the earlier setup '
  'during inspection."',
  'Mounting defines the comparison boundary. Mass readings describe the new support, while the angle record '
  'prevents easier access from changing the meaning of the earlier drainage observations.'],
 ['A repeat at the {part} kept revised support while restoring the initial hold interval. This comparison '
  'tests timing under current geometry; it gives no evidence about previous mounting, since that support was '
  'absent throughout the recorded measurement sequence.',
  'Accept the repeat as a timing check for new mounting only. Applying that finding to the old support would '
  'combine separate comparisons and hide the physical condition that remained fixed while these readings '
  'were gathered during the operating review.',
  '"The new support stayed in place and only hold time changed. Window {p} covers {lo} to {hi} grams; this '
  'checks timing here, leaving the old support outside the conditions tested by these recorded mass '
  'readings."',
  'The trial has defined scope. Masses test timing within new geometry, while assessing the former support '
  'needs another observation with that support restored for inspection.'],
 ['Handover passed the {part} record with aligned timing and clear mounting notes. Evidence supports the new '
  'inspection sequence, but the vent claim stays open because no controlled assembled check has isolated its '
  'effect on liquid retained during routine operation.',
  'Give the receiving team both timestamps, the support note and the next inspection action. Closing review '
  'should retain uncertainty instead of turning a complete record into a claim that every drainage question '
  'has been resolved during the handover.',
  '"The next team received mounting notes and aligned clocks. Window {p} covers {lo} to {hi} grams; the vent '
  'check stays open, and completing this handover alone gives no general drainage approval for routine '
  'operation."',
  'Handover separates records from resolution. The mass record is complete, while the open vent test retains '
  'a clear purpose and stays visible to those conducting the next inspection.']]

EXPANSIONS = [('Consistent tare handling is also required. Dry support mass belongs beside each reading so that a later '
  'shift cannot attribute replacement hardware to liquid retention. The distinction matters when equipment '
  'changes within a documented operating period.',
  'The receiving operator needs the positional record before choosing another action. An isolated high value '
  'can otherwise prompt several simultaneous changes, removing the chance to test whether the earlier '
  'difference followed loading order or physical location.'),
 ('The assembled state needs a direct check because opening the cover releases pressure. Finding debris '
  'afterward can support a possible cause, yet a clear passage cannot reconstruct the earlier flow while '
  'liquid and air shared that opening.',
  'Plan the flow check without assigning blame to an operator. Preserve the loading sequence and inspect '
  'only the proposed path so that the comparison tests a mechanism instead of adding another uncontrolled '
  'difference to this qualified record.'),
 ('Repeating both changes would test stable operation but leave the cause unresolved. A good result under '
  'two altered conditions cannot show the separate role of either one, so repeatability and causal '
  'explanation remain separate claims in this review.',
  'That distinction affects instructions sent to the next shift. Provisional acceptance may address '
  'repeatability while leaving the causal account qualified, permitting practical operation without turning '
  'one successful combined trial into evidence for an untested narrower operating claim.'),
 ('Link the handling exception to its measured position because the surrounding sequence supplies contrast. '
  'A final average would discard that relationship and make a later local recurrence appear unrelated even '
  'when the same interruption occurs during another loading period.',
  'The next check can deliberately reproduce the pause within normal operating limits. Recording that '
  'condition distinguishes an intentional test from an accidental interruption and keeps later observations '
  'interpretable without editing the qualification already attached to this window.'),
 ('The proposed order also limits handling. If inspection resolves the immediate concern, loading can remain '
  'unchanged; otherwise the original reference allows the second action to be judged separately, with its '
  'own conditions and evidence retained for review.',
  'Assign roles before work resumes. One role can confirm that an action finished while technical review '
  'judges its meaning, so a signed checklist never becomes proof that the proposed cause was correct during '
  'the physical operating test.'),
 ('Persistent variation does not prove component damage. The pattern might follow angle or residual material '
  'from a prior cycle, so retain those alternatives instead of replacing a failed waiting explanation with '
  'another unsupported single cause of retention.',
  'A failed action still contributes evidence. Keeping it beside the first sequence makes the limit of more '
  'waiting explicit and prevents the receiving team from repeating a slow intervention simply because its '
  'earlier result disappeared into a summary.'),
 ('Alignment must distinguish observed events from inferred ones. Outlet opening appears in both accounts, '
  'but a guessed time adds a fact neither operator saw and could conceal the original dispute about how long '
  'drainage took during this inspection window.',
  'Reference both original entries so that another reviewer can repeat the calculation. Keeping the '
  'derivation apart from raw timestamps preserves traceability and avoids presenting a clerical correction '
  'as a fresh physical measurement taken under changed operating conditions.'),
 ('The mounting note is particularly useful when better access encourages a changed weighing sequence. '
  'Record support and sequence separately because either can affect drainage while the charged material and '
  'nominal hold interval stay unchanged during this inspection period.',
  'A photograph can support an angle measurement but cannot replace it. The receiving team needs a stated '
  'mounting condition, since a general installation image may omit the small orientation difference that '
  'determines how liquid reaches the lowest outlet.'),
 ('The repeated measurement supports a bounded instruction because mounting remained fixed. That restriction '
  'gives the comparison its strength; a broader claim would erase the condition that makes the test useful '
  'and imply knowledge about a different physical arrangement.',
  'Restore the earlier support only if its operation remains relevant. Meanwhile, close the timing question '
  'for this installation while retaining old geometry as an unresolved comparison, rather than quietly '
  'treating an untested arrangement as part of the same acceptance.'),
 ('The next team can start from a defined open question rather than rebuild the reasoning from scattered '
  'notes. Each qualification stays linked to its window, keeping a complete handover distinct from a '
  'finished test of every proposed physical cause.',
  'Add later observations as fresh evidence with operating conditions intact. The review can evolve when the '
  'vent check finishes without altering earlier records or expanding the scope of an acceptance decision '
  'that has already been communicated during this handover.')]

def new_world(family):
    fid = family['familyId']
    rng = random.Random(family['worldSeed'])
    part = ['porous insert','filter cassette','drainage sleeve','screen carrier','retention cup'][fid % 5]
    pages = []
    purposes = ['observation','mechanism','qualification','exception','decision','counterexample','reconciliation','qualification','decision','handover']
    for i in range(10):
        lo = 151+fid*5+i*7
        readings = [lo+j*11 for j in range(6)]
        durations = [121+rng.randrange(130) for _ in range(6)]
        pages.append(dict(number=i+1,lower=lo,upper=lo+33,readings=readings,durations=durations,
            purpose=purposes[i],weights=['2','3','4'],gain='1.3',offset='-0.7',voltage=str(12+i),reference='20',exponent='2',
            chartSeries=[[str(24+rng.randrange(48)) for _ in range(8)] for _ in range(2)]))
    return freeze(dict(schema='attempt5-world@1',familyId=fid,seed=family['worldSeed'],unit='g',durationUnit='s',part=part,
        title=f'{part.capitalize()} drainage review',role='Materials inspection',date=f'2026-04-{fid+1:02d}',pages=pages),'worldHash')


def texts(world, facts, family):
    i = facts['number']-1
    vals = dict(part=world['part'],p=facts['number'],lo=facts['lower'],hi=facts['upper'])
    prose = [t.format(**vals) for t in NARRATIVES[i]]
    if family['classId'] == 'E1':
        prose[0] += ' '+EXPANSIONS[i][0]
        prose[1] += ' '+EXPANSIONS[i][1]
    heading = {'A':'Retained liquid inspection review','B':'Retained liquid operating condition review','C':'Retained liquid assessment record'}[family['layoutId']]
    return dict(heading=heading,subheading=f'Inspection record / part {i+1:02d}',
        **{'body.1':prose[0],'body.2':prose[1],'matrix.title':f'Window {i+1:02d} / mass readings',
           'discussion.title':f'Inspection commentary and supporting record {i+1:02d}',
           'discussion.excerpt':prose[2],'discussion.commentary':prose[3],
           'footer':f'Materials review / record {i+1:02d}\nKeep with signed inspection notes for the receiving shift.',
           'chart.caption':'Measured retention across eight inspection positions.',
           **{f'overlay.row.{r}':f'Inspection reference {i+1:02d}-{r}: {facts["readings"][r]} g' for r in range(5)}})
