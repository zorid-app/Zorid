/**
 * Original, DOM-owned implementations of the supported plugin setting controls.
 * These are UI controls, separate from the load/unload Component hierarchy.
 */
export interface TooltipOptions {
  placement?: 'top' | 'right' | 'bottom' | 'left';
  classes?: string[];
  gap?: number;
  delay?: number;
}

function tooltip(element: HTMLElement, text: string, options: TooltipOptions = {}): void {
  element.setAttribute('aria-label', text);
  // Native tooltips remain usable before a host tooltip renderer is connected.
  element.title = text;
  if (options.placement && options.placement !== 'bottom') element.dataset.tooltipPosition = options.placement;
  if (options.classes) element.dataset.tooltipClasses = options.classes.join(' ');
  if (options.delay) element.dataset.tooltipDelay = String(options.delay);
  if (options.gap) element.dataset.tooltipGap = String(options.gap);
}

function append<K extends keyof HTMLElementTagNameMap>(container: HTMLElement, tag: K, classes = ''): HTMLElementTagNameMap[K] {
  const element = container.ownerDocument.createElement(tag);
  element.className = classes;
  container.append(element);
  return element;
}

function addClasses(element: HTMLElement, classes: string): void {
  const tokens = classes.split(/\s+/).filter(Boolean);
  if (tokens.length) element.classList.add(...tokens);
}

export class BaseComponent {
  disabled = false;

  then(callback: (component: this) => unknown): this {
    callback(this);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  abstract getValue(): T;
  abstract setValue(value: T): this;

  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    listeners[key] = (value) => {
      if (value !== undefined) this.setValue(value);
      return this.getValue();
    };
    return this;
  }
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  inputEl: T;
  private changeCallback?: (value: string) => unknown;

  constructor(inputEl: T) {
    super();
    this.inputEl = inputEl;
    inputEl.setAttribute('spellcheck', 'false');
    inputEl.addEventListener('input', () => this.onChanged());
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }

  getValue(): string { return this.inputEl.value; }

  setValue(value: string): this {
    if (typeof value === 'string') this.inputEl.value = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  onChanged(): void {
    const callback = this.changeCallback;
    callback?.(this.getValue());
  }

  onChange(callback: (value: string) => unknown): this {
    this.changeCallback = callback;
    return this;
  }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) {
    const input = append(containerEl, 'input');
    input.type = 'text';
    super(input);
  }
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) { super(append(containerEl, 'textarea')); }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private value = false;
  private changeCallback?: (value: boolean) => unknown;

  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = append(containerEl, 'label', 'checkbox-container');
    this.toggleEl.tabIndex = 0;
    this.toggleEl.setAttribute('role', 'switch');
    this.toggleEl.setAttribute('aria-checked', 'false');
    this.inputEl = append(this.toggleEl, 'input');
    this.inputEl.type = 'checkbox';
    this.inputEl.tabIndex = -1;
    this.toggleEl.addEventListener('change', () => this.onClick());
    this.toggleEl.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      this.onClick();
    });
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.toggleEl.classList.toggle('is-disabled', disabled);
    this.toggleEl.setAttribute('aria-disabled', String(disabled));
    this.inputEl.disabled = disabled;
    return this;
  }

  getValue(): boolean { return this.value; }

  setValue(value: boolean): this {
    if (this.value === value) return this;
    this.value = value;
    this.inputEl.checked = value;
    this.toggleEl.classList.toggle('is-enabled', value);
    this.toggleEl.setAttribute('aria-checked', String(value));
    this.changeCallback?.(value);
    return this;
  }

  setSmall(): this { this.toggleEl.classList.add('mod-small'); return this; }

  setTooltip(text: string, options?: TooltipOptions): this {
    tooltip(this.toggleEl, text, options);
    return this;
  }

  onClick(): void {
    if (!this.disabled) this.setValue(!this.value);
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.changeCallback = callback;
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  private clickCallback?: (event: MouseEvent) => unknown | Promise<unknown>;

  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = append(containerEl, 'button');
    this.buttonEl.type = 'button';
    this.buttonEl.addEventListener('click', async (event) => {
      const callback = this.clickCallback;
      if (this.disabled || !callback) return;
      this.setLoading(true);
      try { await callback(event); }
      finally { this.setLoading(false); }
    });
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }

  setLoading(loading: boolean): this { this.buttonEl.classList.toggle('mod-loading', loading); return this; }
  setCta(): this { this.buttonEl.classList.add('mod-cta'); return this; }
  removeCta(): this { this.buttonEl.classList.remove('mod-cta'); return this; }
  setDestructive(): this { this.buttonEl.classList.add('mod-destructive'); return this; }
  removeDestructive(): this { this.buttonEl.classList.remove('mod-destructive'); return this; }
  setWarning(): this { return this.setDestructive().setCta(); }
  setClass(classes: string): this { addClasses(this.buttonEl, classes); return this; }
  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }

  setTooltip(text: string, options?: TooltipOptions): this {
    tooltip(this.buttonEl, text, options);
    return this;
  }

  onClick(callback: (event: MouseEvent) => unknown | Promise<unknown>): this {
    this.clickCallback = callback;
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  private changeCallback?: (value: string) => unknown;

  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = append(containerEl, 'select', 'dropdown');
    this.selectEl.addEventListener('change', () => {
      const callback = this.changeCallback;
      callback?.(this.getValue());
    });
    this.selectEl.addEventListener('mousedown', () => this.selectEl.classList.add('mouse-focus'));
    this.selectEl.addEventListener('blur', () => this.selectEl.classList.remove('mouse-focus'));
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }

  addOption(value: string, display: string): this {
    const option = append(this.selectEl, 'option');
    option.value = value;
    option.textContent = display;
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }

  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; return this; }

  onChange(callback: (value: string) => unknown): this {
    this.changeCallback = callback;
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];
  errorEl: HTMLElement | null = null;
  disabled = false;

  constructor(containerEl: HTMLElement) {
    this.settingEl = append(containerEl, 'div', 'setting-item');
    this.settingEl.tabIndex = -1;
    this.infoEl = append(this.settingEl, 'div', 'setting-item-info');
    this.nameEl = append(this.infoEl, 'div', 'setting-item-name');
    this.descEl = append(this.infoEl, 'div', 'setting-item-description');
    this.controlEl = append(this.settingEl, 'div', 'setting-item-control');
  }

  setName(name: string | DocumentFragment): this { this.nameEl.replaceChildren(name); return this; }
  setDesc(description: string | DocumentFragment): this { this.descEl.replaceChildren(description); return this; }
  setClass(classes: string): this { addClasses(this.settingEl, classes); return this; }
  setHeading(): this { this.settingEl.classList.add('setting-item-heading'); return this; }
  setNoInfo(): this { this.infoEl.hidden = true; return this; }
  setVisibility(visible: boolean): this { this.settingEl.hidden = !visible; return this; }

  setTooltip(text: string, options?: TooltipOptions): this {
    tooltip(this.nameEl, text, options);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.settingEl.classList.toggle('is-disabled', disabled);
    for (const component of this.components) component.setDisabled(disabled);
    return this;
  }

  setErrorMessage(message: string | null): this {
    if (message) {
      this.errorEl ??= append(this.controlEl, 'div', 'setting-item-error');
      this.errorEl.textContent = message;
      this.errorEl.hidden = false;
    } else if (this.errorEl) this.errorEl.hidden = true;
    this.settingEl.classList.toggle('is-invalid', Boolean(message));
    return this;
  }

  private add<T extends BaseComponent>(component: T, callback: (component: T) => unknown): this {
    this.components.push(component);
    callback(component);
    return this;
  }

  addText(callback: (component: TextComponent) => unknown): this { return this.add(new TextComponent(this.controlEl), callback); }
  addTextArea(callback: (component: TextAreaComponent) => unknown): this { return this.add(new TextAreaComponent(this.controlEl), callback); }
  addButton(callback: (component: ButtonComponent) => unknown): this { return this.add(new ButtonComponent(this.controlEl), callback); }
  addDropdown(callback: (component: DropdownComponent) => unknown): this { return this.add(new DropdownComponent(this.controlEl), callback); }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    this.add(new ToggleComponent(this.controlEl), callback);
    this.settingEl.classList.add('mod-toggle');
    return this;
  }

  addComponent(callback: (containerEl: HTMLElement) => BaseComponent): this {
    this.components.push(callback(this.controlEl));
    return this;
  }

  then(callback: (setting: this) => unknown): this { callback(this); return this; }

  clear(): this {
    this.controlEl.replaceChildren();
    this.components = [];
    this.errorEl = null;
    this.settingEl.classList.remove('is-invalid');
    return this;
  }
}
