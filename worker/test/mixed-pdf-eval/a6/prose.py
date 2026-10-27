"""Metric-constrained fresh domain prose; numerical assertions remain bound.

Sentence choices and paragraph structures vary before targets are frozen. Text
cannot be fitted to an exported page. Eight-token and paragraph duplicate gates
apply to the authored population, independently of native rendering.
"""
from __future__ import annotations
from decimal import Decimal
import random
import re
from contract import FONTS, normalized, words, split_lines

NUMBER_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten']
DETAILS = [
 'The {component} inspection separates reversible {mechanism} from persistent damage within the {material}.',
 'For {subject}, temporary {mechanism} remains a plausible explanation requiring an independently documented inspection.',
 'A sheltered {component} check preserves evidence of {mechanism} without disturbing the retained {material}.',
 'Operators reviewing {subject} should distinguish handling disturbance from the proposed {mechanism} pathway.',
 'The {material} assessment links {mechanism} to maintenance history rather than an undocumented adjustment.',
 'During {subject}, the {component} provides a controlled observation point for a subsequent physical inspection.',
 'Any proposed {component} intervention requires traceable documentation of {mechanism} and the surrounding operating conditions.',
 'For the {material}, reversible {mechanism} would explain variation without establishing permanent equipment damage.',
 'Inspection of {subject} begins with the {component}, preserving the original sequence and maintenance annotations.',
 'A {mechanism} hypothesis directs the {component} investigation while leaving acceptance authority with the responsible operator.',
 'Further {subject} assessment should preserve the {material} condition until the planned intervention is authorized.',
 'The {component} remains accessible for inspection; suspected {mechanism} requires confirmation before operational changes.',
 'Documented {subject} findings support investigation of the {material} without presuming a particular failure mechanism.',
 'Because {mechanism} can alter the {material}, the {component} inspection must preserve its initial condition.',
 'Handling records for {subject} provide context when reviewing the proposed {mechanism} explanation.',
 'A complete {component} record distinguishes the {material} response from an incidental maintenance disturbance.',
]
ACTIONS = [
 'Before release, {action} and preserve the {material} record for technical review.',
 'The proposed {subject} action is to {action}, with the {component} condition documented beforehand.',
 'Maintenance should {action}; a separate {component} inspection can then challenge the {mechanism} hypothesis.',
 'To investigate {mechanism}, {action} before disturbing the retained {material} or changing operating settings.',
 'For {subject}, {action} only after recording the {component} condition and reviewing the maintenance history.',
 'A defensible {material} disposition requires a documented decision to {action} following inspection.',
 'Record the {component} condition, then {action} under the established {subject} procedure.',
 'The {mechanism} interpretation remains provisional; {action} before authorizing further {subject} operation.',
 'Preserve the {material} for review while maintenance prepares to {action} under controlled conditions.',
 'Following the {component} inspection, {action} and document whether {mechanism} remains a credible explanation.',
 'A technical reviewer should {action} while retaining the {subject} evidence and maintenance observations.',
 'For the {component}, document the intervention needed to {action} without overwriting the {material} history.',
]
QUALIFIERS = [
 'The {component} record supports investigation, rather than an unsupported release decision about the {material}.',
 'An unexplained {subject} deviation deserves documented follow-up before the {component} returns to routine operation.',
 'For {subject}, qualified inspection remains necessary because a plausible mechanism cannot establish acceptance.',
 'The {material} record should retain the observation context even if the {component} adjustment appears effective.',
 'Interpretation of {mechanism} requires attention to the original {subject} sequence and retained inspection evidence.',
 'A provisional {subject} explanation must remain distinguishable from confirmed findings about the {material}.',
 'The {component} handover should identify unresolved {mechanism} questions alongside the proposed maintenance action.',
 'Without a controlled {component} inspection, the apparent {material} response cannot resolve the proposed mechanism.',
 'Keep the {subject} observation window explicit when comparing the retained {material} with later maintenance findings.',
 'The {material} investigation can challenge {mechanism} without treating an undocumented adjustment as corrective evidence.',
 'The {component} review distinguishes {mechanism} from lasting damage to the {material}.',
 'For {subject}, a mechanism remains provisional until the {component} inspection provides confirmation.',
 'The {material} condition informs {subject} disposition but does not establish equipment failure.',
 'The {component} review retains uncertainty about the {material} until inspection is complete.',
 'During {subject}, preserve the {material} condition before disturbing the suspected mechanism.',
 'A {component} observation deserves context from the {subject} maintenance history.',
 'Follow the {subject} procedure while assessing the {component} condition.',
 'Review the {material} disposition before returning the {component} to service.',
]
EXTENDED = [
 'A useful {subject} comparison preserves the {component} configuration while documenting environmental conditions and intervention timing.',
 'The {material} discussion should distinguish observed behavior from the proposed {mechanism}, retaining uncertainty in the decision record.',
 'Reviewers of {subject} need the maintenance annotations, because the {component} response alone cannot establish the direction of causation.',
 'A subsequent {component} inspection should challenge the {mechanism} explanation with independently recorded findings about the retained {material}.',
 'For {subject}, preserving the initial {material} condition makes a later technical review more informative than repeating an uncontrolled adjustment.',
 'The {component} assessment retains a clear boundary between an observed {material} deviation and the inferred consequences of {mechanism}.',
]

LEXICON = {
    'inspection': ['inspection','assessment','examination','survey'],
    'review': ['review','appraisal','evaluation'],
    'record': ['record','entry','report'],
    'documented': ['documented','recorded','logged'],
    'proposed': ['proposed','suggested','possible'],
    'retained': ['retained','preserved','stored'],
    'initial': ['initial','original','starting'],
    'subsequent': ['subsequent','later','follow-up'],
    'technical': ['technical','operational','engineering'],
    'requires': ['requires','needs','warrants'],
    'preserves': ['preserves','retains','safeguards'],
    'condition': ['condition','state'],
    'maintenance': ['maintenance','servicing'],
    'surrounding': ['surrounding','prevailing','ambient'],
    'unresolved': ['unresolved','outstanding','open'],
    'explanation': ['explanation','hypothesis','interpretation'],
    'confirmed': ['confirmed','verified','established'],
    'retains': ['retains','preserves','keeps'],
    'preserve': ['preserve','retain','safeguard'],
    'recording': ['recording','logging','documenting'],
    'subsequent': ['subsequent','later','follow-up'],
    'document': ['document','record','log'],
    'investigation': ['investigation','examination','assessment'],
    'evidence': ['evidence','findings','observations'],
    'credible': ['credible','plausible','reasonable'],
    'important': ['important','necessary','essential'],
}

SHORT = [
 'Next, {action}.',
 'Beforehand, document the {component} condition.',
 'Preserve {subject} servicing annotations.',
 'Keep the {material} undisturbed pending review.',
 'Inspect {mechanism} evidence before release.',
 'Record {component} settings before adjustment.',
 'Reconsider {mechanism} after physical inspection.',
 'Retain {subject} records for the handover.',
 'Use controlled handling of the {material}.',
 'Investigate the {component} under stable conditions.',
 'Avoid disturbing the {material} during inspection.',
 'Document the {subject} intervention separately.',
 'Reassess {mechanism} before authorizing maintenance.',
 'Photograph the {component} before disassembly.',
 'Label the retained {material} for review.',
]
PURPOSE = {
 'observation':'Preserve the {component} settings before recording further observations.',
 'mechanism':'Challenge {mechanism} through a controlled {component} inspection.',
 'qualification':'Qualify the {material} interpretation before extrapolating its response.',
 'decision':'Authorize {subject} release only after the disposition review.',
 'exception':'Escalate the {component} exception for separate engineering assessment.',
 'counterexample':'Seek {material} evidence that contradicts the proposed mechanism.',
 'handover':'Explain the {component} condition to the incoming operator.',
 'containment':'Keep the {material} isolated while maintenance investigates.',
 'comparison':'Compare {subject} records under matched operating conditions.',
 'closure':'Close the {component} review after documenting corrective verification.',
}


def vary(text,rng):
    return re.sub(r'\b[a-z]+\b',lambda m:rng.choice(LEXICON.get(m[0],[m[0]])),text)


def folded(text):
    return re.findall(r'[a-z]+', text.lower())


class Author:
    def __init__(self):
        self.paragraphs = set()
        self.eightgrams = set()

    def fresh(self, text):
        tokens=folded(text)
        grams={tuple(tokens[i:i+8]) for i in range(len(tokens)-7)}
        return tuple(tokens) not in self.paragraphs and not (grams & self.eightgrams)

    def retain(self,text):
        tokens=folded(text)
        self.paragraphs.add(tuple(tokens))
        self.eightgrams.update(tuple(tokens[i:i+8]) for i in range(len(tokens)-7))

    def pair(self,world,page,first,second,total,seed):
        import copy
        before=(set(self.paragraphs),set(self.eightgrams))
        last=None
        for retry in range(40):
            self.paragraphs=set(before[0]);self.eightgrams=set(before[1])
            try:
                a=self.paragraph(world,page,first,'body.1',seed+retry*421,attempt_limit=3000)
                chosen=copy.deepcopy(second);n=len(words(a[0]))
                chosen['budget']['words']=[max(second['budget']['words'][0],total[0]-n),min(second['budget']['words'][1],total[1]-n)]
                assert chosen['budget']['words'][0]<=chosen['budget']['words'][1]
                b=self.paragraph(world,page,chosen,'body.2',seed+retry*733+19,attempt_limit=3000)
                return a,b
            except (ValueError,AssertionError) as e:last=e
        self.paragraphs=set(before[0]);self.eightgrams=set(before[1])
        raise ValueError(f'No joint body solution after bounded backtracking: {world["familyId"]}/{page["number"]}: {last}')

    def paragraph(self, world, page, block, role, seed,attempt_limit=50000):
        b=block['budget'];typ=block['typography'];font=FONTS[typ['font_class']]
        box=block['placement_container_pt'];rng=random.Random(seed)
        facts=world['domain']
        rows=page['observations'];loads=[Decimal(r['cells'][1]) for r in rows]
        lo,hi=page['policy']['endpoints'];exceptions=sum(not Decimal(lo)<=v<=Decimal(hi) for v in loads)
        values=dict(facts,n=NUMBER_WORDS[len(rows)],lo=str(min(loads)),hi=str(max(loads)),
            exceptions=NUMBER_WORDS[exceptions],purpose=page['purpose'])
        count_claims=[
            'The {n} {component} observations span {lo} to {hi} mg for {purpose}.',
            'For {subject} {purpose}, {n} readings range from {lo} to {hi} mg.',
            'For {purpose}, {n} {component} masses extend from {lo} to {hi} mg.',
            'In {purpose}, {n} {material} masses range between {lo} and {hi} mg.',
        ]
        exception_claims=[
            'For {purpose}, {exceptions} observations fall outside {component} mass reference limits.',
            'The mass policy leaves {exceptions} observations outside {component} limits during {purpose}.',
            'Policy comparison for {purpose} finds {exceptions} observations outside {component} mass limits.',
            'Against the {purpose} policy, {exceptions} observations fail the {component} reference interval.',
        ]
        excerpt_claims=[
            '"The {component} {purpose} ledger contains {n} mass observations.',
            '"For {subject}, the {purpose} mass population contains {n} observations.',
            '"Our {purpose} review keeps {n} {component} observations of mass.',
            '"This {subject} entry contains {n} observations for {purpose}.',
        ]
        for attempt in range(attempt_limit):
            if role=='body.1':
                sentences=[rng.choice(count_claims),rng.choice(DETAILS),rng.choice(SHORT)]
                if b['words'][0]>=70: sentences += [rng.choice(EXTENDED), rng.choice(QUALIFIERS)]+rng.sample(SHORT,rng.choice([1,2,3]))
            elif role=='body.2':
                sentences=[rng.choice(exception_claims),rng.choice(QUALIFIERS)]+rng.sample(SHORT,rng.choice([1,2]))
                if len(rows)==6:sentences=[rng.choice(exception_claims),rng.choice(QUALIFIERS),'Weighted terms select observation rows 1, 3 and 6.']+rng.sample(SHORT,rng.choice([0,1]))
                if b['words'][0]>=70:sentences += [rng.choice(EXTENDED),rng.choice(DETAILS)]+rng.sample(SHORT,rng.choice([0,1,2]))
            elif role=='discussion.excerpt':
                sentences=[rng.choice(excerpt_claims),rng.choice(DETAILS)]+rng.sample(SHORT,rng.choice([1,2]))
                sentences[-1]+='"'
            else:
                sentences=([rng.choice(QUALIFIERS),PURPOSE[page['purpose']]] if rng.random()<.5 else [rng.choice(SHORT),PURPOSE[page['purpose']],rng.choice(SHORT)])
            # Purpose changes the paragraph's reasoning, not just its identifier.
            if role.startswith('body.') and rng.random()<.5:
                sentences=sentences[1:]+sentences[:1]
            text=normalized(vary(' '.join(sentences).format(**values),rng))
            if not b['words'][0]<=len(words(text))<=b['words'][1]:continue
            if not b['characters'][0]<=len(text)<=b['characters'][1]:continue
            if not self.fresh(text):continue
            for lines in range(b['lines'][0],b['lines'][1]+1):
                try: wrapped=split_lines(text,lines,box[2]-box[0],font,typ['font_size_pt'])
                except ValueError:continue
                self.retain(text)
                return text,wrapped,dict(kind='population-summary' if role=='body.1' else 'reference-exceptions' if role=='body.2' else 'population-count' if role=='discussion.excerpt' else 'qualitative',
                    population=[r['id'] for r in rows],quantity='loaded mass',unit='mg')
        raise ValueError(f'Cannot jointly author {world["familyId"]}/{page["number"]}/{role}: budgets+metric+freshness')
