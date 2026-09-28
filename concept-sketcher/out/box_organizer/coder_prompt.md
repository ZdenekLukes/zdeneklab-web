CONCEPT FROZEN — NOT SKELETON READY (blocked by Q2, Q3)

# Coder Prompt — parametric skeleton for "box-organizer" rev 2

Inputs: this prompt and `box_organizer.aiconcept` (the source of truth, sha256:5a307a53092d8411c9a5766bce081b499e19d7534e4abf5f38e9afe3c96cf608). Read both. Do not use any other source.

## 1. Task

Write `skeleton.mjs`: an ES module with no dependencies exporting `build(params = {}, config = {})`, which returns the SKELETON REPORT of §8 for this concept.
- `params`: overrides for parameters that have a literal `value`. Derived parameters (`expr`) are recomputed from them.
- `config.dividers`: list of eye-pair indices at which DIVIDER instances are seated. Default = the model's example configuration [4, 12, 20].
- `build` must be deterministic and must compute everything from the parameters and the rules below. Do not hard-code resolved numbers.
Also write `QUESTIONS.md` (§9).
This is a skeleton: part frames, extents and feature poses. No meshes, no fillets, no print or production detail.

## 2. Closed world

Only the parts and features listed in the `.aiconcept` exist. Do not add legs, feet, pins, ribs, clips, slots, keys, flex cuts, extra or perpendicular dividers, or any other geometry or attribute.
Every object and feature you output carries its concept ID (grammar in §8). If something seems missing, write it in QUESTIONS.md — never design it.

## 3. Maturity and OPEN questions

The concept is CONCEPT_FROZEN. It is NOT skeleton-ready: Q2, Q3 are UNRESOLVED.
You MUST NOT resolve them, pick or default any option, or add any geometry or attribute that implements an answer. Build only what is defined.
Tag every element named in a question's `about` list with `unresolved: [<question id>, …]` and report the question as UNRESOLVED.
An `about` entry `<PART>` covers every object of that part (e.g. every `<PART>@i`); `<PART>.<FEATURE>` covers every instance of that feature (`[k]` and `@i`). A joint id (e.g. SEAT) has no element of its own in the report.
Report `maturity` exactly as given; never claim SKELETON_READY.

### Q2 — UNRESOLVED (blocks SKELETON_READY)

A rigid divider with two outward tabs cannot simply enter two closed, opposing eyes. What mechanism allows insertion?

Concerns: SEAT, BASE.EYE_A, BASE.EYE_B, DIVIDER.TAB_L, DIVIDER.TAB_R
Example options (examples only, not defaults, not recommendations): compliant eye · compliant divider · open / slotted eye · temporary frame displacement · other, user-defined

### Q3 — UNRESOLVED (blocks SKELETON_READY)

The two tabs are coaxial (world Y), which leaves a rotational DOF about that axis. What prevents rotation, or is rotation explicitly acceptable?

Concerns: SEAT, DIVIDER, DIVIDER.TAB_L, DIVIDER.TAB_R
Example options (examples only, not defaults, not recommendations): explicit anti-rotation mechanism, user-defined · rotation is acceptable (explicit statement)

## 4. How to read the .aiconcept (semantics)

- Units mm. World right-handed, +Z up, origin = BOX floor centre.
- Part local frame: origin at the centre of the part's box; local x, y, z extents = `size[0]`, `size[1]`, `size[2]` (z = thickness / normal).
- `orient {z, y}`: world directions of local z and local y; local x = y × z (right-handed).
- `place {at, anchor: BOTTOM_CENTRE}`: `at` is the world position of the bottom centre of the part's world-aligned box.
- Edges of a rectangular / FRAME profile: `+X -X +Y -Y` in local coordinates; the edge normal points outward along that axis; the edge "runs" along the other in-plane axis.
- FRAME: open rectangle with bar width `bar`. On edge e the OUTER face is at size/2 from the centre, the INNER face at size/2 − bar. INNER face length = size[run] − 2·bar; outer edge length = size[run].
- TAB: sits on the outer edge and extends outward along the edge normal by `len`. `at.from` names the end of the edge it is flush with (offset from that end). Cross-section: `w` along the edge, `t` along the part's local z, centred at local z = 0. Report its tip-face centre.
- EYE with `face: INNER`: protrudes inward from the inner face by `depth`. Mouth (entry point on the bore axis) = inner face − depth·normal. Bore axis = the edge normal (direction of insertion), diameter `bore`. `z: MID` = local z 0.
- SPRING: integrated section of the host bar, centred (`at: MID`) on the bar centre line (size/2 − bar/2 from the centre), span = percentage of the outer edge length. `compliance: ALONG_EDGE` = along the edge's run axis; `EDGE_NORMAL` = along its normal. Report `compliance_axis` as the unsigned world axis letter.
- `mirror {of, plane}`: copy of `of` reflected in the part-local plane (YZ flips local x, XZ flips local y). `pair_by_index`: instance k pairs with instance k of `of`.
- **Array rule** (the only rule for patterns): face_len = length of the host face; usable = face_len − 2·margin; count = floor(usable / pitch + 1e-9) + 1; position_k = (k − (count − 1)/2)·pitch along the edge, k = 0 … count − 1. Instance IDs `<PART>.<FEATURE>[k]`.
- Parameters: literal `value` or `expr` over other parameters.
- Joint INSERTS_INTO with an index variable: one instance `<PART>@i` per configured i. Placement only translates the part (orientation always comes from `orient`): the tip centre of link 1's male feature = link 1's female mouth + engage · (female bore axis). Every further link must then coincide the same way.
- Resolution state INSTALLED: `frame_W` is the installed width; `frame_W_free` is the relaxed width. Geometry uses the installed state; report both parameters.

## 5. Parameters

| name | value | status | note |
|---|---|---|---|
| box_L | 300 | fixed | measured box interior length |
| box_W | 200 | fixed | measured box interior width |
| box_H | 80 | rough |  |
| preload | 2 | rough | free frame is wider than the box; springs compress it on installation |
| frame_L | = box_L - 2 | derived | clearance to end walls |
| frame_W_free | = box_W + preload | derived | distance between long sides, springs relaxed |
| frame_W | = box_W | derived | installed: long sides bear on the box long walls |
| rail_w | 8 | rough |  |
| rail_h | 6 | rough |  |
| eye_pitch | 10 | target |  |
| eye_margin | 20 | rough | from each inner corner of the long side, measured on the inner face |
| eye_d | 4 | rough | eye depth, protrudes inward from the rail |
| eye_bore | 5 | rough | must admit the tab cross-section tab_w x div_t |
| div_H | 60 | rough |  |
| div_bar | 5 | rough |  |
| div_t | 3 | rough |  |
| tab_len | 4 | rough |  |
| tab_w | 3 | rough |  |
| clear | 0.5 | rough |  |
| div_W | = frame_W - 2*rail_w - 2*eye_d - 2*clear | derived | derived from the installed width |

## 6. Parts, features, joints

- BOX — BLOCK, REFERENCE, size [=box_L, =box_W, =box_H] (local x, y, z). Local x → world +X, y → +Y, z (normal) → +Z. Placed with its bottom centre at [0, 0, 0]. Intent: Storage box interior. Not produced.
- BASE — FRAME (open rectangular frame, bar =rail_w), PRODUCED, size [=frame_L, =frame_W, =rail_h] (local x, y, z). Local x → world +X, y → +Y, z (normal) → +Z. Placed with its bottom centre at [0, 0, 0]. Intent: Lies on the box floor. The spring sections in the short sides push the two long sides apart against the box long walls; that is the only retention.
- DIVIDER — FRAME (open rectangular frame, bar =div_bar), PRODUCED, size [=div_W, =div_H, =div_t] (local x, y, z). Local x → world +Y, y → +Z, z (normal) → +X. Placed only by its joint. Intent: Open rectangular frame (not a plate). Stands upright across the box width.
- BASE.SPRING_A — SPRING (INTEGRATED_FLEXURE) in edge +X (SHORT_A) of BASE, centred, span 40% of the edge; compliance ALONG_EDGE = world axis Y. Effect: changes the distance between BASE.+Y and BASE.-Y. Reacts against BOX:+Y, BOX:-Y.
- BASE.SPRING_B — SPRING (INTEGRATED_FLEXURE) in edge -X (SHORT_B) of BASE, centred, span 40% of the edge; compliance ALONG_EDGE = world axis Y. Effect: changes the distance between BASE.+Y and BASE.-Y. Reacts against BOX:+Y, BOX:-Y. Mirror of BASE.SPRING_A in local plane YZ.
- BASE.EYE_A — EYE on the INNER face of edge +Y (LONG_A) of BASE, protruding inward by its depth; bore axis = edge normal = world +Y (direction of insertion). Size bore =eye_bore, depth =eye_d. Repeated along the edge: pitch =eye_pitch, margin =eye_margin on the host face, count derived by the array rule, centred.
- BASE.EYE_B — EYE on the INNER face of edge -Y (LONG_B) of BASE, protruding inward by its depth; bore axis = edge normal = world -Y (direction of insertion). Size bore =eye_bore, depth =eye_d. Repeated along the edge: pitch =eye_pitch, margin =eye_margin on the host face, count derived by the array rule, centred. Mirror of BASE.EYE_A in local plane XZ, paired by index.
- DIVIDER.TAB_R — TAB on edge +X (RIGHT) of DIVIDER, flush with the -Y end (offset 0), pointing along the edge normal = world +Y (horizontal: yes). Size len =tab_len, w =tab_w, t =div_t.
- DIVIDER.TAB_L — TAB on edge -X (LEFT) of DIVIDER, flush with the -Y end (offset 0), pointing along the edge normal = world -Y (horizontal: yes). Size len =tab_len, w =tab_w, t =div_t. Mirror of DIVIDER.TAB_R in local plane YZ.
- SEAT — INSERTS_INTO of DIVIDER: DIVIDER.TAB_R INSERTS_INTO BASE.EYE_A[i]; DIVIDER.TAB_L INSERTS_INTO BASE.EYE_B[i]. Index i: any valid eye pair; example configuration i = 4, 12, 20. Engage =tab_len - clear. DOF: UNRESOLVED (Q3). Fit SNUG. Assembly motion: UNRESOLVED (Q2). Anti-rotation: UNRESOLVED (Q3). Intent: A divider can be seated in any opposing eye pair; the user rearranges dividers.

## 7. Rules

- R1 MUST: All dividers are parallel to each other.
- R2 MUST: Divider tabs are horizontal and point outward, away from the divider, towards the long sides.
- R3 MUST_NOT: No downward legs, feet or vertical insertion pins on the divider.
- R4 MUST_NOT: No crossing dividers, no perpendicular secondary dividers, no divider grid.
- R5 MUST: Dividers are open rectangular frames, not solid plates.
- R6 MUST: The short-side springs change the distance between the two long sides (across the frame width).

Answered Q1: Along which axis do the short-side springs give? — Across the frame width (world Y): the springs change the distance between LONG_A and LONG_B.

## 8. SKELETON REPORT (exact format)

```text
{ concept: string, revision: number, maturity: "CONCEPT_FROZEN" | "SKELETON_READY",
  params: { <every parameter of the model>: number },            // evaluated
  objects: [ {
      id,          // part id, or "<PART>@<i>" for indexed joint instances
      part,        // model part id
      kind, role,  // as in the model
      origin,      // [x,y,z] world centre of the part box
      axes,        // { x, y, z }: world axis names ("+X" … "-Z") of local x, y, z
      size,        // [x,y,z] local extents
      bar?,        // FRAME only
      index?,      // joint index for indexed instances
      features: [ {
          id,             // "<PART>.<FEATURE>" | "<PART>.<FEATURE>[k]" | "<PART>@<i>.<FEATURE>"
          type,           // TAB | EYE | SPRING
          position,       // TAB: tip-face centre; EYE: mouth centre; SPRING: span centre on the bar centre line
          direction?,     // TAB: world axis name
          bore_axis?,     // EYE: world axis name, direction of insertion
          compliance_axis?, // SPRING: "X" | "Y" | "Z"
          size,           // TAB {len,w,t} | EYE {bore,depth} | SPRING {length}
          pair?,          // EYE: id of the paired eye
          unresolved?     // [question ids]
      } ],
      unresolved?  // [question ids]
  } ],
  questions: [ { id, status: "UNRESOLVED" | "ANSWERED", about: [ids as in the model] } ] }
```

No other keys are allowed at any level. The REFERENCE part BOX is included as an object with no features.

## 9. QUESTIONS.md

List anything you found unclear or missing, and restate the UNRESOLVED questions. You may note ideas, but none may appear in the report or in the geometry.

## 10. Acceptance tests (run by an external checker)

The checker calls `build` three times: (a) defaults; (b) params `{ box_W: 250, eye_pitch: 12 }`; (c) config `{ dividers: [0, 24] }`. Every run must pass all of:
- C1 objects are exactly BOX (REFERENCE), BASE and one DIVIDER@i per configured index.
- C2 closed world: every id exists in the model, feature types only TAB/EYE/SPRING, complete feature sets, no extra keys or invented elements.
- C3 TAB_L points -Y, TAB_R +Y; no DIVIDER feature points -Z; every DIVIDER has normal ±X; all parallel.
- C4 springs on both short sides, compliance axis Y; frame_W_free and frame_W both reported and correct.
- C5 eyes follow the array rule; paired by index; bore axis ±Y; mouths on the inner faces.
- C6 each divider is placed by the joint rule and both tab tips lie inside their paired eye bores (axially and radially).
- C7 DIVIDER is an open frame.
- C8 maturity CONCEPT_FROZEN; Q2, Q3 UNRESOLVED; every element in their `about` lists tagged; nothing selects an option.

## 11. Reference values for the defaults (self-check)

- BASE.EYE_A: 25 eyes, first at x = -120, last at x = 120.
- DIVIDER@4: origin [-80, 0, 31.5], axes x +Y, y +Z, z +X.
- DIVIDER@12: origin [0, 0, 31.5], axes x +Y, y +Z, z +X.
- DIVIDER@20: origin [80, 0, 31.5], axes x +Y, y +Z, z +X.
