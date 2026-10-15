# PFC feeder-wise power-quality KPIs

O&M requirement: monitor voltage and current indices per feeder, in addition to
SAIDI/SAIFI, for a user-definable period T (daily, weekly, monthly, quarterly,
yearly, custom). Each index is stored per phase with suffix `_R`, `_Y`, `_B` and
a total `_T`, except FLIF.

## Indices (requirement items a-q)

| # | Code | Meaning | Unit |
|---|------|---------|------|
| a | FVHI | Voltage high incidents | Nos |
| b | FVHD | Voltage high duration | min |
| c | FVLI | Voltage low incidents | Nos |
| d | FVLD | Voltage low duration | min |
| e | FCHI | Current high incidents | Nos |
| f | FCHD | Current high duration | min |
| g | FCLI | Current low incidents | Nos |
| h | FCLD | Current low duration | min |
| i | FVSM | Voltage sag magnitude, 24 h | % of nominal |
| j | FCSM | Current sag magnitude, 24 h | % of nominal |
| k | FVSV | Voltage stress = sum of (V - Vnom) x minutes while V > Vnom | V-min |
| l | FCSV | Current stress = sum of (I - Inom) x minutes while I > Inom | A-min |
| m | FMXV | Max voltage / nominal x 100 | % |
| n | FMNV | Min voltage / nominal x 100 | % |
| o | FMXC | Max current / nominal current x 100 | % |
| p | FMNC | Min current / nominal current x 100 | % |
| q | FLIF | Max phase load / min phase load x 100 (worst instant) | % |

## Data flow

```
SCADA analog adapter --> Kafka scada.analog.feeder --+
POST /api/telemetry/feeders -------------------------+--> feeder_telemetry (hypertable)
                                                            | nightly 00:20 IST
                                                            v
                                                     feeder_kpi_daily --> weekly..yearly
today (live, from feeder_telemetry) -----------------------------------> GET /api/analytics/feeder-kpi
```

Sample format: `{ feeder, ts, v_r, v_y, v_b, i_r, i_y, i_b, quality?, source? }`
(volts phase-to-neutral, amps; `feeder` is the GIS feeder code, e.g. `UPCL-JW-B`).
Only GOOD and SUBSTITUTED samples are used.

## Interpretation decisions (confirm with UPCL / PFC)

1. **FMXC / FMNC** divide by nominal *current* (the source text says "nominal voltage").
2. **FCSV** integrates current *above* nominal (the source text omits "above").
3. **_T (total)**: incidents/durations = any phase in breach; stress = R+Y+B;
   max = highest phase; min and sag = lowest phase.
4. **Voltage sag (FVSM)**: residual voltage between 10 % and `v_sag_pct` (90 %) of
   nominal, IEC 61000-4-30 style. Reported as the deepest residual. Empty = no sag.
5. **Current sag (FCSM)**: a drop of more than `i_sag_drop_pct` (30 %) against the
   previous sample. Reported as the deepest sagged current in % of nominal.
   SCADA scan rates cannot see sub-second sags; that needs PQ meters or relay records.
6. **De-energised feeder** (all three voltages < 10 % of nominal) is an interruption
   counted by SAIDI/SAIFI. Those minutes are excluded from every index here.
   Loss of a single phase is not an interruption and counts as low voltage.
7. **Gaps**: a sample holds until the next one, at most `FEEDER_KPI_MAX_GAP_MIN`
   (default 10). A longer gap adds no time and ends any running excursion.
8. **FLIF** skips instants with a phase at 0 A or a feeder below 5 % load. The period
   value is the worst instant; the average is shown beside it.
9. **Quarter / year** follow the Indian financial year (April start). Set
   `KPI_FY_START_MONTH=1` for calendar quarters/years. Weeks run Monday-Sunday.
10. **Defaults** (11 kV): 6350.85 V phase-to-neutral, 200 A, V band 90-110 %,
    current high 100 %, current low 10 %. Enter real values per feeder in `feeder_ratings`
    (`PUT /api/analytics/feeder-kpi/ratings/:feeder`). After changing a rating, recompute
    stored days: `POST /api/analytics/feeder-kpi/rollup {from, to}`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FEEDER_KPI_MAX_GAP_MIN` | 10 | longest gap a sample may hold |
| `KPI_FY_START_MONTH` | 4 | first month of the quarter/year cycle |
| `FEEDER_KPI_CRON` | `20 0 * * *` | nightly rollup (IST) |
| `FEEDER_TELEMETRY_RETENTION_DAYS` | 400 | raw sample retention (TimescaleDB) |
| `FEEDER_TELEMETRY_SIM` | on | `off` stops the synthetic feed (also off when `SIMULATOR=off`) |
| `FEEDER_SIM_BACKFILL_DAYS` | 7 | days of simulated history created at first start |

Turn the simulator off before connecting real SCADA, and clear its rows:
`DELETE FROM feeder_telemetry WHERE source = 'SIM';`

## Volume

61 feeders x 1 sample/min = about 88,000 rows/day (32 M/year). Comfortable for a
TimescaleDB hypertable; 1-5 minute polling from SCADA is enough.

## Tests

`npm run test:feederkpi` (pure maths, hand-worked examples).
