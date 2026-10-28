// The connection form tab (kind `db-connection`, id `dbconn:<id>`).
// It edits one DbConnectionConfig. Passwords go to the OS keychain only when
// the user ticks "Save password in keychain". They are never in settings.json.

import { h } from '../../core/dom';
import type { TabContent } from '../../core/types';
import { dbPasswordDelete, dbPasswordExists, dbPasswordSet, dbTest, type DbDriver, type DbSslMode, type DbTrinoAuth } from '../../ipc/db';
import { describeError } from './errors';
import {
  blankDraft,
  configFromDraft,
  draftFromConfig,
  removeConnection,
  sameDraft,
  upsertConnection,
  validateDraft,
  withDriver,
  withSsl,
  type ConnDraft,
  type DraftErrors,
  type DraftField,
} from './form-model';
import type { DbHub } from './hub';
import { connTabId } from './tabs';
import './db.css';

const COLORS = ['#e5484d', '#f5a524', '#30a46c', '#3e8ef7', '#8e4ec6', '#8b8d98'];

let formCounter = 0;

export class ConnectionForm implements TabContent {
  private draft: ConnDraft;
  private initial: ConnDraft;
  private readonly tabId: string;
  private isNew: boolean;
  private keychainHas = false;
  private saveInKeychain = false;
  private keychainInitial = false;
  private password = '';
  private shownErrors = false;
  private disposed = false;
  private testToken = 0;
  private readonly uid = `dbf${++formCounter}`;
  private readonly errEls = new Map<DraftField, HTMLElement>();
  private readonly inputs = new Map<DraftField, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

  private readonly root = h('div', { class: 'db-form' });
  private readonly heading = h('h2', { class: 'db-form-title' });
  private readonly testResult = h('div', { class: 'db-test-result', role: 'status' });
  private readonly testBtn = h('button', { class: 'db-btn', type: 'button', onclick: () => void this.test() }, 'Test Connection');
  private readonly saveBtn = h('button', { class: 'db-btn db-btn-primary', type: 'button', onclick: () => void this.save() }, 'Save');
  private readonly cancelBtn = h('button', { class: 'db-btn', type: 'button', onclick: () => void this.cancel() }, 'Cancel');
  private readonly deleteBtn = h('button', { class: 'db-btn db-btn-danger', type: 'button', onclick: () => void this.remove() }, 'Delete');
  private readonly passwordInput = h('input', { class: 'db-input', type: 'password', id: `${this.uid}-pw`, autocomplete: 'new-password', spellcheck: 'false' });
  private readonly keychainBox = h('input', { type: 'checkbox', id: `${this.uid}-kc` });
  private readonly sshBox = h('div', { class: 'db-form-group' });
  /** Parts of the form that depend on the engine (MySQL or Trino) and on the Trino login. */
  private readonly mysqlOnly: HTMLElement[] = [];
  private readonly trinoOnly: HTMLElement[] = [];
  private readonly passwordOnly: HTMLElement[] = [];
  private readonly oauthHint = h('div', { class: 'db-hint' }, 'Kestrel opens your browser to log in. Use the same login as for Trino in your browser. Waiting can take up to 3 minutes.');
  private dbLabel!: HTMLElement;
  private sslSelect!: HTMLSelectElement;

  constructor(
    private readonly hub: DbHub,
    private readonly id: string,
    host: HTMLElement,
  ) {
    const existing = hub.find(id);
    this.isNew = !existing;
    this.draft = existing ? draftFromConfig(existing) : blankDraft(id);
    this.initial = { ...this.draft };
    this.tabId = connTabId(id);

    const ssl = h('select', { class: 'db-input', id: `${this.uid}-ssl` });
    this.sslSelect = ssl;
    this.inputs.set('ssl', ssl);
    ssl.addEventListener('change', () => this.replaceDraft(withSsl(this.draft, ssl.value as DbSslMode)));

    const driver = h(
      'select',
      { class: 'db-input', id: `${this.uid}-driver` },
      h('option', { value: 'mysql' }, 'MySQL'),
      h('option', { value: 'trino' }, 'Trino'),
    );
    driver.value = this.draft.driver;
    this.inputs.set('driver', driver);
    driver.addEventListener('change', () => this.replaceDraft(withDriver(this.draft, driver.value as DbDriver)));

    const auth = h(
      'select',
      { class: 'db-input', id: `${this.uid}-trinoAuth` },
      h('option', { value: 'none' }, 'None: only the user name'),
      h('option', { value: 'password' }, 'Password (HTTPS)'),
      h('option', { value: 'oauth2' }, 'OAuth2: login in the browser'),
    );
    auth.value = this.draft.trinoAuth;
    this.inputs.set('trinoAuth', auth);
    auth.addEventListener('change', () => this.set('trinoAuth', auth.value as DbTrinoAuth));

    const colorRow = h('div', { class: 'db-color-row' });
    const colorInput = h('input', { type: 'color', class: 'db-color-input', value: this.draft.color || '#3e8ef7', 'aria-label': 'Custom color' });
    const paintColors = () => {
      colorRow.replaceChildren(
        h('button', { class: 'db-swatch db-swatch-none' + (!this.draft.color ? ' is-on' : ''), type: 'button', title: 'No color', onclick: () => { this.set('color', ''); paintColors(); } }, '×'),
        ...COLORS.map((c) =>
          h('button', {
            class: 'db-swatch' + (this.draft.color === c ? ' is-on' : ''),
            type: 'button',
            style: `background:${c}`,
            title: c,
            'aria-label': `Color ${c}`,
            onclick: () => { this.set('color', c); paintColors(); },
          }),
        ),
        colorInput,
      );
    };
    colorInput.addEventListener('input', () => { this.set('color', colorInput.value); paintColors(); });
    paintColors();

    const sshToggle = h('input', { type: 'checkbox', id: `${this.uid}-ssh` });
    sshToggle.checked = this.draft.sshEnabled;
    sshToggle.addEventListener('change', () => {
      this.set('sshEnabled', sshToggle.checked);
      this.sshBox.hidden = !sshToggle.checked;
    });
    this.sshBox.hidden = !this.draft.sshEnabled;

    const browse = h('button', { class: 'db-btn', type: 'button', onclick: () => void this.browseKey() }, 'Browse...');
    this.sshBox.append(
      this.field('SSH host', this.text('sshHost', 'bastion.example.com'), 'sshHost'),
      this.field('SSH port', this.text('sshPort', '22', 'numeric'), 'sshPort'),
      this.field('SSH user', this.text('sshUser', 'Same as your login name'), 'sshUser'),
      this.field('Key file', h('div', { class: 'db-inline' }, this.text('sshIdentityFile', 'Empty: ssh picks the key (agent, ~/.ssh/config)'), browse), 'sshIdentityFile'),
      h('div', { class: 'db-hint' }, 'Kestrel starts the system ssh program with BatchMode, so ~/.ssh/config, keys and the ssh agent work. Password login for ssh is not supported.'),
    );

    this.keychainBox.addEventListener('change', () => {
      this.saveInKeychain = this.keychainBox.checked;
      this.markDirty();
    });
    this.passwordInput.addEventListener('input', () => {
      this.password = this.passwordInput.value;
      this.markDirty();
    });

    this.root.append(
      h(
        'div',
        { class: 'db-form-inner' },
        this.heading,
        h('div', { class: 'db-form-group' },
          this.field('Name', this.text('name', 'Shop (production)'), 'name'),
          this.field('Driver', driver, 'driver'),
          this.field('Host', this.text('host', '127.0.0.1'), 'host'),
          this.field('Port', this.text('port', '3306', 'numeric'), 'port'),
          this.field('User', this.text('user', 'root'), 'user'),
          this.only(this.trinoOnly, this.field('Login', h('div', null, auth, this.oauthHint), 'trinoAuth')),
          this.only(
            this.passwordOnly,
            this.field(
              'Password',
              h(
                'div',
                null,
                this.passwordInput,
                h('label', { class: 'db-check', for: `${this.uid}-kc` }, this.keychainBox, 'Save password in keychain'),
                h('div', { class: 'db-hint' }, 'The password is stored in the keychain of your operating system, never in settings.json. Without it, Kestrel asks when the server refuses the login.'),
              ),
            ),
          ),
          this.only(this.trinoOnly, this.field('Catalog', this.text('catalog', 'For example hive'), 'catalog')),
          this.field('Database', this.text('database', 'Optional: default database'), 'database'),
          this.field('TLS', ssl),
        ),
        this.only(this.mysqlOnly, h('h3', { class: 'db-form-section' }, 'SSH Tunnel')),
        this.only(
          this.mysqlOnly,
          h('div', { class: 'db-form-group' },
            h('label', { class: 'db-check', for: `${this.uid}-ssh` }, sshToggle, 'Connect through an SSH tunnel'),
            this.sshBox,
          ),
        ),
        h('h3', { class: 'db-form-section' }, 'Safety and Options'),
        h('div', { class: 'db-form-group' },
          this.check('production', 'Production database', 'Shows a red bar in consoles and asks before statements that change data.'),
          this.check('readOnly', 'Read-only', 'MySQL: every session runs SET SESSION TRANSACTION READ ONLY after it connects. Trino: Kestrel refuses statements other than SELECT, WITH, SHOW, DESCRIBE, EXPLAIN and VALUES.'),
          this.field('Color', colorRow),
          this.field('Run after connect', this.area('initSql', "SET time_zone = '+09:00'"), 'initSql'),
          this.field('Connect timeout', h('div', { class: 'db-inline' }, this.text('connectTimeoutSec', '10', 'numeric'), h('span', { class: 'db-faint' }, 'seconds')), 'connectTimeoutSec'),
        ),
        h('div', { class: 'db-form-buttons' }, this.testBtn, h('span', { class: 'db-spacer' }), this.deleteBtn, this.cancelBtn, this.saveBtn),
        this.testResult,
      ),
    );
    host.append(this.root);
    this.dbLabel = this.inputs.get('database')!.closest('.db-field')!.querySelector('.db-field-label')!;
    this.applyEngine();
    this.refreshHeading();
    this.deleteBtn.hidden = this.isNew;

    void dbPasswordExists(id).then(
      (has) => {
        if (this.disposed) return;
        this.keychainHas = has;
        this.saveInKeychain = has;
        this.keychainInitial = has;
        this.keychainBox.checked = has;
        if (has) this.passwordInput.placeholder = 'A password is saved. Type here to replace it.';
      },
      () => undefined,
    );
  }

  // --- Building blocks ------------------------------------------------------------------

  private field(label: string, control: HTMLElement, key?: DraftField): HTMLElement {
    const err = h('div', { class: 'db-field-error', role: 'alert' });
    if (key) this.errEls.set(key, err);
    const labelFor = key && this.inputs.get(key) ? `${this.uid}-${key}` : null;
    return h('div', { class: 'db-field' }, h('label', { class: 'db-field-label', for: labelFor }, label), h('div', { class: 'db-field-body' }, control, err));
  }

  private text(key: DraftField, placeholder: string, mode?: 'numeric'): HTMLInputElement {
    const input = h('input', {
      class: 'db-input',
      type: 'text',
      id: `${this.uid}-${key}`,
      placeholder,
      spellcheck: 'false',
      autocomplete: 'off',
      inputmode: mode ?? null,
    });
    input.value = String(this.draft[key]);
    input.addEventListener('input', () => this.set(key, input.value));
    this.inputs.set(key, input);
    return input;
  }

  private area(key: DraftField, placeholder: string): HTMLTextAreaElement {
    const area = h('textarea', { class: 'db-input db-area', id: `${this.uid}-${key}`, placeholder, rows: 3, spellcheck: 'false' });
    area.value = String(this.draft[key]);
    area.addEventListener('input', () => this.set(key, area.value));
    this.inputs.set(key, area);
    return area;
  }

  private check(key: 'production' | 'readOnly', label: string, hint: string): HTMLElement {
    const box = h('input', { type: 'checkbox', id: `${this.uid}-${key}` });
    box.checked = this.draft[key];
    box.addEventListener('change', () => this.set(key, box.checked));
    return h('div', { class: 'db-field' }, h('span', { class: 'db-field-label' }), h('div', { class: 'db-field-body' }, h('label', { class: 'db-check', for: `${this.uid}-${key}` }, box, label), h('div', { class: 'db-hint' }, hint)));
  }

  /** Remembers a part of the form that only some engines or logins use. */
  private only(list: HTMLElement[], el: HTMLElement): HTMLElement {
    list.push(el);
    return el;
  }

  /** Replaces the whole draft (engine or TLS changed: port and login can change too) and shows it. */
  private replaceDraft(next: ConnDraft): void {
    this.draft = next;
    for (const [key, input] of this.inputs) {
      const v = String(next[key]);
      if (input.value !== v && !(input === this.sslSelect)) input.value = v;
    }
    this.applyEngine();
    this.markDirty();
    if (this.shownErrors) this.showErrors(validateDraft(this.draft));
  }

  /** Shows the fields of the chosen engine and login. */
  private applyEngine(): void {
    const trino = this.draft.driver === 'trino';
    for (const el of this.mysqlOnly) el.hidden = trino;
    for (const el of this.trinoOnly) el.hidden = !trino;
    for (const el of this.passwordOnly) el.hidden = trino && this.draft.trinoAuth !== 'password';
    this.oauthHint.hidden = !(trino && this.draft.trinoAuth === 'oauth2');
    this.dbLabel.textContent = trino ? 'Schema' : 'Database';
    const db = this.inputs.get('database');
    if (db) db.setAttribute('placeholder', trino ? 'Optional: default schema' : 'Optional: default database');
    this.inputs.get('port')?.setAttribute('placeholder', trino ? '443' : '3306');
    // Trino knows only https and http. MySQL has three TLS modes.
    const options: [DbSslMode, string][] = trino
      ? [['required', 'Required: use https'], ['disabled', 'Disabled: use http (no TLS)']]
      : [['preferred', 'Preferred: use TLS when the server offers it'], ['required', 'Required: fail when TLS is not possible'], ['disabled', 'Disabled: no TLS']];
    this.sslSelect.replaceChildren(...options.map(([value, text]) => h('option', { value }, text)));
    this.sslSelect.value = this.draft.ssl;
    const auth = this.inputs.get('trinoAuth');
    if (auth) auth.value = this.draft.trinoAuth;
  }

  private set<K extends DraftField>(key: K, value: ConnDraft[K]): void {
    this.draft[key] = value;
    if (key === 'trinoAuth') this.applyEngine();
    this.markDirty();
    if (this.shownErrors) this.showErrors(validateDraft(this.draft));
  }

  private showErrors(errors: DraftErrors): void {
    for (const [key, el] of this.errEls) el.textContent = errors[key] ?? '';
  }

  private hasChanges(): boolean {
    return !sameDraft(this.draft, this.initial) || this.password !== '' || this.saveInKeychain !== this.keychainInitial;
  }

  private markDirty(): void {
    this.hub.ctx.tabs.setDirty(this.tabId, this.hasChanges());
    this.refreshHeading();
  }

  private refreshHeading(): void {
    const name = this.draft.name.trim();
    this.heading.textContent = this.isNew ? 'New Connection' : `Connection: ${this.initial.name}`;
    this.hub.ctx.tabs.setTitle(this.tabId, this.isNew ? (name ? `New: ${name}` : 'New Connection') : `Connection: ${this.initial.name}`);
  }

  // --- Actions ----------------------------------------------------------------------------

  /** Returns the config when the form is valid. Otherwise it shows the errors. */
  private checked() {
    const errors = validateDraft(this.draft);
    this.shownErrors = true;
    this.showErrors(errors);
    const first = Object.keys(errors)[0] as DraftField | undefined;
    if (first) {
      this.inputs.get(first)?.focus();
      return null;
    }
    return configFromDraft(this.draft);
  }

  private async test(): Promise<void> {
    const config = this.checked();
    if (!config) return;
    const token = ++this.testToken;
    this.testBtn.disabled = true;
    this.testResult.className = 'db-test-result';
    const browserLogin = config.driver === 'trino' && config.trinoAuth === 'oauth2';
    if (browserLogin) {
      // The login can take up to 3 minutes. Cancel only closes the wait in this form.
      const stop = h('button', { class: 'db-link', type: 'button', onclick: () => {
        this.testToken++;
        this.testBtn.disabled = false;
        this.testResult.textContent = 'Login cancelled.';
      } }, 'Cancel');
      this.testResult.replaceChildren('Waiting for login in your browser…', stop);
    } else {
      this.testResult.textContent = 'Connecting...';
    }
    try {
      const usePassword = config.driver !== 'trino' || config.trinoAuth === 'password';
      const r = await dbTest({ config, password: usePassword ? this.password || this.hub.getPassword(this.id) : null });
      if (token !== this.testToken || this.disposed) return;
      this.testResult.className = 'db-test-result is-ok';
      this.testResult.textContent = `Connected. ${config.driver === 'trino' ? 'Trino' : 'MySQL'} server version ${r.serverVersion}.`;
    } catch (e) {
      if (token !== this.testToken || this.disposed) return;
      this.testResult.className = 'db-test-result is-error';
      this.testResult.textContent = describeError(e).text;
    } finally {
      if (token === this.testToken) this.testBtn.disabled = false;
    }
  }

  /** The Save button. The shell calls it too when you close a tab with changes and choose Save. */
  async save(): Promise<boolean> {
    const config = this.checked();
    if (!config) return false;
    this.saveBtn.disabled = true;
    try {
      await this.hub.ctx.settings.update({ 'db.connections': upsertConnection(this.hub.connections(), config) });
      // The password goes to the keychain only on request.
      if (this.saveInKeychain) {
        if (this.password) await dbPasswordSet(this.id, this.password);
        else if (!this.keychainHas) this.hub.ctx.ui.notify('No password was typed, so none was saved in the keychain.', { kind: 'warn' });
      } else if (this.keychainHas) {
        await dbPasswordDelete(this.id);
      }
      if (this.password) this.hub.setPassword(this.id, this.password);
      else if (!this.saveInKeychain) this.hub.setPassword(this.id, null);
      this.keychainHas = this.saveInKeychain && (this.keychainHas || !!this.password);
      this.keychainBox.checked = this.saveInKeychain && this.keychainHas;
      this.saveInKeychain = this.keychainBox.checked;
      this.keychainInitial = this.saveInKeychain;
      this.password = '';
      this.passwordInput.value = '';
      this.passwordInput.placeholder = this.keychainHas ? 'A password is saved. Type here to replace it.' : '';
      // Sessions of this connection use the old settings. A new tree and new consoles use the new ones.
      this.hub.closeMeta(this.id);
      this.initial = { ...this.draft };
      this.isNew = false;
      this.deleteBtn.hidden = false;
      this.markDirty();
      this.hub.ctx.ui.notify(`Saved the connection "${config.name}".`, { timeoutMs: 2500 });
      return true;
    } catch (e) {
      this.hub.ctx.ui.notify(`Could not save the connection: ${describeError(e).text}`, { kind: 'error' });
      return false;
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  private async cancel(): Promise<void> {
    await this.hub.ctx.tabs.close(this.tabId, { force: true });
  }

  private async remove(): Promise<void> {
    const ctx = this.hub.ctx;
    const answer = await ctx.ui.confirm({
      title: `Delete the connection "${this.initial.name}"?`,
      message: 'The saved password is removed from the keychain too.',
      buttons: ['Delete', 'Cancel'],
    });
    if (answer !== 'Delete') return;
    try {
      await ctx.settings.update({ 'db.connections': removeConnection(this.hub.connections(), this.id) });
      this.hub.closeMeta(this.id);
      this.hub.setPassword(this.id, null);
      await dbPasswordDelete(this.id).catch(() => undefined);
      await ctx.tabs.close(this.tabId, { force: true });
    } catch (e) {
      ctx.ui.notify(`Could not delete the connection: ${describeError(e).text}`, { kind: 'error' });
    }
  }

  private async browseKey(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ title: 'Choose the private key file', multiple: false, directory: false });
      if (typeof picked === 'string') {
        this.set('sshIdentityFile', picked);
        const input = this.inputs.get('sshIdentityFile');
        if (input) input.value = picked;
      }
    } catch (e) {
      this.hub.ctx.ui.notify(`Could not open the file dialog: ${describeError(e).text}`, { kind: 'error' });
    }
  }

  // --- TabContent ------------------------------------------------------------------------------

  focus(): void {
    (this.inputs.get('name') ?? this.root).focus();
  }

  isDirty(): boolean {
    return this.hasChanges();
  }

  dispose(): void {
    this.disposed = true;
    this.root.remove();
  }
}
