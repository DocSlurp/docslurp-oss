# Aurora Cells R&D — Memo: Silicon-anode pilot results (Cell AC-9)

**To:** Aurora Cells Executive Team, Program Steering Committee
**From:** Cell Development Group
**Project lead:** Dr. Tomasz Wilk
**Classification:** Internal – Confidential
**Subject:** Pilot results for AC-9 and recommendation for B-sample phase

---

## 1. Executive Summary

The AC-9 pilot program has met its principal technical objectives. AC-9 pairs a 15% silicon-carbon composite anode with an NMC-811 cathode, and the results show a meaningful step forward in energy density without sacrificing cycle life or manufacturability.

Key outcomes:

- **Energy density:** 312 Wh/kg at cell level, up from 268 Wh/kg on the previous AC-7 cell.
- **Durability:** 91.5% capacity retention after 800 cycles at 1C/1C, 25 °C.
- **Fast charge:** 10% to 80% state of charge in 14 minutes at 25 °C.
- **Swelling:** 3.1% at 800 cycles, within the 5% target.
- **Manufacturing:** pilot line yield improved from 82% to 94% after switching the slurry mixer.
- **Cost:** bill-of-materials estimate of $78 per kWh at 2 GWh/year scale.

On the basis of these results, the team recommends moving AC-9 to the B-sample phase in Q1 2027. Partner Velo Motors will test 40 B-sample modules in its e-bike platform.

---

## 2. Background and Objectives

Silicon offers a much higher theoretical specific capacity than graphite, but its large volume change during lithiation has historically caused particle cracking, unstable solid-electrolyte interphase (SEI) growth, and electrode swelling. These effects typically limit cycle life and complicate cell design.

The AC-7 cell established our baseline with a lower silicon content and delivered 268 Wh/kg. The AC-9 program set out to raise energy density substantially while holding four constraints:

1. Cycle life suitable for light-mobility and consumer applications.
2. Electrode and cell swelling within a 5% target at end of test.
3. Fast-charge capability without lithium-plating signatures.
4. A manufacturing process robust enough to support a credible cost model.

The work was led by Dr. Tomasz Wilk, with electrochemical testing performed at our test lab in Reno, Nevada.

---

## 3. Cell Design

### 3.1 Materials

| Component | AC-7 (baseline) | AC-9 (pilot) |
|---|---|---|
| Anode | Graphite-dominant blend with low silicon content | 15% silicon-carbon composite |
| Cathode | NMC-811 | NMC-811 |
| Electrolyte | Standard carbonate blend | Carbonate blend with SEI-stabilizing additives |
| Binder | Conventional | Elastic binder system tuned for silicon expansion |
| Cell-level energy density | 268 Wh/kg | 312 Wh/kg |

### 3.2 Design rationale

The silicon-carbon composite embeds silicon domains within a porous carbon matrix. The matrix provides void space that absorbs expansion internally, reducing particle-level stress and limiting the exposure of fresh silicon surface to electrolyte. We combined this with an elastic binder and an additive package intended to build a more flexible, stable SEI. NMC-811 was retained as the cathode for its high capacity, which complements the anode gains.

---

## 4. Results

### 4.1 Energy density

AC-9 reached 312 Wh/kg at cell level, compared with 268 Wh/kg for AC-7. This is a substantial improvement and brings the cell into a competitive range for premium light-mobility and portable applications. Gains came mainly from the higher-capacity anode, with supporting contributions from tighter electrode loading control.

### 4.2 Cycle life

Cells were cycled at 1C/1C at 25 °C. After 800 cycles, AC-9 retained 91.5% of initial capacity. Fade was gradual and smooth, with no sudden-death behavior or abrupt knee observed in the tested cells. Coulombic efficiency stabilized early, which is consistent with a stable SEI.

### 4.3 Fast charge

AC-9 charged from 10% to 80% state of charge in 14 minutes at 25 °C. Post-test teardown of fast-charged cells showed no visible lithium plating on the anode surface, indicating that the electrode architecture and electrolyte system support high-rate charging at this condition.

### 4.4 Swelling

Cell swelling at 800 cycles measured 3.1%, comfortably within the 5% target. This is a key de-risking result because swelling has been the main failure pathway for silicon-containing designs. It supports the view that the composite structure and binder system are managing volume change effectively at the 15% silicon level.

### 4.5 Summary table

| Metric | Target / Reference | AC-9 Result | Status |
|---|---|---|---|
| Cell-level energy density | Exceed AC-7 (268 Wh/kg) | 312 Wh/kg | Met |
| Capacity retention (1C/1C, 25 °C) | Strong retention at 800 cycles | 91.5% after 800 cycles | Met |
| Fast charge (25 °C) | Rapid mid-range charging | 10%–80% SOC in 14 min | Met |
| Swelling at 800 cycles | ≤ 5% | 3.1% | Met |
| Pilot line yield | Improve on prior yield | 94% (from 82%) | Met |
| BOM cost estimate | Competitive at scale | $78/kWh at 2 GWh/year | On track |

---

## 5. Manufacturing and Yield

Early AC-9 builds were affected by variability in slurry quality, particularly in dispersing the silicon-carbon composite and the elastic binder uniformly. This showed up as coating inconsistencies and a higher rate of rejected electrodes and cells. Pilot line yield was 82% in this period.

After we switched the slurry mixer, dispersion consistency improved markedly, coating uniformity tightened, and pilot line yield rose from 82% to 94%. The change was low-cost relative to its impact and is directly transferable to larger-scale production planning. We view this as an important indicator that AC-9 is not only a laboratory success but a process that can be run reliably.

Remaining manufacturing priorities include:

- Continued monitoring of slurry viscosity and solids content across batches.
- Calendering parameter optimization to protect composite particle integrity.
- Inline inspection to catch coating defects earlier in the process.

---

## 6. Cost Assessment

Our bill-of-materials cost estimate for AC-9 is $78 per kWh at 2 GWh/year scale. The estimate reflects current supplier quotations for the silicon-carbon composite, NMC-811, electrolyte additives, and the elastic binder, together with the improved yield assumptions supported by the pilot line results.

The principal sensitivities are the price of the silicon-carbon composite, which should decline with volume, and cathode material pricing. Because higher energy density reduces the material required per kWh across inactive components such as foil, separator, and housing, the design benefits from a favorable cost structure relative to lower-density alternatives. We will refine the model as B-sample supplier quotations are finalized.

---

## 7. Risk Review

| Risk | Assessment | Mitigation |
|---|---|---|
| Long-term swelling growth beyond tested cycle range | Low to moderate; 3.1% at 800 cycles gives margin to the 5% target | Extend cycling; track thickness growth trend in B-sample cells |
| Performance in non-ambient temperatures | Not yet fully characterized in this pilot | Add low- and high-temperature test matrices in B-sample phase |
| Composite supply scaling | Moderate | Qualify a second supplier; negotiate volume terms |
| Process transfer from pilot to larger line | Low to moderate | Document mixer settings; run transfer trials |
| Module-level integration | Not yet validated in field-like use | Partner testing with Velo Motors |

---

## 8. Partner Validation

Velo Motors, our development partner, will test 40 B-sample modules in its e-bike platform. This program will give us real-world feedback on vibration tolerance, thermal behavior in enclosed packs, charging patterns, and usage profiles that differ from laboratory protocols. E-bikes are a well-matched first application: they value energy density and fast charging, and their pack sizes suit an early-volume ramp.

We will agree on data-sharing arrangements and a shared test plan with Velo Motors ahead of module delivery.

---

## 9. Recommendation and Next Steps

The AC-9 pilot has delivered on energy density, cycle life, fast-charge performance, swelling control, yield, and cost trajectory. The team recommends moving AC-9 to the B-sample phase in Q1 2027.

Proposed next steps:

1. **Approve B-sample phase entry** for Q1 2027.
2. **Finalize the B-sample build plan**, including documented slurry mixer settings and process controls.
3. **Expand the test matrix** at the Reno, Nevada test lab to cover temperature extremes, extended cycling, and abuse testing.
4. **Prepare 40 modules** for Velo Motors and agree on the joint test protocol.
5. **Secure supply** by qualifying an additional silicon-carbon composite source.
6. **Update the cost model** with B-sample quotations and report back to the steering committee.

---

## 10. Acknowledgments

Thanks to Dr. Tomasz Wilk and the cell development, process engineering, and Reno test lab teams for their work in bringing AC-9 to this milestone. Their effort on both the materials system and the slurry process change was central to these results.

*End of memo.*
