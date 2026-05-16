/**
 * ===========================================================================
 * File: scripts/digitable-initiative-led.js
 * ---------------------------------------------------------------------------
 * Foundry VTT module entry point for the "DigiTable - Initiative LED" module.
 *
 * Purpose:
 *   Translates Foundry combat-tracker events (combat start/turn change/end)
 *   into HTTP POST requests sent to a WLED-flashed microcontroller. Each
 *   physical "seat" at the gaming table is mapped to an explicit, inclusive
 *   range of LED indices on the attached addressable LED strip. When combat
 *   is active, the seat belonging to the current combatant is illuminated
 *   in one configurable color, and the seat belonging to the on-deck
 *   combatant is illuminated in another. All other LEDs stay dark.
 *
 * Contents:
 *   - class DigiTableInitiativeLED — module state, settings, WLED I/O,
 *     seat math, rendering, actor-seat assignment dialog, sidebar UI hook.
 *   - class SeatConfigApp          — GM-facing configuration form that
 *     exposes seat ranges and the current/next colors. Uses ApplicationV2
 *     on Foundry v12+ and falls back to FormApplication on v11.
 *   - Bottom-of-file `Hooks` block — wires class methods to Foundry's
 *     init/ready/render/combat lifecycle events.
 * ===========================================================================
 */

// Primary module class: holds module-wide constants and exposes static
// methods for every behavior (settings registration, WLED I/O, rendering).
// All members are static because a Foundry module has no useful instance
// — there is exactly one module loaded per world.
class DigiTableInitiativeLED {
  // Module identifier as it appears in `game.settings` namespaces and the
  // Foundry module registry. Must match the `id` field in module.json.
  static ID = 'foundryvtt-digitable-initiative-led';
  // Top-level i18n namespace prefix for every translation key. Note the
  // case differs from `ID` because the i18n keys were defined that way in
  // the original module and we keep backwards compatibility.
  static I18N = 'FoundryVTT-digitable-initiative-led';

  // Default seat layout used on fresh installs (and by "Reset to defaults"
  // in the SeatConfigApp). Six seats, one LED each, packed at indices 0–5.
  // Matches the original 6-LED hardware behavior so existing physical
  // setups light up sensibly without any configuration.
  static DEFAULT_SEATS = [
    // Seat 0 owns only LED index 0.
    { name: '', start: 0, end: 0 },
    // Seat 1 owns only LED index 1.
    { name: '', start: 1, end: 1 },
    // Seat 2 owns only LED index 2.
    { name: '', start: 2, end: 2 },
    // Seat 3 owns only LED index 3.
    { name: '', start: 3, end: 3 },
    // Seat 4 owns only LED index 4.
    { name: '', start: 4, end: 4 },
    // Seat 5 owns only LED index 5.
    { name: '', start: 5, end: 5 }
  ];

  // Default color (red) used to light the seat of the *current* combatant.
  static DEFAULT_COLOR_CURRENT = '#ff0000';
  // Default color (yellow) used to light the seat of the *next* combatant.
  static DEFAULT_COLOR_NEXT = '#ffff00';

  // Called once from the Foundry `init` hook. Currently only needs to
  // register settings, but kept as a separate method so future init-time
  // setup (keybindings, sockets, etc.) has a single canonical entry point.
  static initialize() {
    // Register every world-scoped setting and the seat-config menu entry.
    this.registerSettings();
  }

  // ---- Settings ---------------------------------------------------------
  // All settings live under the module ID namespace and are world-scoped
  // so every connected client sees the same values; only the GM can write.

  static registerSettings() {
    // The WLED controller's IP address (or hostname). Shown in the
    // standard module settings panel; empty means "module is dormant".
    game.settings.register(this.ID, 'wled-ip', {
      // Localized human-readable setting name (label in the settings UI).
      name: `${this.I18N}.settings.wled-ip.Name`,
      // Localized help text shown under the input field.
      hint: `${this.I18N}.settings.wled-ip.Hint`,
      // "world" = stored on the server, shared by every connected client.
      scope: 'world',
      // `true` makes the setting appear in the standard settings dialog.
      config: true,
      // Stored value type — Foundry uses this for input rendering.
      type: String,
      // Empty default forces the GM to enter their controller's address.
      default: ''
    });

    // Legacy DM seat ID setting. Retained for backwards compatibility
    // with the original module. Not consulted by the current render logic
    // but still surfaced in the settings UI so old configurations remain
    // visible to the GM.
    game.settings.register(this.ID, 'dm-seat', {
      // Localized display name for the DM-seat field.
      name: `${this.I18N}.settings.dm-seat.Name`,
      // Localized help text.
      hint: `${this.I18N}.settings.dm-seat.Hint`,
      // World-scoped: same value for every client.
      scope: 'world',
      // Visible in the standard settings dialog.
      config: true,
      // Stored as a number (seat index).
      type: Number,
      // Default to seat 0.
      default: 0
    });

    // Mapping of `actorId → seatIndex (number)` or the sentinel string
    // 'none' for "this actor has no seat". Edited via the per-actor
    // dialog opened from the Actor Directory.
    game.settings.register(this.ID, 'actor-seats', {
      // World-scoped: every client sees the same actor→seat assignments.
      scope: 'world',
      // `false` = hidden from the standard settings UI; only edited via
      // the dedicated per-actor dialog.
      config: false,
      // Stored as a plain object (`{ [actorId]: seatNumberOrNone }`).
      type: Object,
      // Empty mapping by default — no actors are assigned to seats.
      default: {}
    });

    // The seat layout itself: `{ seats: [{ name, start, end }, ...] }`.
    // Hidden from the default settings UI; edited through SeatConfigApp.
    game.settings.register(this.ID, 'seat-config', {
      // World-scoped: all clients agree on the seat layout.
      scope: 'world',
      // Hidden from the default settings panel.
      config: false,
      // Persisted as an object (the form serializer produces JSON).
      type: Object,
      // Default to the 6×1 layout defined above.
      default: { seats: this.DEFAULT_SEATS }
    });

    // Color used to highlight the *current* combatant's seat.
    game.settings.register(this.ID, 'color-current', {
      // World-scoped, shared between clients.
      scope: 'world',
      // Hidden from the standard settings panel (edited in SeatConfigApp).
      config: false,
      // Stored as a "#rrggbb" hex string.
      type: String,
      // Defaults to red.
      default: this.DEFAULT_COLOR_CURRENT
    });

    // Color used to highlight the *next* combatant's seat.
    game.settings.register(this.ID, 'color-next', {
      // World-scoped, shared between clients.
      scope: 'world',
      // Hidden from the standard settings panel (edited in SeatConfigApp).
      config: false,
      // Stored as a "#rrggbb" hex string.
      type: String,
      // Defaults to yellow.
      default: this.DEFAULT_COLOR_NEXT
    });

    // Register the menu entry that opens the seat-configuration form.
    // `registerMenu` creates a button in the standard settings dialog.
    game.settings.registerMenu(this.ID, 'seat-config-menu', {
      // Localized name shown on the menu entry.
      name: `${this.I18N}.settings.seat-config.Name`,
      // Localized label on the button itself.
      label: `${this.I18N}.settings.seat-config.Label`,
      // Localized hint shown next to the menu entry.
      hint: `${this.I18N}.settings.seat-config.Hint`,
      // Font Awesome icon shown next to the button.
      icon: 'fa-solid fa-sliders',
      // The Application class to instantiate when the button is clicked.
      type: SeatConfigApp,
      // `true` hides the menu from non-GM users.
      restricted: true
    });
  }

  // ---- WLED helpers -----------------------------------------------------
  // Pure I/O helpers that talk to the WLED HTTP JSON API.

  // Build the WLED JSON API endpoint URL from the stored IP setting.
  // Returns `null` when no IP is configured so callers can short-circuit.
  static getWledUri() {
    // Read the stored IP/hostname value from settings.
    const ip = game.settings.get(this.ID, 'wled-ip');
    // No IP means the module hasn't been configured yet — bail out.
    if (!ip) return null;
    // WLED exposes its REST API at /json on plain HTTP.
    return `http://${ip}/json`;
  }

  // Send a JSON payload to the WLED controller. All WLED commands the
  // module issues — power on/off, brightness, per-LED color — go through
  // this single function so error handling and missing-config behavior
  // live in one place.
  static async httpPost(payload) {
    // Resolve the WLED JSON endpoint; null = no IP configured.
    const url = this.getWledUri();
    // Without an endpoint there is nowhere to send to; silently no-op.
    if (!url) return;
    // Wrap the network call so a downed controller doesn't break Foundry.
    try {
      // Issue the POST with a JSON body. WLED's API is plain JSON-over-HTTP.
      const response = await fetch(url, {
        // WLED expects a POST for state changes.
        method: 'POST',
        // Required content type for WLED's JSON parser.
        headers: { 'Content-Type': 'application/json' },
        // Serialize the caller's payload into the request body.
        body: JSON.stringify(payload)
      });
      // Treat any non-2xx response as a failure.
      if (!response.ok) {
        // Surface the status text so logs are easier to triage.
        throw new Error(`Error during POST request: ${response.statusText}`);
      }
    } catch (error) {
      // Log the failure but never throw — combat must continue even if
      // the LED hardware is offline.
      console.error(`${this.ID} |`, error.message);
    }
  }

  /**
   * Convert a "#rrggbb" string to a [r, g, b] triple where each channel
   * is an integer in the range 0–255. Used to translate color-picker
   * values into the byte arrays WLED expects in its segment payloads.
   */
  static hexToRgb(hex) {
    // Prefer Foundry's built-in color parser when present — it handles
    // edge cases (named colors, alpha, etc.) more robustly than the
    // hand-rolled fallback below.
    const ColorCls = foundry?.utils?.Color;
    // Use the Foundry parser only when its `fromString` factory exists.
    if (ColorCls?.fromString) {
      // Parse the string into a Color instance.
      const c = ColorCls.fromString(hex);
      // `Color#rgb` is 0..1 floats; scale to 0..255 integers for WLED.
      if (c?.rgb) return c.rgb.map((v) => Math.round(v * 255));
    }
    // Fallback regex parser for "#rrggbb" (with or without the hash).
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    // Unparseable input → produce black so the strip stays dark.
    if (!m) return [0, 0, 0];
    // Parse the captured six hex digits into one 24-bit integer.
    const n = parseInt(m[1], 16);
    // Split that integer into R, G, B bytes via shifts and masks.
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  /**
   * Normalize a single seat record from settings into the canonical
   * `{ name, start, end }` shape. `end` is inclusive. Supports the
   * legacy `{ ledCount }` shape by mapping it to an empty range — the
   * proper migration runs at `ready`; this only acts as a safety net
   * for code paths that might run before the migration completes.
   */
  static normalizeSeat(raw, fallbackIndex = 0) {
    // Pull the optional seat name, defaulting to an empty string.
    const name = typeof raw?.name === 'string' ? raw.name : '';
    // Current-shape record: at least one of start/end is present.
    if (raw?.start !== undefined || raw?.end !== undefined) {
      // Clamp start to >= 0 and coerce to integer (`| 0` truncates).
      const start = Math.max(0, Number(raw?.start ?? 0) | 0);
      // `end` may be -1 to denote an empty range (start..end inclusive).
      const end = Math.max(-1, Number(raw?.end ?? start - 1) | 0);
      // Canonical shape, ready for downstream math.
      return { name, start, end };
    }
    // Legacy `ledCount` record — give it a single placeholder slot so
    // any caller still sees a valid range until migration runs.
    return { name, start: fallbackIndex, end: fallbackIndex };
  }

  /**
   * Return `{ total, ranges }` where `ranges[i]` is the inclusive
   * `{ start, end }` range owned by seat `i`, and `total` is the
   * minimum LED-strip length required to address every LED any seat
   * claims (i.e. `max(end) + 1` across all non-empty seats).
   */
  static buildSeatRanges() {
    // Pull the persisted seat configuration; `??` guards against a
    // missing setting (very old worlds).
    const cfg = game.settings.get(this.ID, 'seat-config') ?? {};
    // Defensive check — older shapes might have a non-array `seats`.
    const seats = Array.isArray(cfg.seats) ? cfg.seats : [];
    // Per-seat inclusive ranges, parallel to `seats`.
    const ranges = [];
    // Strip length needed to address the highest claimed LED + 1.
    let total = 0;
    // Walk every configured seat and accumulate ranges + max length.
    seats.forEach((seat, i) => {
      // Normalize before consuming so legacy entries don't break math.
      const { start, end } = this.normalizeSeat(seat, i);
      // Record the seat's range at the same index as in the settings.
      ranges.push({ start, end });
      // Only widen `total` for *non-empty* ranges (end >= start).
      if (end >= start) total = Math.max(total, end + 1);
    });
    // Hand back both pieces; callers consume them together.
    return { total, ranges };
  }

  /**
   * One-shot migration from the prior `{ledCount}` shape to explicit
   * `{name, start, end}` ranges, computed via the old prefix-sum rule
   * so the visual layout stays identical until the GM edits it.
   * Idempotent: returns `false` and does nothing when the stored shape
   * is already current.
   */
  static migrateSeatConfig() {
    // Read the existing config; may be missing entirely on fresh installs.
    const cfg = game.settings.get(this.ID, 'seat-config');
    // Nothing to migrate if the config or its seats array is missing/empty.
    if (!cfg || !Array.isArray(cfg.seats) || !cfg.seats.length) return false;
    // Peek at the first seat to detect the stored shape.
    const first = cfg.seats[0];
    // Already in the current shape → migration is a no-op.
    if (first && (first.start !== undefined || first.end !== undefined)) return false;

    // Running LED index for the prefix-sum translation. Each legacy seat
    // claims `ledCount` consecutive LEDs starting at `cursor`.
    let cursor = 0;
    // Walk the legacy array and produce a current-shape replacement.
    const migrated = cfg.seats.map((s) => {
      // Coerce to a non-negative integer; missing fields → 0.
      const count = Math.max(0, Number(s?.ledCount ?? 0) | 0);
      // Build the canonical record for this seat.
      const seat = {
        // Preserve the original name; default to empty when missing.
        name: typeof s?.name === 'string' ? s.name : '',
        // First LED owned by this seat.
        start: cursor,
        // Last LED owned by this seat (inclusive). count=0 yields end < start.
        end: cursor + count - 1
      };
      // Advance the cursor by however many LEDs this seat consumed.
      cursor += count;
      // Return the canonical seat for the `map`.
      return seat;
    });

    // Persist the migrated array and let the caller await the write.
    return game.settings.set(this.ID, 'seat-config', { seats: migrated });
  }

  /**
   * Locate the seat index assigned to a given actor, or null if the
   * actor has no seat (or "none" was selected). The seat number is
   * stored as either a numeric string or the literal string 'none'.
   */
  static seatForActor(actorId) {
    // No actor ID → no seat assignment possible.
    if (!actorId) return null;
    // Pull the actor→seat mapping; default to empty when unset.
    const seats = game.settings.get(this.ID, 'actor-seats') ?? {};
    // Look up the raw value for this actor.
    const raw = seats[actorId];
    // Treat unset / null / explicit 'none' as "no seat".
    if (raw === undefined || raw === null || raw === 'none') return null;
    // Coerce to a number — settings are persisted as strings.
    const idx = Number(raw);
    // Only accept non-negative integers; anything else → no seat.
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  }

  /**
   * Resolve the "next" combatant, skipping the current one and any
   * defeated combatants. Falls back to scanning `combat.turns` when
   * `Combat#nextCombatant` is unavailable (very old core, or unusual
   * combat states).
   */
  static resolveNextCombatant(combat) {
    // Defensive: no combat → no next combatant.
    if (!combat) return null;
    // Prefer the engine-supplied accessor when available.
    if (combat.nextCombatant) return combat.nextCombatant;

    // Manual scan fallback. Start from `turn + 1` (mod length).
    const turns = combat.turns ?? [];
    // Empty combat (no participants) → nothing to highlight.
    if (!turns.length) return null;
    // Index just after the current turn; -1 + 1 = 0 if `turn` is unset.
    const start = (combat.turn ?? -1) + 1;
    // Walk forward, wrapping around at the end of the array.
    for (let i = 0; i < turns.length; i += 1) {
      // Pick the candidate at the wrapped index.
      const c = turns[(start + i) % turns.length];
      // Accept the first non-defeated, non-current combatant we see.
      if (c && !c.isDefeated && c !== combat.combatant) return c;
    }
    // Every other combatant is defeated/the current one → no "next".
    return null;
  }

  // ---- Rendering --------------------------------------------------------
  // Build and dispatch the WLED payload that represents the current
  // combat state.

  /**
   * Compute and send the current LED frame for an in-progress combat.
   * Called whenever a combat-turn or round change is observed.
   */
  static refresh(combat) {
    // Resolve seat ranges + the smallest strip length we need to address.
    const { total, ranges } = this.buildSeatRanges();
    // No seats configured (or all empty) → tell WLED to clear the strip
    // and bail out before the per-LED math.
    if (total <= 0) {
      // `seg.i = []` clears any per-LED overrides on the active segment.
      this.httpPost({ on: true, bri: 255, seg: { i: [] } });
      return;
    }

    // Build a black canvas the size of the addressable region. Each
    // entry is an [r,g,b] triple that WLED interprets in order.
    const ledArray = Array.from({ length: total }, () => [0, 0, 0]);

    // Find which seat (if any) the active combatant occupies.
    const currentSeat = this.seatForActor(combat?.combatant?.actorId);
    // Find which seat (if any) the on-deck combatant occupies.
    const nextSeat = this.seatForActor(this.resolveNextCombatant(combat)?.actorId);
    // Resolve the user-chosen "current" color as a byte triple.
    const currentColor = this.hexToRgb(game.settings.get(this.ID, 'color-current'));
    // Resolve the user-chosen "next" color as a byte triple.
    const nextColor = this.hexToRgb(game.settings.get(this.ID, 'color-next'));

    // Helper that paints a seat's range with a color, inclusive on
    // both ends. Guards against out-of-range indices and empty seats.
    const paint = (seatIdx, color) => {
      // Skip invalid seat references (null, negative, beyond the array).
      if (seatIdx === null || seatIdx < 0 || seatIdx >= ranges.length) return;
      // Pull the inclusive range owned by this seat.
      const { start, end } = ranges[seatIdx];
      // Walk every LED in the range and stamp the chosen color. When
      // `end < start` the loop body never executes (empty seat).
      for (let i = start; i <= end && i < total; i += 1) ledArray[i] = color;
    };

    // Paint "next" first so that if a single seat is both the current
    // and the next (e.g. one-combatant combat), "current" overwrites it.
    paint(nextSeat, nextColor);
    // Now paint "current" on top.
    paint(currentSeat, currentColor);

    // Push the assembled frame to WLED at full brightness.
    this.httpPost({ on: true, bri: 255, seg: { i: ledArray } });
  }

  // Called on `createCombat`. Power the strip on and force every LED to
  // black so the visual state matches "combat just started, nobody's
  // turn yet".
  static startCombat() {
    // Determine how many LEDs to clear.
    const { total } = this.buildSeatRanges();
    // Build a black frame of the addressable length.
    const off = Array.from({ length: total }, () => [0, 0, 0]);
    // Push the all-black frame to WLED.
    this.httpPost({ on: true, bri: 255, seg: { i: off } });
  }

  // Called on `deleteCombat`. Power the strip off entirely so the table
  // returns to its pre-combat appearance.
  static stopCombat() {
    // WLED accepts `{ on: false }` to cut output without changing config.
    this.httpPost({ on: false });
  }

  // ---- Actor → seat assignment dialog ----------------------------------
  // Per-actor mini-form opened from the fist icon in the Actor Directory.

  static async openActorSeatDialog(actorId) {
    // Pull current actor→seat mapping; default to empty.
    const seats = game.settings.get(this.ID, 'actor-seats') ?? {};
    // Current seat number for this actor, or 0 if none set yet.
    const current = seats[actorId] ?? 0;

    // Localized dialog title.
    const title = game.i18n.localize(`${this.I18N}.settings.Actor.Title`);
    // Localized label for the seat-number input.
    const seatLabel = game.i18n.localize(`${this.I18N}.settings.Actor.Seat.Name`);
    // Localized text for the OK/Save button.
    const saveLabel = game.i18n.localize(`${this.I18N}.Button.Save`);
    // Localized text for the Cancel button (key is intentionally "Chancel"
    // for backwards compatibility with existing translations).
    const cancelLabel = game.i18n.localize(`${this.I18N}.Button.Chancel`);

    // HTML body for both the V2 and legacy dialog paths. A simple form
    // with one numeric input.
    const content = `
      <form>
        <div class="form-group">
          <label>${seatLabel}:</label>
          <input type="number" min="0" step="1" name="seatID" value="${current}">
        </div>
      </form>`;

    // Prefer ApplicationV2 DialogV2 on Foundry v12+.
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2) {
      // Open as a promise-returning prompt; resolves to the form value.
      const result = await DialogV2.prompt({
        // Window chrome (title bar).
        window: { title },
        // The form HTML rendered inside the dialog body.
        content,
        // OK button configuration.
        ok: {
          // Check-mark icon on the OK button.
          icon: 'fas fa-check',
          // Localized OK label.
          label: saveLabel,
          // On OK, pull the seat number out of the embedded form.
          callback: (_event, button) => button.form.elements.seatID.value
        },
        // Don't treat closing the window as a rejection — we handle null.
        rejectClose: false
      // Swallow rejection so a closed dialog doesn't throw.
      }).catch(() => null);

      // User cancelled or closed without confirming → leave config alone.
      if (result === null || result === undefined) return;
      // Refresh the mapping in case another client edited it meanwhile.
      const updated = game.settings.get(this.ID, 'actor-seats') ?? {};
      // Empty string means "remove the assignment"; store sentinel 'none'.
      updated[actorId] = result === '' ? 'none' : result;
      // Persist the updated mapping.
      await game.settings.set(this.ID, 'actor-seats', updated);
      // V2 path is done.
      return;
    }

    // Legacy v11/early-v12 fallback using the old `Dialog` class.
    // Flag set when the user clicks the affirmative button.
    let applyChanges = false;
    // Render the legacy modal dialog.
    new Dialog({
      // Reuse the localized title.
      title,
      // Reuse the same form HTML.
      content,
      // Button definitions for the legacy Dialog API.
      buttons: {
        // Affirmative button.
        yes: {
          // Check-mark icon (legacy style: inline <i>).
          icon: "<i class='fas fa-check'></i>",
          // Localized label.
          label: saveLabel,
          // Just flip the flag; persist in `close` so the DOM is still alive.
          callback: () => { applyChanges = true; }
        },
        // Cancel button.
        no: {
          // X icon for cancel.
          icon: "<i class='fas fa-times'></i>",
          // Localized cancel label.
          label: cancelLabel
        }
      },
      // Default to "no" so Escape/close is non-destructive.
      default: 'no',
      // Persist when the dialog closes — runs whether the user clicked
      // a button or dismissed the modal.
      close: (html) => {
        // Bail if the user didn't actually confirm.
        if (!applyChanges) return;
        // Support both jQuery (v10/early-v11) and raw DOM html arguments.
        const input = html[0]?.querySelector?.('[name=seatID]') ?? html.find('[name=seatID]')[0];
        // Empty input → store the "none" sentinel.
        const seatID = input?.value || 'none';
        // Re-read so concurrent edits aren't clobbered.
        const updated = game.settings.get(this.ID, 'actor-seats') ?? {};
        // Apply the new value.
        updated[actorId] = seatID;
        // Persist (legacy path returns a promise we don't need to await).
        game.settings.set(this.ID, 'actor-seats', updated);
      }
    // Show the dialog and force render.
    }).render(true);
  }

  // ---- Actor Directory button ------------------------------------------
  // Injects the fist-icon button next to each actor in the sidebar so
  // GMs can quickly assign a seat without opening the sheet.

  static onRenderActorDirectory(app, html) {
    // Non-GM users never see the button.
    if (!game.user.isGM) return;

    // Foundry v12 passes the html argument as a raw HTMLElement; older
    // cores pass a jQuery collection. Normalize to an HTMLElement.
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    // Bail if we somehow got something that isn't a DOM container.
    if (!root || typeof root.querySelectorAll !== 'function') return;

    // Localized tooltip used both for `data-tooltip` (Foundry tooltips)
    // and the standard `title` attribute (browser fallback).
    const tooltip = game.i18n.localize(`${this.I18N}.settings.Actor.Title`);
    // Markup for a single button — a small `<i>` icon inside a button.
    const iconHTML = `<button type="button" class="digitable-initiative-led-button flex0" data-tooltip="${tooltip}" title="${tooltip}"><i class="fa-solid fa-hand-fist"></i></button>`;

    // Match actor entries across Foundry version differences:
    //   - v12+ uses .directory-item.actor or .directory-item[data-entry-id]
    //   - older cores use li.actor
    const entries = root.querySelectorAll(
      '.directory-list .directory-item.actor, .directory-list .directory-item[data-entry-id], .directory-list li.actor'
    );

    // Inject the button into each entry, but only once per entry.
    entries.forEach((entry) => {
      // Skip entries that already have our button (re-renders).
      if (entry.querySelector(':scope > .digitable-initiative-led-button')) return;
      // Append at the end of the row so it sits to the right of the name.
      entry.insertAdjacentHTML('beforeend', iconHTML);
    });

    // Bind the click handler only once per directory render root.
    if (root.dataset.digitableInitBound === '1') return;
    // Mark the root as bound so subsequent renderActorDirectory calls
    // don't stack additional click listeners.
    root.dataset.digitableInitBound = '1';

    // Single delegated listener — handles every button via event bubbling.
    root.addEventListener('click', (event) => {
      // Walk up from the click target to find our specific button class.
      const btn = event.target.closest('.digitable-initiative-led-button');
      // Clicks elsewhere are ignored.
      if (!btn) return;
      // Stop Foundry's directory-item click from also firing (which would
      // open the actor sheet on top of our dialog).
      event.preventDefault();
      // Prevent the click from bubbling further up the tree.
      event.stopPropagation();

      // The enclosing entry holds the actor's id in one of two dataset
      // attributes depending on Foundry version.
      const entry = btn.closest('[data-entry-id], [data-document-id], .actor');
      // Prefer `entry-id`; fall back to `document-id` for older cores.
      const actorId = entry?.dataset.entryId ?? entry?.dataset.documentId;
      // Missing actor id → nothing meaningful to edit.
      if (!actorId) return;

      // Open the seat-assignment dialog for this actor.
      DigiTableInitiativeLED.openActorSeatDialog(actorId);
    });
  }
}

/**
 * SeatConfigApp — GM-facing form for configuring seat ranges and the
 * current/next combatant colors.
 *
 * Uses Foundry's ApplicationV2 + HandlebarsApplicationMixin where
 * available (v12+), falling back to the classic FormApplication on
 * older cores. Both surfaces are implemented in the same class because
 * the data and submit logic are identical — only the framework hooks
 * differ.
 */

// Pull ApplicationV2 off the global Foundry namespace, if it exists.
const _AppV2 = foundry?.applications?.api?.ApplicationV2;
// Pull the Handlebars rendering mixin used to wire `.hbs` templates in.
const _HbsMixin = foundry?.applications?.api?.HandlebarsApplicationMixin;

// Class declaration with a runtime-picked base class. On v12+ we extend
// the V2 base via the Handlebars mixin; on v11 we fall back to the
// legacy FormApplication.
class SeatConfigApp extends (_AppV2 && _HbsMixin ? _HbsMixin(_AppV2) : FormApplication) {
  constructor(options = {}) {
    // Forward construction options to the chosen base class.
    super(options);
    // Snapshot of the persisted settings, used as the form's working
    // copy. Live edits mutate this and are written back on submit.
    this._working = this._loadFromSettings();
  }

  // ---- ApplicationV2 surface -------------------------------------------
  // NOTE: DEFAULT_OPTIONS must be a static *getter*, not a static field.
  // ApplicationV2 inspects `form.handler` and `actions.*` during class
  // construction and rejects anything that isn't a function. If we used
  // a static field here, the references to `_onSubmit` / `_onAddSeat` /
  // etc. would resolve to `undefined` because static method declarations
  // later in the class body haven't been attached to the class yet at
  // field-initialization time. The getter form defers lookup until the
  // property is actually accessed.

  static get DEFAULT_OPTIONS() {
    return {
      // DOM id of the rendered window.
      id: 'digitable-seat-config',
      // Render the root as a <form> so submit handling works natively.
      tag: 'form',
      // Window chrome configuration.
      window: {
        // Localization key for the title bar.
        title: 'FoundryVTT-digitable-initiative-led.settings.seat-config.Title',
        // Font Awesome icon shown in the title bar.
        icon: 'fa-solid fa-sliders',
        // CSS classes applied to the content wrapper — `standard-form`
        // pulls in Foundry's default form styling.
        contentClasses: ['standard-form', 'digitable-seat-config']
      },
      // Initial window dimensions; height auto-sizes to content.
      position: { width: 480, height: 'auto' },
      // Form-submission options consumed by ApplicationV2.
      form: {
        // The static method that runs on submit (bound by V2 to `this`).
        handler: this._onSubmit,
        // Close the window after a successful submit.
        closeOnSubmit: true,
        // Don't submit on every input change — wait for the user.
        submitOnChange: false
      },
      // Map of data-action attribute → handler. The template uses
      // <button data-action="addSeat"> etc. to dispatch to these.
      actions: {
        // "Add seat" button handler.
        addSeat: this._onAddSeat,
        // Per-row "remove" trash icon handler.
        removeSeat: this._onRemoveSeat,
        // "Reset to defaults" button handler.
        reset: this._onReset
      }
    };
  }

  // ApplicationV2 template part registry. We have a single body part
  // pointing at the Handlebars template under the templates/ directory.
  static PARTS = {
    body: { template: 'modules/foundryvtt-digitable-initiative-led/templates/seat-config.hbs' }
  };

  // ---- Legacy FormApplication surface (v11/early-v12 fallback) ---------
  // FormApplication used a `defaultOptions` *property* (lowercase) and a
  // very different shape than ApplicationV2's DEFAULT_OPTIONS. Both
  // surfaces coexist so the module works across Foundry versions.

  static get defaultOptions() {
    // Start from the parent class's defaults so we inherit standard
    // form behaviors (e.g. submit on close, header buttons).
    const base = (super.defaultOptions ?? {});
    // Merge in our overrides. `mergeObject` is Foundry's deep-merge.
    return foundry.utils.mergeObject(base, {
      // DOM id for the rendered window.
      id: 'digitable-seat-config',
      // Localized title with a string fallback for very old cores where
      // game.i18n might not be ready yet.
      title: game.i18n?.localize?.('FoundryVTT-digitable-initiative-led.settings.seat-config.Title') ?? 'Seat configuration',
      // Path to the Handlebars template used to render the form.
      template: 'modules/foundryvtt-digitable-initiative-led/templates/seat-config.hbs',
      // Initial width in pixels.
      width: 480,
      // Auto-size height to fit content.
      height: 'auto',
      // Close the window after the form submits successfully.
      closeOnSubmit: true,
      // Don't try to auto-submit when the user just closes the window.
      submitOnClose: false
    });
  }

  // ---- Data plumbing ---------------------------------------------------

  // Read the saved settings and return them as a plain object suitable
  // for the working copy. Also performs an in-memory legacy → current
  // shape conversion when the migration hasn't run yet, so the form
  // never shows a broken view.
  _loadFromSettings() {
    // Pull the stored seat configuration (may be missing on first open).
    const cfg = game.settings.get(DigiTableInitiativeLED.ID, 'seat-config') ?? {};
    // Defensive: only treat `seats` as a list when it actually is one.
    const rawSeats = Array.isArray(cfg.seats) ? cfg.seats : [];
    // Output array; populated by one of three branches below.
    let seats;
    // No saved seats → show the default layout in the form.
    if (!rawSeats.length) {
      // Clone each default so edits don't mutate the static.
      seats = DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s }));
    } else if (rawSeats[0]?.start !== undefined || rawSeats[0]?.end !== undefined) {
      // Stored shape is already current — just normalize each entry.
      seats = rawSeats.map((s) => DigiTableInitiativeLED.normalizeSeat(s));
    } else {
      // Legacy `ledCount` shape (migration hasn't run yet, e.g. when a
      // non-GM client opens the dialog before the GM has connected).
      // Convert via the same prefix-sum rule the persistent migration
      // uses, so the user sees the right layout.
      let cursor = 0;
      seats = rawSeats.map((s) => {
        // Coerce LED count to a non-negative integer.
        const count = Math.max(0, Number(s?.ledCount ?? 0) | 0);
        // Build a current-shape seat record.
        const seat = {
          name: typeof s?.name === 'string' ? s.name : '',
          start: cursor,
          end: cursor + count - 1
        };
        // Advance the cursor by however many LEDs this seat owns.
        cursor += count;
        return seat;
      });
    }
    // Bundle seats and both colors into the working snapshot.
    return {
      seats,
      // Fall back to the default red if the stored value is empty.
      colorCurrent: game.settings.get(DigiTableInitiativeLED.ID, 'color-current') || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT,
      // Fall back to the default yellow if the stored value is empty.
      colorNext: game.settings.get(DigiTableInitiativeLED.ID, 'color-next') || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
    };
  }

  // Scrape the rendered form's current values into the working copy.
  // Called before adding/removing rows so the user's in-flight edits
  // aren't lost when the template re-renders.
  _captureFormState(form) {
    // Defensive: no form element → nothing to read.
    if (!form) return;
    // Sparse array indexed by the `seats.N.*` numeric index in field names.
    const seats = [];
    // Helper that lazily creates the seat object for index `i`.
    const ensure = (i) => { seats[i] ??= { name: '', start: 0, end: -1 }; return seats[i]; };
    // Walk every `seats.N.field` input and copy its value into `seats`.
    form.querySelectorAll('input[name^="seats."]').forEach((input) => {
      // Extract the array index and field name out of the input's `name`.
      const m = /^seats\.(\d+)\.(name|start|end)$/.exec(input.name);
      // Skip unrecognized names (defensive).
      if (!m) return;
      // Numeric seat index.
      const idx = Number(m[1]);
      // Which field: name / start / end.
      const field = m[2];
      // Ensure the seat slot exists before mutating.
      const seat = ensure(idx);
      // Name is a free-form string.
      if (field === 'name') seat.name = input.value;
      // start/end are numeric; clamp negative starts to 0 and allow
      // `end = -1` as the "empty range" sentinel.
      else seat[field] = Math.max(field === 'end' ? -1 : 0, Number(input.value) | 0);
    });
    // Filter out holes (in case the user removed a middle row).
    this._working.seats = seats.filter((s) => s);
    // Capture the two color picker values too.
    const cc = form.querySelector('input[name="colorCurrent"]');
    const cn = form.querySelector('input[name="colorNext"]');
    // Fall back to defaults when the input is empty (e.g. cleared text).
    if (cc) this._working.colorCurrent = cc.value || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT;
    if (cn) this._working.colorNext = cn.value || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT;
  }

  // ApplicationV2 hook: builds the template context for rendering.
  async _prepareContext(_options) {
    // Delegate to the shared builder so both surfaces produce the same data.
    return this._buildContext();
  }

  // Legacy FormApplication equivalent — same purpose, different hook name.
  async getData(_options) {
    return this._buildContext();
  }

  // Compute every value the Handlebars template needs to render.
  _buildContext() {
    // Live computation of the smallest strip length the working config
    // requires. Mirrors `buildSeatRanges` but operates on the working
    // copy rather than persisted settings, so the user sees their edits.
    let total = 0;
    // Walk each seat in the working copy.
    for (const s of this._working.seats) {
      // Pull and coerce the end / start values.
      const end = Number(s.end);
      const start = Number(s.start);
      // Only widen total for non-empty, finite ranges.
      if (Number.isFinite(end) && Number.isFinite(start) && end >= start) {
        total = Math.max(total, end + 1);
      }
    }
    // Hand the template a flat object with every value it references.
    return {
      // Per-seat row data. `index` is used in field names and data-* attrs.
      seats: this._working.seats.map((s, i) => ({
        index: i,
        name: s.name ?? '',
        start: s.start ?? 0,
        end: s.end ?? 0
      })),
      // Current/next color hex strings for the color inputs.
      colorCurrent: this._working.colorCurrent,
      colorNext: this._working.colorNext,
      // Live strip-length total, displayed below the seat list.
      total,
      // Localization keys exposed to the template via `{{localize i18n.X}}`.
      i18n: {
        title: `${DigiTableInitiativeLED.I18N}.settings.seat-config.Title`,
        seatHeader: `${DigiTableInitiativeLED.I18N}.settings.seat-config.SeatHeader`,
        nameLabel: `${DigiTableInitiativeLED.I18N}.settings.seat-config.NameLabel`,
        namePlaceholder: `${DigiTableInitiativeLED.I18N}.settings.seat-config.NamePlaceholder`,
        startLabel: `${DigiTableInitiativeLED.I18N}.settings.seat-config.StartLabel`,
        endLabel: `${DigiTableInitiativeLED.I18N}.settings.seat-config.EndLabel`,
        colorCurrent: `${DigiTableInitiativeLED.I18N}.settings.seat-config.ColorCurrent`,
        colorNext: `${DigiTableInitiativeLED.I18N}.settings.seat-config.ColorNext`,
        addSeat: `${DigiTableInitiativeLED.I18N}.settings.seat-config.AddSeat`,
        removeSeat: `${DigiTableInitiativeLED.I18N}.settings.seat-config.RemoveSeat`,
        total: `${DigiTableInitiativeLED.I18N}.settings.seat-config.StripLength`,
        save: `${DigiTableInitiativeLED.I18N}.Button.Save`,
        cancel: `${DigiTableInitiativeLED.I18N}.Button.Chancel`,
        reset: `${DigiTableInitiativeLED.I18N}.settings.seat-config.Reset`
      }
    };
  }

  // ---- Actions ---------------------------------------------------------
  // ApplicationV2 binds these as `this`-aware callbacks via the
  // DEFAULT_OPTIONS.actions map. They run on the instance even though
  // they're declared `static` (V2 invokes them with .call).

  // "Add seat" handler — appends a new row to the working copy.
  static _onAddSeat(event) {
    // Buttons inside a <form> default to type="submit"; this stops the
    // browser from accidentally submitting when the user clicks Add.
    event?.preventDefault?.();
    // Save any in-flight typing before we re-render the form.
    this._captureFormState(this.element);
    // Suggest a non-overlapping starting LED: one past the highest end
    // of any existing seat (or 0 when there are none).
    let nextStart = 0;
    for (const s of this._working.seats) {
      const end = Number(s.end);
      if (Number.isFinite(end)) nextStart = Math.max(nextStart, end + 1);
    }
    // Append a one-LED seat at the suggested position.
    this._working.seats.push({ name: '', start: nextStart, end: nextStart });
    // Re-render so the new row appears.
    this.render();
  }

  // "Remove seat" handler — pulls the row index from the button's
  // dataset and drops that entry from the working copy.
  static _onRemoveSeat(event, target) {
    // Stop the implicit submit.
    event?.preventDefault?.();
    // Capture current edits so they survive the re-render.
    this._captureFormState(this.element);
    // Read the index off `data-seat-index`.
    const idx = Number(target?.dataset?.seatIndex);
    // Bail on malformed dataset values.
    if (!Number.isInteger(idx)) return;
    // Drop the entry in place.
    this._working.seats.splice(idx, 1);
    // Re-render so the row disappears.
    this.render();
  }

  // "Reset" handler — restores the default 6-seat layout and default
  // colors in the working copy (not yet persisted; the user still needs
  // to hit Save).
  static _onReset(event) {
    // Don't submit.
    event?.preventDefault?.();
    // Replace the working snapshot wholesale.
    this._working = {
      // Clone defaults so later edits don't mutate the static array.
      seats: DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s })),
      colorCurrent: DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT,
      colorNext: DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
    };
    // Re-render to show the reset state.
    this.render();
  }

  // ApplicationV2 submit handler — receives a FormDataExtended that
  // serializes itself into `formData.object` (a plain JS object).
  static async _onSubmit(_event, _form, formData) {
    // Pull the serialized form data, or an empty object as a fallback.
    const data = formData?.object ?? {};
    // Delegate to the shared persistence routine.
    await this._persist(data);
  }

  // Legacy FormApplication submit handler — receives an already-flat
  // formData object directly.
  async _updateObject(_event, formData) {
    await this._persist(formData);
  }

  // Shared persistence logic for both submit paths. Parses dotted form
  // names back into seat objects and writes the three settings.
  async _persist(formData) {
    // Sparse array; we fill in indices and then `filter` out holes.
    const seats = [];
    // Lazily create the seat object at index `i`.
    const ensure = (i) => { seats[i] ??= { name: '', start: 0, end: -1 }; return seats[i]; };
    // Walk every `seats.N.field` key in the submitted data.
    for (const [key, value] of Object.entries(formData ?? {})) {
      // Parse the dotted key into (index, field name).
      const m = /^seats\.(\d+)\.(name|start|end)$/.exec(key);
      // Skip non-matching keys (e.g. colorCurrent, colorNext).
      if (!m) continue;
      // Numeric seat index.
      const idx = Number(m[1]);
      // Field name (name/start/end).
      const field = m[2];
      // Ensure the seat record exists before mutating.
      const seat = ensure(idx);
      // Name is a string; coerce non-strings to empty.
      if (field === 'name') seat.name = typeof value === 'string' ? value : '';
      // Numbers: clamp start>=0, allow end=-1 as the empty sentinel.
      else seat[field] = Math.max(field === 'end' ? -1 : 0, Number(value) | 0);
    }
    // Compact the sparse array down to a dense one.
    const cleaned = seats.filter((s) => s);

    // Write all three settings in parallel — they're independent.
    await Promise.all([
      // Persist the seat list. If the user removed every row, fall back
      // to defaults so the next combat still has something to light.
      game.settings.set(DigiTableInitiativeLED.ID, 'seat-config', {
        seats: cleaned.length ? cleaned : DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s }))
      }),
      // Persist the "current" color (with default fallback).
      game.settings.set(
        DigiTableInitiativeLED.ID,
        'color-current',
        formData?.colorCurrent || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT
      ),
      // Persist the "next" color (with default fallback).
      game.settings.set(
        DigiTableInitiativeLED.ID,
        'color-next',
        formData?.colorNext || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
      )
    ]);
  }

  // ApplicationV2 lifecycle hook — runs after every render so we can
  // re-bind input listeners to the freshly mounted DOM.
  _onRender(context, options) {
    // Forward to the base class if it implements the hook.
    if (typeof super._onRender === 'function') super._onRender(context, options);
    // Wire up live recalculation of the "Strip length" indicator.
    this._bindLiveTotal();
  }

  // Legacy FormApplication equivalent. `html` is a jQuery collection on
  // older cores; we normalize and then bind.
  activateListeners(html) {
    // Forward to the base class if it has the method.
    if (typeof super.activateListeners === 'function') super.activateListeners(html);
    // Cache the raw element for later querySelector calls.
    this.element = html[0] ?? html;
    // Wire up the live strip-length recomputation.
    this._bindLiveTotal();
  }

  // Bind `input` listeners on the seat start/end fields so the user
  // sees the strip-length total update as they type, without needing
  // to submit-and-reopen the form.
  _bindLiveTotal() {
    // `this.element` is an HTMLElement on V2 and a jQuery wrapper on
    // FormApplication — normalize either way.
    const root = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    // No root → nothing to bind.
    if (!root) return;
    // The `<strong data-total-leds>` element receives the live total.
    const totalEl = root.querySelector('[data-total-leds]');
    // Bail if the template was rendered without the indicator.
    if (!totalEl) return;
    // Recompute the displayed total from current input values.
    const recompute = () => {
      // Strip length = max(end) + 1 across all rows where end >= start.
      // Use a Map keyed by seat index so start/end are paired per row.
      const byIndex = new Map();
      // Iterate every numeric input matching `seats.N.start` or `.end`.
      root.querySelectorAll('input[name^="seats."]').forEach((input) => {
        // Parse the (index, field) out of the input name.
        const m = /^seats\.(\d+)\.(start|end)$/.exec(input.name);
        // Ignore the name field and other unrelated inputs.
        if (!m) return;
        // Numeric seat index.
        const idx = Number(m[1]);
        // Pull or create the partial record for this index.
        const entry = byIndex.get(idx) ?? { start: 0, end: -1 };
        // Coerce and clamp the field value just like the persistence path.
        entry[m[2]] = Math.max(m[2] === 'end' ? -1 : 0, Number(input.value) | 0);
        // Save it back.
        byIndex.set(idx, entry);
      });
      // Walk every per-seat record and pick the largest `end + 1`.
      let total = 0;
      for (const { start, end } of byIndex.values()) {
        if (end >= start) total = Math.max(total, end + 1);
      }
      // Update the on-screen indicator.
      totalEl.textContent = String(total);
    };
    // Attach the listener to every seat input so any edit triggers a
    // recompute.
    root.querySelectorAll('input[name^="seats."]').forEach((i) => {
      i.addEventListener('input', recompute);
    });
  }
}

// ---- Hooks --------------------------------------------------------------
// Foundry event subscriptions — these are the only entry points the
// engine invokes on us once the module is loaded.

// `init` fires once when Foundry is bootstrapping. Use it to register
// settings — we can't read settings until after this point.
Hooks.once('init', () => {
  // Single canonical entry point on the module class.
  DigiTableInitiativeLED.initialize();
});

// `ready` fires once when the world has finished loading. Settings are
// readable and writable, players are connected, etc.
Hooks.once('ready', async () => {
  // Run the seat-config migration once, from the canonical GM client,
  // so multiple connected clients don't race to write the same setting.
  if (game.user === game.users?.activeGM) {
    // Wrap in try/catch — a failed migration shouldn't break login.
    try { await DigiTableInitiativeLED.migrateSeatConfig(); }
    catch (err) { console.error(`${DigiTableInitiativeLED.ID} | migration failed`, err); }
  }
});

// Optional integration with the Developer Mode module: registers our
// package id so a GM can toggle debug logging for us. No-op if Dev Mode
// isn't installed (the hook just never fires).
Hooks.once('devModeReady', ({ registerPackageDebugFlag }) => {
  registerPackageDebugFlag(DigiTableInitiativeLED.ID);
});

// Inject the per-actor seat-assignment button whenever the Actor
// Directory sidebar re-renders. Filtered to GMs inside the handler.
Hooks.on('renderActorDirectory', (app, html) => {
  DigiTableInitiativeLED.onRenderActorDirectory(app, html);
});

// New combat encounter — clear and power on the strip so it's visibly
// "armed" before the first turn.
Hooks.on('createCombat', () => {
  DigiTableInitiativeLED.startCombat();
});

// Combat updated. We only care when the active turn or round changes —
// not actor-name edits, scene linkage tweaks, etc.
Hooks.on('updateCombat', (combat, change) => {
  // Bail unless this update flipped the turn or round.
  if (!('turn' in change) && !('round' in change)) return;
  // Recompute and push the LED frame for the new state.
  DigiTableInitiativeLED.refresh(combat);
});

// Combat ended — kill the strip output.
Hooks.on('deleteCombat', () => {
  DigiTableInitiativeLED.stopCombat();
});
