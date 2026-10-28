# OMS-05: topology limits (input for FAT notes)

What the section trace, **Trace to source** and **Simulate opening** can and
cannot claim with the network data we have today. Code:
`backend/src/domain/networkGraph.js` (shared graph walk),
`sectionalize.js` (section trace), `supplyTrace.js` (upstream and what-if).
Endpoints: `GET /api/network/section/:mrid`, `GET /api/network/upstream/:mrid`,
`POST /api/network/whatif`.

## 1. What is inferred

The Haridwar graph is **inferred from GIS geometry**
(`infra/importHaridwarInferred.js`), not exported from a network model:

- Lines join where their ends lie within 10 m of another line (see the join
  rules below). Devices snap to the nearest line by their own position.
- Every mRID is synthetic (`LINE:`, `SW:`, `FUSE:`, `DT:`, `PT:`). Substation
  bus nodes are `CN:SS:<substation>`. The original GIS record is kept
  verbatim in `raw_attrs.original`, including `kva`.
- The result has 611 connected components. Only 10 contain a substation bus
  node. The other 601 are orphaned fragments with no path to any substation.

### Join rules (2026-10-27)

- **Node diameter cap (`NODE_MAX_SPAN_M` = 10 m).** Joins used to chain: A
  joined B and B joined C, so one node could span about 20 m (135 nodes were
  wider than 10 m). Now a line end joins a node only if it is within 10 m of
  every join point already in that node, so no node spans more than 10 m.
  Candidate joins are applied closest first, ties broken by mRID. The result
  does not depend on the order of the GIS file; shuffled input gives the same
  nodes.
- **Cross-feeder bare joins (`CROSS_FEEDER_BARE_JOIN_M` = 3 m).** A join
  between lines of different feeders with no device (switch, fuse, RMU, DT or
  PT) within 10 m is made only at 3 m or less. Beyond that it is not joined;
  it is recorded in `raw_attrs.join_candidates` with the reason, like the
  10–30 m candidates. Two feeders meeting with nothing at the junction are
  more often two lines drawn close together than a real tie point. This halved
  the bare cross-feeder nodes (342 to 141) with no component split and no
  switch changing behaviour.
- A re-import deletes this importer's own stale rows (for example, line pieces
  renamed because a line is now cut in fewer places) in the same transaction.
  It never touches other sources' rows. It refuses the whole run, naming the
  rows, if a stale row is still referenced by an incident, a switching step, a
  planned outage, the safety log, an asset scan or a protection asset.
- Every API response built on this data has `inferred: true` and an
  `inferredNote`, and the map shows it.

The Dehradun CIM import has no substation bus nodes (its energy source is not
connected). Trace to source therefore reports "no path to a substation in this
data" there, and a what-if needs an explicit `sourceMrid`.

## 2. Switch state is unknown; one-terminal switches separate nothing

- No source populates `Switch.normalOpen`, and the GIS open/closed attribute
  is too messy to trust (it is kept only as `raw_attrs.gis_inferred_state`).
  So:
  - the section trace treats every switch-class device (`SWITCH_CLASSES`) as
    a section boundary, not as a confirmed isolation point;
  - Trace to source lists every switch on the path with state `unknown`.
- Of the switches and fuses, only **332** sit in-line with two terminals.
  **1,941** sit at a line end with **one terminal**: they bound nothing in the
  graph, and opening them cuts nothing off. What-if reports these explicitly
  (`effective: false` with the reason) rather than returning an empty result
  that looks like a finding.
- Even the in-line ones rarely separate anything. Measured with what-if on
  every one of the 332, before the join rules above:
  - 179 are in orphaned fragments, so there is no default source (422);
  - 148 have another path around them: 33 are bridged in parallel by another
    device across the same cut, and 115 are bypassed through loops in the
    inferred graph. Each loop closes at one junction node; in 15 of them that
    node joins lines of different feeders, and in 71 it spans more than 3 m
    (line-end joins chained, so one node could span up to about 20 m);
  - only **5** actually cut devices off when opened.
- **After the join rules,** the same **5 of 332** are effective and lose
  exactly what they did before. 179 still have no source, 31 are parallel
  bypasses and 117 are loop bypasses. The cap removed the cross-feeder part of
  5 of the 15 cross-feeder loops (they now close at a same-feeder junction),
  but every one of those devices still has a bypass.
- **Why the remaining bypasses are not a join-rule error:** each remaining
  cross-feeder junction is about 0.2–2.2 m from the bypassed switch or fuse
  itself. A switch or fuse sitting where two feeders meet may well be a real
  tie point. The cross-feeder rule deliberately keeps joins that have a device
  next to them, so these stay joined. What-if reports them honestly as
  "another path exists in this data", not as a fault in the join rule. Only a
  vendor CIM export (real terminals and normally-open points) can settle
  which of them are real ties.
- Sections are often small because connectivity is missing. The map adds a
  note when a section has fewer than 10 members.

## 3. What-if baseline assumption

- The baseline is everything reachable from the source with **every switch
  treated as closed**. The result is the devices that lose supply compared
  with that baseline. It is a simulation on the model, never live state: the
  map shows a persistent "Simulation - not live state" banner.
- The default source is **one** substation bus node: the nearest by hops from
  the device. The response says it was chosen by inference and gives
  `alternateSourcesInComponent`. Several sources are used only when the caller
  passes them in `sourceMrid`. In the largest component, six substations are
  joined through 33 kV incomers. Treating them all as sources would hide real
  losses and could be fooled by a false join in the inferred graph.
- Distribution transformers are PowerTransformers that are not on a
  substation bus. Their kVA comes from the original `kva` attribute. When some
  have no kVA, the total is labelled a **lower bound** and the count of those
  without kVA is given.

## 4. What a vendor CIM export would improve

- **Real terminals on switches.** Every switch would have two terminals, so
  sections and what-if would cut where the network really does.
- **`normalOpen` / switch state.** Normally-open points would bound the
  baseline, so what-if would stop assuming everything is closed.
- **Energy sources connected to substation buses.** Trace to source would
  work everywhere, including Dehradun, without inferred `CN:SS:` nodes.
- **Real connectivity instead of geometric joins.** No orphaned fragments and
  no false joins, so `inferred` would be false and the honesty notes could be
  dropped.
- **kVA and phase data on every transformer.** The kVA total would no longer
  be a lower bound.
- **FaultIndicator / protection equipment.** The section trace could name the
  protection that operates.
