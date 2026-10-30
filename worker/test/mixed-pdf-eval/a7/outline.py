"""Fresh document plans; only clean a7 specifications informed these outlines."""
import json
from pathlib import Path

OUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1')
OUTLINES = [
    dict(familyId=10, classId='E1', layoutId='B', selectedPage=1, genre='process deviation analysis',
         purpose='Decide whether restricted tank ventilation explains slower gravity discharge, and define a defensible corrective trial.',
         audience='Process engineer and shift maintenance lead',
         question='Did restoring the vent improve recovered volume without concealing an outlet restriction?',
         evidence='Fixed-duration discharge trials at matched initial liquid head; recovered volume, elapsed time, vent condition, and independent outlet checks.',
         pages=[
             ['Baseline deficit', 'How large is the discharge deficit?', 'Four 900 s draws, 180–210 L recovered.', 'Convert volume/time to L/min; distinguish a policy band from observed extrema.', 'Repeat the low run with the vent isolated as the only intervention.'],
             ['Air path mechanism', 'Could headspace vacuum account for the reduced draw?', 'Paired headspace pressure and outlet-flow traces.', 'Compare normalized loss at matched head; address pressure-tap lag.', 'Instrument the vent before replacing the outlet valve.'],
             ['Level dependence', 'Does the deficit grow as liquid head falls?', 'Early and late flow windows from a single draw.', 'Separate the expected head effect from excess decay.', 'Define a minimum-head comparison window.'],
             ['Outlet counterexample', 'Would an obstructed outlet produce the same signature?', 'A bypass check and strainer differential pressure.', 'An unchanged pressure drop weakens the outlet-obstruction explanation.', 'Retain the strainer; inspect the vent element.'],
             ['Condensate exception', 'Can a wet vent fail after a dry bench check?', 'Dry/wet airflow resistance and collected condensate.', 'Fit a bounded pressure response only over the measured flow interval.', 'Change drain orientation before choosing a larger element.'],
             ['Controlled intervention', 'Does cleaning the vent restore the low run?', 'Matched before/after draws and initial-level records.', 'Quantify recovery with identical timing and volume units.', 'Accept cleaning as a provisional repair only.'],
             ['Repeatability', 'Is the improvement stable across operators?', 'Replicated draws and timing disagreements.', 'Separate within-operator dispersion from a shift effect.', 'Replace manual timing with a level-triggered interval.'],
             ['Instrumentation bias', 'Could collection measurement explain the apparent gain?', 'Weigh-tank calibration and water-temperature observations.', 'Apply an affine volume correction; propagate the practical resolution.', 'Recalculate the decision using corrected volumes.'],
             ['Operating envelope', 'What margin remains at the lowest permitted head?', 'Two matched low-head trial groups.', 'Use a weighted result without averaging unlike operating states.', 'Add a low-head alarm rather than infer full-envelope recovery.'],
             ['Disposition', 'What evidence closes the deviation?', 'Final observed envelope, remaining wet-vent exception, inspection interval.', 'Compare the bounded response with the explicit acceptance policy.', 'Approve conditional service with a recorded follow-up trigger.'],
         ]),
    dict(familyId=16, classId='E2', layoutId='C', selectedPage=1, genre='instrument handover brief',
         purpose='Transfer a thermal logger with reproducible aggregation rules and a clear distinction between plateau means and sensor accuracy.',
         audience='Receiving metrologist and chamber technician',
         question='Can the receiving team reproduce the logger summary without mistaking a count-weighted cycle mean for calibration error?',
         evidence='Six plateau records: sample counts, sums of kelvin readings, and derived means; explicit early-cycle three-record subset.',
         pages=[
             ['Aggregation basis', 'Which observations enter the early-cycle summary?', 'Six plateau records, each retaining count and sum.', 'Compute all six means and a three-term count-weighted early-cycle mean.', 'Preserve plateau identity when importing the logger file.'],
             ['Timing alignment', 'Do timestamps denote acquisition or buffered receipt?', 'Clock-offset checks and buffer-flush records.', 'Weight three offset determinations by valid event counts.', 'Apply one documented epoch correction to the export.'],
             ['Setpoint transition', 'When does a plateau become usable?', 'Three settling windows plus later validation windows.', 'Contrast pooled stability with a transition-contaminated mean.', 'Exclude transition intervals using a visible time predicate.'],
             ['Probe agreement', 'Is a common chamber gradient being mistaken for probe drift?', 'Co-located and exchanged probe positions.', 'Compare weighted paired differences after exchange.', 'Keep position offsets separate from the logger correction.'],
             ['Dropped samples', 'Does missingness change the reported plateau?', 'Expected/received counts and summaries of available data.', 'Recompute a three-plateau aggregate from actual counts.', 'Flag incomplete acquisition rather than invent replacement readings.'],
             ['Reference chain', 'What does the reported uncertainty cover?', 'Reference calibration, resolution and repeated-read components.', 'Aggregate only like-unit estimates with justified weights.', 'Attach the reference certificate and state excluded effects.'],
             ['Warm restart', 'Does a restart disturb the next stable record?', 'Three restart cycles and matched uninterrupted plateaus.', 'Quantify the stable-window effect, excluding reboot transients.', 'Require the documented warm-up interval.'],
             ['Transfer format', 'Can the receiving software reproduce the result?', 'Native log, text export and imported sums/counts.', 'Reconcile typed records, decimal precision and three-term arithmetic.', 'Reject exports that round before aggregation.'],
             ['Acceptance exceptions', 'Which plateau needs repeat measurement?', 'All six plateau statuses under an explicit reference band.', 'Keep an exception visible while reporting the valid subset.', 'Quarantine the affected interval only.'],
             ['Handover decision', 'What must accompany the released instrument?', 'Reconciled summaries, timing correction, warm-up and exception record.', 'Use three weighted evidence groups without implying certified accuracy.', 'Release for chamber monitoring within the stated limits.'],
         ]),
    dict(familyId=2, classId='E3', layoutId='A', selectedPage=1, genre='instrument handover brief',
         purpose='Document the bridge-thermometer transfer function and demonstrate how an offset trim changes residual bias during a fixed-temperature hold.',
         audience='Instrumentation engineer accepting the bridge and readout pair',
         question='Does the trim remove the offset while preserving the stated voltage-to-temperature conversion?',
         evidence='Four conversion checkpoints and eight paired residual readings before/after trim at a 294 K reference hold.',
         pages=[
             ['Transfer function', 'What does the readout convert, and what did the trim improve?', 'Four voltage checkpoints and two eight-point residual series.', 'Apply the affine kelvin conversion and compare bias with scatter.', 'Carry the gain unchanged; record the offset trim separately.'],
             ['Short-term repeatability', 'Is the post-trim spread dominated by noise?', 'Two hold series at matched integration time.', 'Compare normalized excursions without interpreting ordering as drift.', 'Specify averaging time for the released readout.'],
             ['Lead resistance', 'Does reconnecting the probe change the indicated temperature?', 'Paired connection cycles and current reversals.', 'Use a bounded response to test an electrical rather than thermal cause.', 'Inspect connector resistance before recalibrating gain.'],
             ['Reference agreement', 'Does apparent accuracy depend on the selected reference?', 'Two reference comparisons across eight hold points.', 'Form a ratio in compatible units and retain both references.', 'Resolve reference disagreement before extending the range.'],
             ['Load sensitivity', 'Does excitation heat the sensing element?', 'Two excitation levels across eight paired holds.', 'Compare signed normalized effects with explicit current conditions.', 'Limit excitation rather than correct an unmeasured power regime.'],
             ['Range endpoints', 'Does the affine conversion remain adequate near the limits?', 'Low/high voltage checkpoints and residual traces.', 'Check endpoint bias using the fixed gain and offset.', 'Narrow the operating interval if curvature is unresolved.'],
             ['Ambient coupling', 'Does electronics temperature explain the remaining shift?', 'Paired bridge and enclosure-temperature sequences.', 'Contrast thermal lag with simultaneous common-mode movement.', 'Stabilize the readout before adjusting the probe model.'],
             ['Reconnection trial', 'Is the transfer retained after transport?', 'Bench/deployed residual series and contact checks.', 'Use weighted evidence from independent stable windows.', 'Repeat a field check after every connector disturbance.'],
             ['Uncertainty statement', 'What limit can the evidence support?', 'Repeatability, reference and transfer-resolution records.', 'Separate response magnitude from a coverage statement.', 'Report a restricted use limit with its excluded influences.'],
             ['Release instructions', 'What should the receiving engineer verify first?', 'Final transfer constants, reference hold and eight-point field sequence.', 'Check the normalized deviation against the documented reference policy.', 'Release with a reproducible reconnect-and-hold procedure.'],
         ]),
]

def save():
    target = OUT / 'outlines.json'
    assert not target.exists()
    target.write_text(json.dumps(OUTLINES, indent=2) + '\n')
    lines = ['# Attempt 7 / formal round 1 — document purposes and outlines', '',
             'Only page 1 of each family is being authored/exported in this round. These outlines do not claim ten-page conformance.', '']
    for family in OUTLINES:
        lines.extend([f"## f{family['familyId']:04d} / {family['classId']}-{family['layoutId']}", '',
                      f"**Purpose:** {family['purpose']}", f"**Reader:** {family['audience']}",
                      f"**Genre:** {family['genre']}", f"**Main question:** {family['question']}",
                      f"**Evidence:** {family['evidence']}", '',
                      '| Page | Contribution | Question | Evidence | Analysis | Consequence |',
                      '|---:|---|---|---|---|---|'])
        for i, row in enumerate(family['pages'], 1):
            lines.append('| ' + ' | '.join([str(i)] + row) + ' |')
        lines.append('')
    (OUT / 'outlines.md').write_text('\n'.join(lines))
    (OUT / 'technical-reuse-declaration.json').write_text(json.dumps({
        'scope': 'three selected page-1 previews only', 'allowedStableTechnicalSpans': [],
        'rationale': 'No repeated technical leaves are needed across the three independently authored preview pages. Future within-family reuse needs its own prior declaration.',
        'reviewPolicy': 'Retain every shared eight-letter-token run and fivegram Jaccard >0.35; no cross-family automatic waiver.',
        'sourceLeakageGate': 'Unchanged; dirty-side source overlap and protected-name checks remain coordinator-owned and are not claimed here.'}, indent=2) + '\n')

if __name__ == '__main__':
    save()
