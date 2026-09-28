CONCEPT FROZEN — NOT SKELETON READY (blocked by Q2, Q3)

# Concept Contract — Modular box organizer

Concept `box-organizer`, revision 2, sha256:5a307a53092d8411c9a5766bce081b499e19d7534e4abf5f38e9afe3c96cf608.

**Intent.** Removable parallel divider frames held in eye pairs of a spring-fitted base frame on the floor of a storage box.

**Closed world.** Only the parts and features listed here exist.

## Parts

- BOX — BLOCK, REFERENCE, size [=box_L, =box_W, =box_H] (local x, y, z). Local x → world +X, y → +Y, z (normal) → +Z. Placed with its bottom centre at [0, 0, 0]. Intent: Storage box interior. Not produced.
- BASE — FRAME (open rectangular frame, bar =rail_w), PRODUCED, size [=frame_L, =frame_W, =rail_h] (local x, y, z). Local x → world +X, y → +Y, z (normal) → +Z. Placed with its bottom centre at [0, 0, 0]. Intent: Lies on the box floor. The spring sections in the short sides push the two long sides apart against the box long walls; that is the only retention.
- DIVIDER — FRAME (open rectangular frame, bar =div_bar), PRODUCED, size [=div_W, =div_H, =div_t] (local x, y, z). Local x → world +Y, y → +Z, z (normal) → +X. Placed only by its joint. Intent: Open rectangular frame (not a plate). Stands upright across the box width.

## Features

- BASE.SPRING_A — SPRING (INTEGRATED_FLEXURE) in edge +X (SHORT_A) of BASE, centred, span 40% of the edge; compliance ALONG_EDGE = world axis Y. Effect: changes the distance between BASE.+Y and BASE.-Y. Reacts against BOX:+Y, BOX:-Y.
- BASE.SPRING_B — SPRING (INTEGRATED_FLEXURE) in edge -X (SHORT_B) of BASE, centred, span 40% of the edge; compliance ALONG_EDGE = world axis Y. Effect: changes the distance between BASE.+Y and BASE.-Y. Reacts against BOX:+Y, BOX:-Y. Mirror of BASE.SPRING_A in local plane YZ.
- BASE.EYE_A — EYE on the INNER face of edge +Y (LONG_A) of BASE, protruding inward by its depth; bore axis = edge normal = world +Y (direction of insertion). Size bore =eye_bore, depth =eye_d. Repeated along the edge: pitch =eye_pitch, margin =eye_margin on the host face, count derived by the array rule, centred.
- BASE.EYE_B — EYE on the INNER face of edge -Y (LONG_B) of BASE, protruding inward by its depth; bore axis = edge normal = world -Y (direction of insertion). Size bore =eye_bore, depth =eye_d. Repeated along the edge: pitch =eye_pitch, margin =eye_margin on the host face, count derived by the array rule, centred. Mirror of BASE.EYE_A in local plane XZ, paired by index.
- DIVIDER.TAB_R — TAB on edge +X (RIGHT) of DIVIDER, flush with the -Y end (offset 0), pointing along the edge normal = world +Y (horizontal: yes). Size len =tab_len, w =tab_w, t =div_t.
- DIVIDER.TAB_L — TAB on edge -X (LEFT) of DIVIDER, flush with the -Y end (offset 0), pointing along the edge normal = world -Y (horizontal: yes). Size len =tab_len, w =tab_w, t =div_t. Mirror of DIVIDER.TAB_R in local plane YZ.

## Joints

- SEAT — INSERTS_INTO of DIVIDER: DIVIDER.TAB_R INSERTS_INTO BASE.EYE_A[i]; DIVIDER.TAB_L INSERTS_INTO BASE.EYE_B[i]. Index i: any valid eye pair; example configuration i = 4, 12, 20. Engage =tab_len - clear. DOF: UNRESOLVED (Q3). Fit SNUG. Assembly motion: UNRESOLVED (Q2). Anti-rotation: UNRESOLVED (Q3). Intent: A divider can be seated in any opposing eye pair; the user rearranges dividers.

## Rules

- R1 MUST: All dividers are parallel to each other.
- R2 MUST: Divider tabs are horizontal and point outward, away from the divider, towards the long sides.
- R3 MUST_NOT: No downward legs, feet or vertical insertion pins on the divider.
- R4 MUST_NOT: No crossing dividers, no perpendicular secondary dividers, no divider grid.
- R5 MUST: Dividers are open rectangular frames, not solid plates.
- R6 MUST: The short-side springs change the distance between the two long sides (across the frame width).

## Parameters

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

## OPEN — not mechanically defined

The intent is understood, but the mechanism is not fully defined. These questions stay open until the user answers them. No downstream tool or agent may resolve them.

### Q2 — UNRESOLVED (blocks SKELETON_READY)

A rigid divider with two outward tabs cannot simply enter two closed, opposing eyes. What mechanism allows insertion?

Concerns: SEAT, BASE.EYE_A, BASE.EYE_B, DIVIDER.TAB_L, DIVIDER.TAB_R
Example options (examples only, not defaults, not recommendations): compliant eye · compliant divider · open / slotted eye · temporary frame displacement · other, user-defined

### Q3 — UNRESOLVED (blocks SKELETON_READY)

The two tabs are coaxial (world Y), which leaves a rotational DOF about that axis. What prevents rotation, or is rotation explicitly acceptable?

Concerns: SEAT, DIVIDER, DIVIDER.TAB_L, DIVIDER.TAB_R
Example options (examples only, not defaults, not recommendations): explicit anti-rotation mechanism, user-defined · rotation is acceptable (explicit statement)

## Answered

- Q1: Along which axis do the short-side springs give? — Across the frame width (world Y): the springs change the distance between LONG_A and LONG_B. (user, architecture review 2026-09-28)
