// Minimal runtime stand-in for the `obsidian` module in unit tests (see ../vitest.config.mts). The
// real package ships type declarations only. Elements are tiny fakes: tests run without a DOM.

export class FakeEl {
  attrs = new Map<string, string>();
  classes = new Set<string>();
  text = "";
  children: FakeEl[] = [];
  icon: string | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  addClass(c: string): void { this.classes.add(c); }
  removeClass(c: string): void { this.classes.delete(c); }
  setAttr(k: string, v: string): void { this.attrs.set(k, v); }
  getAttr(k: string): string | null { return this.attrs.get(k) ?? null; }
  empty(): void { this.children = []; this.text = ""; this.icon = null; }
  setText(s: string): void { this.text = s; }
  createEl(_tag: string, o: { text?: string; cls?: string } = {}): FakeEl { const e = new FakeEl(); if (o.text) e.text = o.text; if (o.cls) e.classes.add(o.cls); this.children.push(e); return e; }
  createDiv(o: { text?: string; cls?: string } = {}): FakeEl { return this.createEl("div", o); }
  createSpan(o: { text?: string; cls?: string } = {}): FakeEl { return this.createEl("span", o); }
  addEventListener(type: string, cb: (ev: unknown) => void): void { const l = this.listeners.get(type) ?? []; l.push(cb); this.listeners.set(type, l); }
}

export function setIcon(el: FakeEl, icon: string): void { el.icon = icon; }

export const Platform = {
  isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false,
  isPhone: false, isTablet: false, isMacOS: false, isWin: false, isLinux: true, isSafari: false,
};

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests");
}

export class Notice {
  static shown: string[] = [];
  noticeEl = new FakeEl();
  constructor(readonly message: string, readonly timeout?: number) { Notice.shown.push(message); }
  hide(): void {}
}

export interface Command { id: string; name: string; callback?: () => unknown; checkCallback?: (checking: boolean) => boolean | void }

export class Plugin {
  readonly commands: Command[] = [];
  readonly statusBar: FakeEl[] = [];
  readonly ribbon: FakeEl[] = [];
  readonly protocolHandlers = new Map<string, (p: unknown) => void>();
  settingTabs: unknown[] = [];
  data: unknown = null;
  constructor(readonly app: any, readonly manifest: unknown = { id: "shuttle" }) {}
  async onload(): Promise<void> {}
  onunload(): void {}
  addCommand(c: Command): Command { this.commands.push(c); return c; }
  addStatusBarItem(): FakeEl { const e = new FakeEl(); this.statusBar.push(e); return e; }
  addRibbonIcon(icon: string, _title: string, _cb: (ev: unknown) => void): FakeEl { const e = new FakeEl(); e.icon = icon; this.ribbon.push(e); return e; }
  addSettingTab(tab: unknown): void { this.settingTabs.push(tab); }
  registerDomEvent(): void {}
  registerEvent(): void {}
  registerInterval(id: number): number { return id; }
  registerObsidianProtocolHandler(action: string, h: (p: unknown) => void): void { this.protocolHandlers.set(action, h); }
  async loadData(): Promise<unknown> { return this.data; }
  async saveData(d: unknown): Promise<void> { this.data = structuredClone(d); }
}

export class Modal {
  contentEl = new FakeEl();
  titleEl = new FakeEl();
  modalEl = new FakeEl();
  constructor(readonly app: unknown) {}
  open(): void { (this as unknown as { onOpen?: () => void }).onOpen?.(); }
  close(): void { (this as unknown as { onClose?: () => void }).onClose?.(); }
}

export class PluginSettingTab {
  containerEl = new FakeEl();
  constructor(readonly app: unknown, readonly plugin: unknown) {}
}

class Component {
  inputEl: Record<string, unknown> & { addEventListener(): void; focus(): void } = { addEventListener() {}, focus() {} };
  private v: unknown = "";
  setButtonText(): this { return this; }
  setCta(): this { return this; }
  setWarning(): this { return this; }
  setDisabled(): this { return this; }
  setPlaceholder(): this { return this; }
  setValue(v: unknown): this { this.v = v; return this; }
  getValue(): unknown { return this.v; }
  onClick(): this { return this; }
  onChange(): this { return this; }
  addOption(): this { return this; }
}

export class Setting {
  settingEl = new FakeEl();
  constructor(readonly containerEl: unknown) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  setHeading(): this { return this; }
  addButton(cb: (c: Component) => unknown): this { cb(new Component()); return this; }
  addText(cb: (c: Component) => unknown): this { cb(new Component()); return this; }
  addToggle(cb: (c: Component) => unknown): this { cb(new Component()); return this; }
  addDropdown(cb: (c: Component) => unknown): this { cb(new Component()); return this; }
}

export class Menu {
  items: string[] = [];
  addItem(cb: (i: { setTitle(s: string): unknown; setIcon(): unknown; setDisabled(): unknown; onClick(): unknown }) => unknown): this {
    const item = { setTitle: (s: string) => { this.items.push(s); return item; }, setIcon: () => item, setDisabled: () => item, onClick: () => item };
    cb(item);
    return this;
  }
  addSeparator(): this { return this; }
  showAtMouseEvent(): this { return this; }
}
