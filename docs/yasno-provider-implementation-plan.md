# Yasno Power Schedule Provider — Implementation Plan

## References

- [refactor-power-schedule.md](./refactor-power-schedule.md) — multi-provider architecture.
- `src/modules/yasno/docs/Yasno.postman_collection.json` — API reference (requests, responses).

## Goal

Implement Yasno schedule provider: periodically fetch schedule for a fixed address, normalize to `IScheduleItemHours`, detect changes, notify orchestrator. Same pattern as DTEK.

## API Overview

- **Base URL:** `https://app.yasno.ua`
- **Auth:** None (public API)
- **Defaults:** `regionId=25` (Kyiv), `dsoId=902` (DTEK Kyiv)

## Workflow

1. **Get streets** — `GET /api/blackout-service/public/shutdowns/addresses/v2/streets?regionId={region}&query={streetQuery}&dsoId={dso}`
   - Response: `[{ id: number, value: string }]` — pick first match by street name.
2. **Get houses** — `GET .../houses?regionId={region}&streetId={streetId}&query={buildingQuery}&dsoId={dso}`
   - Response: `[{ id: number, value: string }]` — pick first match by building.
3. **Get group** — `GET .../group?regionId={region}&streetId={streetId}&houseId={houseId}&dsoId={dso}`
   - Response: `{ group: number, subgroup: number }` — e.g. 36, 1 → key `"36.1"`.
4. **Planned outages** — `GET .../regions/{region}/dsos/{dso}/planned-outages`
   - Response: map `Record<string, GroupSchedule>`, key = `"${group}.${subgroup}"`.
5. **Build schedule** — from `groupSchedule["36.1"].today` / `.tomorrow`.

## Planned Outages Response Shape

```ts
Record<string, {
  today?: { slots: YasnoSlot[]; date: string; status: string };
  tomorrow?: { slots: YasnoSlot[]; date: string; status: string };
  updatedOn: string;
}>;

YasnoSlot = { start: number; end: number; type: "Definite" | "NotPlanned" };
```

- **Slots:** `start`/`end` = minutes from midnight (0–1440).
- **type:** `"Definite"` = no light (Off), `"NotPlanned"` = light (On).
- **status:** `"ScheduleApplies"` = real schedule; `"WaitingForSchedule"` = not yet (like DTEK "all yes") → skip.

## Normalization: Yasno Slots → IScheduleItemHours

- 48 half-hours: `h00_0` (0–30 min), `h00_1` (30–60), … `h23_1` (1380–1440).
- For each half-hour, take midpoint minute; find containing Yasno slot; `Definite` → `PowerState.Off`, `NotPlanned` → `PowerState.On`.
- Yasno has no `MaybeOff`; use `PowerState.MaybeOff` only if needed for edge cases (default to On).

## Group Key Mapping (DTEK ↔ Yasno)

- DTEK `sub_type_reason`: `"GPV36.1"` → group 36, subgroup 1.
- Yasno key: `"36.1"` (same mapping).

## Change Detection & Notifications

- Only notify when `status === "ScheduleApplies"` and slots are non-empty.
- Skip when `status === "WaitingForSchedule"` or slots empty (like DTEK all-yes).
- Skip when normalized hours are all On (schedule not published yet).
- Poll interval configurable (e.g. 15 min default).
- On change: `orchestrator.onScheduleChange('yasno', date, normalizedSchedule, updatedAt)`.

## Config

- `YASNO_REGION_ID` (default `25`)
- `YASNO_DSO_ID` (default `902`)
- `YASNO_STREET` (default `вул. Здановської Юлії`)
- `YASNO_BUILDING` (default `71/З` or `71З`)
- `YASNO_POLL_INTERVAL_MS` (default same as DTEK)

## File Layout

| File | Purpose |
|------|---------|
| `yasno-schedule.service.ts` | Implements `IPowerScheduleProvider`; poll loop; HTTP calls; normalize; notify orchestrator. |
| `yasno-normalize.helper.ts` | Convert Yasno slots (minutes + Definite/NotPlanned) → `IScheduleItemHours`. |
| Config | Add Yasno env vars. |

## Error Handling

- On any API error: log, notify bot owner, skip cycle; schedule next poll with `setTimeout`.
