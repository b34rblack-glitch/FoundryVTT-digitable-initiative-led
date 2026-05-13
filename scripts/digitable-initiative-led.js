/**
 * Digital Table - Initiative LED
 * Controls the initiative LEDs of a physical "digital" table via the WLED JSON API.
 */
class DigiTableInitiativeLED {
  static ID = 'foundryvtt-digitable-initiative-led';

  // i18n namespace used inside the lang files
  static I18N = 'FoundryVTT-digitable-initiative-led';

  static seats_power = {
    0: { on: false, bri: 255 },
    1: { on: true, bri: 255 }
  };

  static seats_off = { seg: { i: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } };

  static seats = {
    0: { seg: { i: [[255, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } },
    1: { seg: { i: [[0, 0, 0], [255, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } },
    2: { seg: { i: [[0, 0, 0], [0, 0, 0], [255, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } },
    3: { seg: { i: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [255, 0, 0], [0, 0, 0], [0, 0, 0]] } },
    4: { seg: { i: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [255, 0, 0], [0, 0, 0]] } },
    5: { seg: { i: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [255, 0, 0]] } }
  };

  static initialize() {
    this.registerSettings();
  }

  static getWledUri() {
    const ip = game.settings.get(this.ID, 'wled-ip');
    if (!ip) return null;
    return `http://${ip}/json`;
  }

  static set_actor_led(actorId) {
    const uri = this.getWledUri();
    if (!uri) return;
    const seats = game.settings.get(this.ID, 'actor-seats') ?? {};
    let seatId = seats[actorId];
    if (seatId === undefined) seatId = 0;
    this.httpPost(uri, this.seats[seatId]);
  }

  static startInitiative() {
    const uri = this.getWledUri();
    if (!uri) return;
    this.httpPost(uri, this.seats_power[1]);
    this.httpPost(uri, this.seats_off);
  }

  static stopInitiative() {
    const uri = this.getWledUri();
    if (!uri) return;
    this.httpPost(uri, this.seats_power[0]);
  }

  static async httpPost(url, values) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      if (!response.ok) {
        throw new Error(`Error during POST request: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`${this.ID} |`, error.message);
    }
  }

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
  }

  /**
   * Open the per-actor seat-assignment dialog using DialogV2 (v13+).
   * Falls back to the legacy Dialog on Foundry v12.
   */
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
          <input type="text" name="seatID" value="${current}">
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
      updated[actorId] = result || 'none';
      await game.settings.set(this.ID, 'actor-seats', updated);
      return;
    }

    // Legacy fallback (Foundry v12)
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

  /**
   * Inject a button into every actor entry in the Actor Directory.
   * Works against both the jQuery wrapper (v12) and the bare HTMLElement (v13+).
   */
  static onRenderActorDirectory(app, html) {
    if (!game.user.isGM) return;

    const root = html instanceof HTMLElement
      ? html
      : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const tooltip = game.i18n.localize(`${this.I18N}.settings.Actor.Title`);
    const iconHTML = `<button type="button" class="digitable-initiative-led-button flex0" data-tooltip="${tooltip}" title="${tooltip}"><i class="fa-solid fa-hand-fist"></i></button>`;

    // v13+ uses .directory-item; v12 uses .actor. Cover both.
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

Hooks.once('init', () => {
  DigiTableInitiativeLED.initialize();
});

Hooks.once('devModeReady', ({ registerPackageDebugFlag }) => {
  registerPackageDebugFlag(DigiTableInitiativeLED.ID);
});

Hooks.on('renderActorDirectory', (app, html) => {
  DigiTableInitiativeLED.onRenderActorDirectory(app, html);
});

Hooks.on('updateCombat', (combat, change) => {
  if (change.turn === undefined) return;
  const actorId = combat.combatant?.actorId;
  if (!actorId) return;
  DigiTableInitiativeLED.set_actor_led(actorId);
});

Hooks.on('deleteCombat', () => {
  DigiTableInitiativeLED.stopInitiative();
});

Hooks.on('createCombat', () => {
  DigiTableInitiativeLED.startInitiative();
});
