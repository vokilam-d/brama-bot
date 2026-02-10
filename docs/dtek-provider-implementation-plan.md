# DTEK Power Schedule Provider — Implementation Plan

This document is a **plan only**. It describes steps and design for implementing the DTEK provider; it does not implement code.

## References

- [refactor-power-schedule.md](./refactor-power-schedule.md) — multi-provider architecture, orchestrator, normalized schedule.
- `src/modules/dtek/DTEK.postman_collection.json` — API reference (getHomeNum, Get HTML, URLs, headers, body).
- `src/modules/dtek/DisconSchedule.js` — snapshot of the `DisconSchedule` global from the DTEK shutdowns page (structure of `preset`, `fact`, `time_zone`, schedule keys).
- `src/modules/dtek/discon-schedule.script.js` — page script: `DisconSchedule.ajax.send()`, `getHomeNum` / `getHomeNumInvisibly`, form serialization, use of `fact.data`, `preset.time_zone`.

## Goal

Implement the DTEK schedule provider so that:

1. The app periodically fetches the schedule for a fixed address (street + building) from DTEK.
2. Schedule is obtained **from inside a real browser context** (Puppeteer) so DTEK’s bot checks (cookies, CSRF, etc.) are satisfied.
3. For **today** and **tomorrow**, the provider detects new or changed schedule and notifies the **Power Schedule Orchestrator** with a normalized schedule; the orchestrator continues to apply “most recent wins” and single send per date.

Target address (configurable later):

- **Street:** вул. Здановської Юлії
- **Building:** 71/З

---

## 1. High-level flow

1. **Puppeteer**: Open DTEK shutdowns page `https://www.dtek-kem.com.ua/ua/shutdowns` and let it load (HTML, cookies, CSRF, and the in-page `DisconSchedule` global).
2. **From page context**: Call the same API the site uses — **getHomeNum** — with street + building (and optionally `updateFact` from previous response). Prefer reusing `DisconSchedule.ajax` / `DisconSchedule.send()`-style flow so the request is sent by the page (same origin, cookies, headers).
3. **Parse response**: From getHomeNum response get building info for `71/З` → read `sub_type_reason` (e.g. `["GPV26.1"]`). Use the first (or only) group key, e.g. `GPV26.1`.
4. **Schedule source**: Schedule for today/tomorrow lives in `DisconSchedule.fact.data` (or in the getHomeNum response if it returns `fact`). Structure: `fact.data[<date_timestamp_sec>][<groupKey>][<slot_id>]` with slot IDs `"1"`–`"24"` (hour slots 00–01 … 23–24) and values `"yes"` | `"no"` | `"maybe"` | `"first"` | `"second"` | `"mfirst"` | `"msecond"`.
5. **Normalize**: Map DTEK hour-slots and values to the shared `IScheduleItemHours` (half-hour keys `h00_0` … `h23_1`, `PowerState`: On / MaybeOff / Off).
6. **Change detection**: Keep last known normalized schedule (and optionally `fact.update` / timestamp) per date; on each poll, if today or tomorrow schedule changed (or is new), call `orchestrator.onScheduleChange('dtek', date, normalizedSchedule, updatedAt)`.
7. **On-demand**: `DtekScheduleService.getScheduleForDate(date)` can use the same Puppeteer + getHomeNum + fact.data path to return a normalized schedule when the orchestrator asks (e.g. when store is empty); optional for first iteration.

---

## 2. DTEK API and page (from Postman + script)

- **Shutdowns page (HTML):** `GET https://www.dtek-kem.com.ua/ua/shutdowns`
  - Delivers the page that defines the global `DisconSchedule` and contains `<meta name="ajaxUrl" content="/ua/ajax" />`.
- **AJAX base:** Same origin → `https://www.dtek-kem.com.ua/ua/ajax`.
- **getHomeNum (shutdowns):**
  - **Method:** POST (script uses `$.post`).
  - **URL:** `https://www.dtek-kem.com.ua/ua/ajax`.
  - **Body (form):** `method=getHomeNum` and form array, e.g.:
    - `data[0][name]=street`, `data[0][value]=вул. Здановської Юлії`
    - `data[1][name]=house_num`, `data[1][value]=71/З`
    - Optional: `data[2][name]=updateFact`, `data[2][value]=<fact.update from previous response>`
  - **Headers:** Same as in Postman (Origin, Referer, Content-Type, X-Requested-With: XMLHttpRequest, X-CSRF-Token from page, Cookie from browser).
- **Important:** Do **not** call the AJAX endpoint directly from Node; DTEK checks for bots. All getHomeNum calls must be made **from inside the loaded page** (e.g. via `page.evaluate` or by driving the page’s existing `DisconSchedule.ajax` / form and reading the result).

---

## 3. Sending getHomeNum from the page

Options:

- **Option A — Use `DisconSchedule.ajax` in page:**
  - In Puppeteer: load shutdowns page (so `DisconSchedule` and its `ajax` are defined).
  - Ensure the form exists and set `#street` and `#house_num` (and optional hidden `updateFact`) to the desired values, then call the same path the site uses for “get home numbers” (e.g. `DisconSchedule.ajax.obj.method = 'getHomeNum'; DisconSchedule.ajax.obj.data = DisconSchedule.form.serializeArray(); DisconSchedule.ajax.send(success, failure)`).
  - In the success callback, expose the full response (and optionally `DisconSchedule.fact` / `DisconSchedule.preset` if they are updated by the response) back to Node (e.g. via a Promise passed to `page.evaluate` or via `exposeFunction` + global variable).
- **Option B — Build POST in page and use `fetch`:**
  - In `page.evaluate`, build the same POST body and call `fetch(ajaxUrl, { method: 'POST', body, headers })`. This still runs in the page context (cookies, origin, CSRF from page).
  - Prefer Option A if it matches the site’s behavior exactly and avoids subtle differences in body/headers.

Recommendation: **Option A** — reuse `DisconSchedule.ajax.send()` (or the same flow the script uses for getHomeNum) so request shape and cookies/CSRF are identical to the real site.

---

## 4. getHomeNum response and building → group key

- Response is JSON: `result`, `data`, and optionally `fact`, `preset`, `showTableFact`, `updateTimestamp`, etc.
- **Building lookup:** `response.data["71/З"]` (or whatever building key is used) gives an object with at least:
  - `sub_type_reason`: array of group keys, e.g. `["GPV26.1"]`.
- **Schedule group:** Use the first element of `sub_type_reason` as the schedule group key (e.g. `GPV26.1`). If `sub_type_reason` is empty or missing, the building has no schedule → no schedule to report for that address.
- If the API returns `fact` in the same response, use it; otherwise the page may have already set `DisconSchedule.fact` from a previous request — in that case read from the global after the getHomeNum success callback.

---

## 5. Schedule data: `fact.data` and date keys

- **Date key:** Script uses `fact.today` (Unix seconds for “today” at midnight in the site’s timezone) and builds keys as `(day.valueOf() / 1000).toString()` for today and tomorrow. So `fact.data` is keyed by **start-of-day timestamp in seconds** (as string).
- **Structure:**
  `fact.data[<dateKey>][<groupKey>]` is an object with keys `"1"` … `"24"` (hour slots).
  Values: `"yes"` (light), `"no"` (no light), `"maybe"`, `"first"`, `"second"`, `"mfirst"`, `"msecond"` (first/second half of hour).
- **Today / tomorrow:**
  - Today key: from `fact.today` (or equivalent).
  - Tomorrow key: same day + 1 day, then `(day.valueOf() / 1000).toString()`.
- **No data yet case:** If every slot for a date is `"yes"` (as happens for tomorrow before DTEK publishes the schedule), treat that date as “no schedule yet” and skip notifying the orchestrator until any slot changes.

---

## 6. DTEK → normalized schedule (half-hour, PowerState)

- **Shared type:** `IScheduleItemHours`: keys `h00_0`, `h00_1`, … `h23_1`; values `PowerState` (On = 0, MaybeOff = 1, Off = 2).
- **DTEK slots:** `"1"` = 00:00–01:00, `"2"` = 01:00–02:00, … `"24"` = 23:00–24:00. So DTEK slot `n` (1–24) maps to hour `n - 1` (0–23).
- **Mapping one DTEK hour to two half-hours:**
  - `"yes"` → both half-hours `On`.
  - `"no"` → both `Off`.
  - `"maybe"` → both `MaybeOff`.
  - `"first"` → first half `Off`, second half `On`.
  - `"mfirst"` → first half `MaybeOff`, second half `On`.
  - `"second"` → first half `On`, second half `Off`.
  - `"msecond"` → first half `On`, second half `MaybeOff`.
- **Key mapping:** DTEK slot `"1"` → `h00_0`, `h00_1`; slot `"2"` → `h01_0`, `h01_1`; … slot `"24"` → `h23_0`, `h23_1`. Build a full `IScheduleItemHours` object (all 48 slots) for each date.

---

## 7. Change detection and notifying the orchestrator

- **Store:** Keep in memory (or a small schema) the last normalized schedule (and optionally a hash or `fact.update`) per date (today, tomorrow) for the configured address.
- **Poll loop:** Periodically (e.g. every 15–30 minutes, align with “limitUpdateTime” if desired):
  1. Run Puppeteer flow: load page → getHomeNum(street, building) from page.
  2. From response (or updated `DisconSchedule.fact`), get `fact.data` for today and tomorrow keys and the chosen `groupKey`.
  3. For each date that has data, build normalized `INormalizedSchedule` (date + hours). If the 24 slots are all `"yes"` (i.e. normalized hours are entirely `PowerState.On`), skip the date because DTEK has not published that schedule yet.
  4. Compare with the last stored non-all-`On` schedule for that date (e.g. deep compare hours, or compare a hash). If different or first time, call `orchestrator.onScheduleChange(PowerScheduleProviderId.Dtek, date, normalizedSchedule, updatedAt)`. Use `updatedAt` from `fact.update` if available and parseable, else `new Date()`.
  5. Update the “last seen” store.
- **Edge cases:** If getHomeNum fails (e.g. bot block, network), log and skip this cycle; do not notify. If `sub_type_reason` is empty, do not notify schedule for that building. If `fact.data` has no entry for today/tomorrow key, treat as “no schedule” for that date (optional: still notify with all-On or a dedicated “no schedule” representation if the orchestrator supports it; otherwise skip).

---

## 8. Config and address

- Add config (e.g. env or `config.ts`) for:
  - **DTEK_STREET** (default: `вул. Здановської Юлії`).
  - **DTEK_BUILDING** (default: `71/З`).
  - Optional: **DTEK_POLL_INTERVAL_MS**, **DTEK_PUPPETEER_HEADLESS**, etc.
- Keep these in sync with the values used in the Postman collection for testing.

---

## 9. DtekScheduleService (existing stub)

- **getId():** Already returns `PowerScheduleProviderId.Dtek`; keep as is.
- **Polling + orchestrator:** Implement the periodic loop in `DtekScheduleService` (or a dedicated helper used by it). On change, inject `PowerScheduleOrchestratorService` and call `onScheduleChange(...)`.
- **getScheduleForDate(date):** Optional for v1: implement by running the same Puppeteer + getHomeNum flow, then reading `fact.data` for the requested date and normalizing. If no data for that date, return `null`. This allows the orchestrator to ask DTEK when the store has no entry for a given day.

---

## 10. Dependencies and runtime

- **Puppeteer:** Add `puppeteer` (or `puppeteer-core` + configurable executable) to run a real browser. Consider running in headless mode and with a small timeout to avoid hanging.
- **Browser lifecycle:** Reuse one browser/page per poll or create per request; balance between “fresh session” (clean cookies) and performance. If DTEK is sensitive to session reuse, prefer a new page (or new browser) per poll.
- **Errors:** Timeouts, navigation errors, or missing `DisconSchedule` on the page should be logged and not crash the app; other providers and the orchestrator keep working.

---

## 11. File / module layout (suggested)

| Item | Purpose |
|------|--------|
| `dtek-schedule.service.ts` | Implements `IPowerScheduleProvider`; owns poll loop, calls orchestrator on change; optionally implements `getScheduleForDate` via same fetch path. |
| `dtek-normalize.helper.ts` (or inline) | Map DTEK `fact.data[dateKey][groupKey]` (slots "1"–"24", values yes/no/maybe/first/second/…) → `IScheduleItemHours` + `PowerState`. |
| `dtek-puppeteer.helper.ts` or `dtek-browser.service.ts` | Encapsulate: launch/load shutdowns page, run getHomeNum from page (Option A), return raw response (and optionally fact/preset). |
| Config | Add DTEK_STREET, DTEK_BUILDING (and optional poll/headless) to config and use in service. |
| `dtek.module.ts` | Register service; import PowerScheduleModule (or inject orchestrator) so `onScheduleChange` can be called. |

No change to the orchestrator contract or to the shared `IScheduleItemHours` / `PowerState`; DTEK only produces normalized schedules.

---

## 12. Implementation order (suggested)

1. **Config:** Add DTEK address and optional poll/headless settings.
2. **Normalize helper:** Implement DTEK slot/value → `IScheduleItemHours` (unit-testable with mock `fact.data`).
3. **Puppeteer helper:** Load shutdowns page; from page context call getHomeNum (Option A) and return response (and fact if needed). Verify with street + building 71/З that response contains `data["71/З"]` and `sub_type_reason`, and that `fact` or global `DisconSchedule.fact` has `data` for today/tomorrow.
4. **DtekScheduleService:** Wire config + Puppeteer helper + normalize helper; implement poll loop and “last seen” comparison; call `orchestrator.onScheduleChange('dtek', date, normalizedSchedule, updatedAt)` on change.
5. **Optional:** Implement `getScheduleForDate(date)` using the same fetch path for on-demand schedule.
6. **Integration:** Run app, confirm DTEK provider runs without error and that orchestrator receives notifications when schedule changes (manual test or short poll interval).
7. **Docs / README:** Note DTEK address config and Puppeteer requirement (e.g. Chrome/Chromium).

---

## 13. Summary

- Use **Puppeteer** to load `https://www.dtek-kem.com.ua/ua/shutdowns` and send **getHomeNum** from the page (reuse `DisconSchedule.ajax.send()` style) so DTEK’s bot checks pass.
- Resolve building **71/З** → `sub_type_reason` (e.g. **GPV26.1**); read schedule from **fact.data[&lt;today_or_tomorrow_timestamp&gt;][GPV26.1]**.
- Map DTEK hour-slots and values to **IScheduleItemHours** and **PowerState**; ignore dates whose slots are all `"yes"` (no schedule yet), and for the rest compare with last seen and call **orchestrator.onScheduleChange('dtek', date, normalizedSchedule, updatedAt)** on change.
- Config: **street** (вул. Здановської Юлії), **building** (71/З); optional poll interval and Puppeteer options.
