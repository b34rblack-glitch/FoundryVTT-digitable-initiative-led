/**
 * Digital Table - Initiative LED
 * Controls a WLED-driven LED strip from Foundry combat events.
 * Each "seat" owns a contiguous range of LEDs. During combat, the
 * active combatant's seat is lit with the "current" color and the
 * next combatant's seat is lit with the "next" color.
 */
class DigiTableInitiativeLED {
  static ID = 'foundryvtt-digitable-initiative-led';
  static I18N = 'FoundryVTT-digitable-initiative-led';

  static DEFAULT_SEATS = [
    { ledCount: 1 },
    { ledCount: 1 },
    { ledCount: 1 },
    { ledCount: 1 },
    { ledCount: 1 },
    { ledCount: 1 }
  ];

  static DEFAULT_COLOR_CURRENT = '#ff0000';
  static DEFAULT_COLOR_NEXT = '#ffff00';

  static initialize() {
    this.registerSettings();
  }

  // ---- Settings ---------------------------------------------------------

  static registerSettings() {
    game.settings.register(this.ID, 'wled-ip', {
      name: `${this.I18N}.settings.wled-ip.Name`,
      hint: `${this.I18N}.settings.wled-ip.Hint`,
      scope: 'world',
      config: true,
      type: String,
      default: ''
    });

    game.settings.register(this.ID, 'dm-seat', {
      name: `${this.I18N}.settings.dm-seat.Name`,
      hint: `${this.I18N}.settings.dm-seat.Hint`,
      scope: 'world',
      config: true,
      type: Number,
      default: 0
    });

    game.settings.register(this.ID, 'actor-seats', {
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });

    game.settings.register(this.ID, 'seat-config', {
      scope: 'world',
      config: false,
      type: Object,
      default: { seats: this.DEFAULT_SEATS }
    });

    game.settings.register(this.ID, 'color-current', {
      scope: 'world',
      config: false,
      type: String,
      default: this.DEFAULT_COLOR_CURRENT
    });

    game.settings.register(this.ID, 'color-next', {
      scope: 'world',
      config: false,
      type: String,
      default: this.DEFAULT_COLOR_NEXT
    });

    game.settings.registerMenu(this.ID, 'seat-config-menu', {
      name: `${this.I18N}.settings.seat-config.Name`,
      label: `${this.I18N}.settings.seat-config.Label`,
      hint: `${this.I18N}.settings.seat-config.Hint`,
      icon: 'fa-solid fa-sliders',
      type: SeatConfigApp,
      restricted: true
    });
  }

  // ---- WLED helpers -----------------------------------------------------

  static getWledUri() {
    const ip = game.settings.get(this.ID, 'wled-ip');
    if (!ip) return null;
    return `http://${ip}/json`;
  }

  static async httpPost(payload) {
    const url = this.getWledUri();
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`Error during POST request: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`${this.ID} |`, error.message);
    }
  }

  /**
   * Convert a "#rrggbb" string to a [r, g, b] triple.
   */
  static hexToRgb(hex) {
    const ColorCls = foundry?.utils?.Color;
    if (ColorCls?.fromString) {
      const c = ColorCls.fromString(hex);
      if (c?.rgb) return c.rgb.map((v) => Math.round(v * 255));
    }
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  /**
   * Build prefix-sum ranges for every seat. Returns
   * `{ total, ranges: [{start, end}, ...] }` where `end` is exclusive.
   */
  static buildSeatRanges() {
    const cfg = game.settings.get(this.ID, 'seat-config') ?? {};
    const seats = Array.isArray(cfg.seats) ? cfg.seats : [];
    const ranges = [];
    let cursor = 0;
    for (const seat of seats) {
      const count = Math.max(0, Number(seat?.ledCount ?? 0) | 0);
      ranges.push({ start: cursor, end: cursor + count });
      cursor += count;
    }
    return { total: cursor, ranges };
  }

  /**
   * Locate the seat index assigned to a given actor, or null.
   */
  static seatForActor(actorId) {
    if (!actorId) return null;
    const seats = game.settings.get(this.ID, 'actor-seats') ?? {};
    const raw = seats[actorId];
    if (raw === undefined || raw === null || raw === 'none') return null;
    const idx = Number(raw);
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  }

  /**
   * Resolve the "next" combatant, skipping the current one and any
   * defeated combatants. Falls back to scanning `combat.turns` when
   * `Combat#nextCombatant` is unavailable.
   */
  static resolveNextCombatant(combat) {
    if (!combat) return null;
    if (combat.nextCombatant) return combat.nextCombatant;

    const turns = combat.turns ?? [];
    if (!turns.length) return null;
    const start = (combat.turn ?? -1) + 1;
    for (let i = 0; i < turns.length; i += 1) {
      const c = turns[(start + i) % turns.length];
      if (c && !c.isDefeated && c !== combat.combatant) return c;
    }
    return null;
  }

  // ---- Rendering --------------------------------------------------------

  /**
   * Compute and send the current frame for an in-progress combat.
   */
  static refresh(combat) {
    const { total, ranges } = this.buildSeatRanges();
    if (total <= 0) {
      this.httpPost({ on: true, bri: 255, seg: { i: [] } });
      return;
    }

    const ledArray = Array.from({ length: total }, () => [0, 0, 0]);

    const currentSeat = this.seatForActor(combat?.combatant?.actorId);
    const nextSeat = this.seatForActor(this.resolveNextCombatant(combat)?.actorId);
    const currentColor = this.hexToRgb(game.settings.get(this.ID, 'color-current'));
    const nextColor = this.hexToRgb(game.settings.get(this.ID, 'color-next'));

    const paint = (seatIdx, color) => {
      if (seatIdx === null || seatIdx < 0 || seatIdx >= ranges.length) return;
      const { start, end } = ranges[seatIdx];
      for (let i = start; i < end; i += 1) ledArray[i] = color;
    };

    // Paint "next" first so that if a single seat is both, "current" wins.
    paint(nextSeat, nextColor);
    paint(currentSeat, currentColor);

    this.httpPost({ on: true, bri: 255, seg: { i: ledArray } });
  }

  static startCombat() {
    const { total } = this.buildSeatRanges();
    const off = Array.from({ length: total }, () => [0, 0, 0]);
    this.httpPost({ on: true, bri: 255, seg: { i: off } });
  }

  static stopCombat() {
    this.httpPost({ on: false });
  }

  // ---- Actor → seat assignment dialog ----------------------------------

  static async openActorSeatDialog(actorId) {
    const seats = game.settings.get(this.ID, 'actor-seats') ?? {};
    const current = seats[actorId] ?? 0;

    const title = game.i18n.localize(`${this.I18N}.settings.Actor.Title`);
    const seatLabel = game.i18n.localize(`${this.I18N}.settings.Actor.Seat.Name`);
    const saveLabel = game.i18n.localize(`${this.I18N}.Button.Save`);
    const cancelLabel = game.i18n.localize(`${this.I18N}.Button.Chancel`);

    const content = `
      <form>
        <div class="form-group">
          <label>${seatLabel}:</label>
          <input type="number" min="0" step="1" name="seatID" value="${current}">
        </div>
      </form>`;

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2) {
      const result = await DialogV2.prompt({
        window: { title },
        content,
        ok: {
          icon: 'fas fa-check',
          label: saveLabel,
          callback: (_event, button) => button.form.elements.seatID.value
        },
        rejectClose: false
      }).catch(() => null);

      if (result === null || result === undefined) return;
      const updated = game.settings.get(this.ID, 'actor-seats') ?? {};
      updated[actorId] = result === '' ? 'none' : result;
      await game.settings.set(this.ID, 'actor-seats', updated);
      return;
    }

    // Legacy v12 fallback
    let applyChanges = false;
    new Dialog({
      title,
      content,
      buttons: {
        yes: {
          icon: "<i class='fas fa-check'></i>",
          label: saveLabel,
          callback: () => { applyChanges = true; }
        },
        no: {
          icon: "<i class='fas fa-times'></i>",
          label: cancelLabel
        }
      },
      default: 'no',
      close: (html) => {
        if (!applyChanges) return;
        const input = html[0]?.querySelector?.('[name=seatID]') ?? html.find('[name=seatID]')[0];
        const seatID = input?.value || 'none';
        const updated = game.settings.get(this.ID, 'actor-seats') ?? {};
        updated[actorId] = seatID;
        game.settings.set(this.ID, 'actor-seats', updated);
      }
    }).render(true);
  }

  // ---- Actor Directory button ------------------------------------------

  static onRenderActorDirectory(app, html) {
    if (!game.user.isGM) return;

    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const tooltip = game.i18n.localize(`${this.I18N}.settings.Actor.Title`);
    const iconHTML = `<button type="button" class="digitable-initiative-led-button flex0" data-tooltip="${tooltip}" title="${tooltip}"><i class="fa-solid fa-hand-fist"></i></button>`;

    const entries = root.querySelectorAll(
      '.directory-list .directory-item.actor, .directory-list .directory-item[data-entry-id], .directory-list li.actor'
    );

    entries.forEach((entry) => {
      if (entry.querySelector(':scope > .digitable-initiative-led-button')) return;
      entry.insertAdjacentHTML('beforeend', iconHTML);
    });

    if (root.dataset.digitableInitBound === '1') return;
    root.dataset.digitableInitBound = '1';

    root.addEventListener('click', (event) => {
      const btn = event.target.closest('.digitable-initiative-led-button');
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();

      const entry = btn.closest('[data-entry-id], [data-document-id], .actor');
      const actorId = entry?.dataset.entryId ?? entry?.dataset.documentId;
      if (!actorId) return;

      DigiTableInitiativeLED.openActorSeatDialog(actorId);
    });
  }
}

/**
 * SeatConfigApp - GM-facing form for configuring how many LEDs each
 * seat owns and the colors used for the current/next combatant.
 *
 * Uses ApplicationV2 + HandlebarsApplicationMixin when available
 * (Foundry v12+); falls back to a legacy FormApplication on older cores.
 */
const _AppV2 = foundry?.applications?.api?.ApplicationV2;
const _HbsMixin = foundry?.applications?.api?.HandlebarsApplicationMixin;

class SeatConfigApp extends (_AppV2 && _HbsMixin ? _HbsMixin(_AppV2) : FormApplication) {
  constructor(options = {}) {
    super(options);
    this._working = this._loadFromSettings();
  }

  // ---- ApplicationV2 surface -------------------------------------------
  // NOTE: DEFAULT_OPTIONS must be a static *getter*, not a static field.
  // ApplicationV2 inspects `form.handler` and `actions.*` during construction
  // and rejects anything that isn't a function. If we used a static field
  // here, the references to `_onSubmit` / `_onAddSeat` / etc. would resolve
  // to `undefined` because static method declarations later in the class body
  // haven't been attached to the class yet at field-initialization time. The
  // getter form defers lookup until the property is actually accessed.

  static get DEFAULT_OPTIONS() {
    return {
      id: 'digitable-seat-config',
      tag: 'form',
      window: {
        title: 'FoundryVTT-digitable-initiative-led.settings.seat-config.Title',
        icon: 'fa-solid fa-sliders',
        contentClasses: ['standard-form', 'digitable-seat-config']
      },
      position: { width: 480, height: 'auto' },
      form: {
        handler: this._onSubmit,
        closeOnSubmit: true,
        submitOnChange: false
      },
      actions: {
        addSeat: this._onAddSeat,
        removeSeat: this._onRemoveSeat,
        reset: this._onReset
      }
    };
  }

  static PARTS = {
    body: { template: 'modules/foundryvtt-digitable-initiative-led/templates/seat-config.hbs' }
  };

  // ---- Legacy FormApplication surface (v11/early-v12 fallback) ---------

  static get defaultOptions() {
    const base = (super.defaultOptions ?? {});
    return foundry.utils.mergeObject(base, {
      id: 'digitable-seat-config',
      title: game.i18n?.localize?.('FoundryVTT-digitable-initiative-led.settings.seat-config.Title') ?? 'Seat configuration',
      template: 'modules/foundryvtt-digitable-initiative-led/templates/seat-config.hbs',
      width: 480,
      height: 'auto',
      closeOnSubmit: true,
      submitOnClose: false
    });
  }

  // ---- Data plumbing ---------------------------------------------------

  _loadFromSettings() {
    const cfg = game.settings.get(DigiTableInitiativeLED.ID, 'seat-config') ?? {};
    const seats = Array.isArray(cfg.seats) && cfg.seats.length
      ? cfg.seats.map((s) => ({ ledCount: Math.max(0, Number(s?.ledCount ?? 0) | 0) }))
      : DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s }));
    return {
      seats,
      colorCurrent: game.settings.get(DigiTableInitiativeLED.ID, 'color-current') || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT,
      colorNext: game.settings.get(DigiTableInitiativeLED.ID, 'color-next') || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
    };
  }

  _captureFormState(form) {
    if (!form) return;
    const counts = form.querySelectorAll('input[name^="seats."]');
    const seats = [];
    counts.forEach((input) => {
      const m = /^seats\.(\d+)\.ledCount$/.exec(input.name);
      if (!m) return;
      const idx = Number(m[1]);
      seats[idx] = { ledCount: Math.max(0, Number(input.value) | 0) };
    });
    this._working.seats = seats.filter((s) => s);
    const cc = form.querySelector('input[name="colorCurrent"]');
    const cn = form.querySelector('input[name="colorNext"]');
    if (cc) this._working.colorCurrent = cc.value || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT;
    if (cn) this._working.colorNext = cn.value || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT;
  }

  // ApplicationV2 data hook
  async _prepareContext(_options) {
    return this._buildContext();
  }

  // FormApplication legacy data hook
  async getData(_options) {
    return this._buildContext();
  }

  _buildContext() {
    const total = this._working.seats.reduce((a, s) => a + Math.max(0, Number(s.ledCount) | 0), 0);
    return {
      seats: this._working.seats.map((s, i) => ({ index: i, ledCount: s.ledCount })),
      colorCurrent: this._working.colorCurrent,
      colorNext: this._working.colorNext,
      total,
      i18n: {
        title: `${DigiTableInitiativeLED.I18N}.settings.seat-config.Title`,
        seatHeader: `${DigiTableInitiativeLED.I18N}.settings.seat-config.SeatHeader`,
        ledCount: `${DigiTableInitiativeLED.I18N}.settings.seat-config.LedCount`,
        colorCurrent: `${DigiTableInitiativeLED.I18N}.settings.seat-config.ColorCurrent`,
        colorNext: `${DigiTableInitiativeLED.I18N}.settings.seat-config.ColorNext`,
        addSeat: `${DigiTableInitiativeLED.I18N}.settings.seat-config.AddSeat`,
        removeSeat: `${DigiTableInitiativeLED.I18N}.settings.seat-config.RemoveSeat`,
        total: `${DigiTableInitiativeLED.I18N}.settings.seat-config.TotalLeds`,
        save: `${DigiTableInitiativeLED.I18N}.Button.Save`,
        cancel: `${DigiTableInitiativeLED.I18N}.Button.Chancel`,
        reset: `${DigiTableInitiativeLED.I18N}.settings.seat-config.Reset`
      }
    };
  }

  // ---- Actions ---------------------------------------------------------

  static _onAddSeat(event) {
    event?.preventDefault?.();
    this._captureFormState(this.element);
    this._working.seats.push({ ledCount: 1 });
    this.render();
  }

  static _onRemoveSeat(event, target) {
    event?.preventDefault?.();
    this._captureFormState(this.element);
    const idx = Number(target?.dataset?.seatIndex);
    if (!Number.isInteger(idx)) return;
    this._working.seats.splice(idx, 1);
    this.render();
  }

  static _onReset(event) {
    event?.preventDefault?.();
    this._working = {
      seats: DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s })),
      colorCurrent: DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT,
      colorNext: DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
    };
    this.render();
  }

  // ApplicationV2 submit
  static async _onSubmit(_event, _form, formData) {
    const data = formData?.object ?? {};
    await this._persist(data);
  }

  // FormApplication submit
  async _updateObject(_event, formData) {
    await this._persist(formData);
  }

  async _persist(formData) {
    const seats = [];
    for (const [key, value] of Object.entries(formData ?? {})) {
      const m = /^seats\.(\d+)\.ledCount$/.exec(key);
      if (!m) continue;
      seats[Number(m[1])] = { ledCount: Math.max(0, Number(value) | 0) };
    }
    const cleaned = seats.filter((s) => s);

    await game.settings.set(DigiTableInitiativeLED.ID, 'seat-config', {
      seats: cleaned.length ? cleaned : DigiTableInitiativeLED.DEFAULT_SEATS.map((s) => ({ ...s }))
    });
    await game.settings.set(
      DigiTableInitiativeLED.ID,
      'color-current',
      formData?.colorCurrent || DigiTableInitiativeLED.DEFAULT_COLOR_CURRENT
    );
    await game.settings.set(
      DigiTableInitiativeLED.ID,
      'color-next',
      formData?.colorNext || DigiTableInitiativeLED.DEFAULT_COLOR_NEXT
    );
  }

  // Re-bind on each ApplicationV2 render so live totals reflect input.
  _onRender(context, options) {
    if (typeof super._onRender === 'function') super._onRender(context, options);
    this._bindLiveTotal();
  }

  // Same for legacy FormApplication.
  activateListeners(html) {
    if (typeof super.activateListeners === 'function') super.activateListeners(html);
    this.element = html[0] ?? html;
    this._bindLiveTotal();
  }

  _bindLiveTotal() {
    const root = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!root) return;
    const totalEl = root.querySelector('[data-total-leds]');
    if (!totalEl) return;
    const recompute = () => {
      let total = 0;
      root.querySelectorAll('input[name^="seats."]').forEach((i) => {
        total += Math.max(0, Number(i.value) | 0);
      });
      totalEl.textContent = String(total);
    };
    root.querySelectorAll('input[name^="seats."]').forEach((i) => {
      i.addEventListener('input', recompute);
    });
  }
}

// ---- Hooks --------------------------------------------------------------

Hooks.once('init', () => {
  DigiTableInitiativeLED.initialize();
});

Hooks.once('devModeReady', ({ registerPackageDebugFlag }) => {
  registerPackageDebugFlag(DigiTableInitiativeLED.ID);
});

Hooks.on('renderActorDirectory', (app, html) => {
  DigiTableInitiativeLED.onRenderActorDirectory(app, html);
});

Hooks.on('createCombat', () => {
  DigiTableInitiativeLED.startCombat();
});

Hooks.on('updateCombat', (combat, change) => {
  if (!('turn' in change) && !('round' in change)) return;
  DigiTableInitiativeLED.refresh(combat);
});

Hooks.on('deleteCombat', () => {
  DigiTableInitiativeLED.stopCombat();
});
