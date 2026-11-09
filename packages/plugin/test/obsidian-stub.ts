// Minimal runtime stand-in for the `obsidian` module in unit tests (see ../vitest.config.mts).
export class Plugin {
  async onload(): Promise<void> {}
  onunload(): void {}
}
