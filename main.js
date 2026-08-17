const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const EXCALIDRAW_VIEW_TYPE = "excalidraw";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

const DEFAULT_SETTINGS = {
  enabled: false,
  smoothing: 0,
  streamline: 0,
  thinning: 0,
  linearEasing: true,
  removeTaper: true,
  reapplyIntervalMs: 500,
  backups: {}
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getFileKey(view) {
  return view?.file?.path || view?.leaf?.id || "active-excalidraw";
}

class ExcalidrawLowLatencyPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() || {});
    this.settings.backups = this.settings.backups || {};

    this.addSettingTab(new LowLatencySettingTab(this.app, this));

    this.addCommand({
      id: "toggle-low-latency-mode",
      name: "Toggle low-latency drawing mode",
      callback: () => this.toggleMode()
    });

    this.addCommand({
      id: "apply-low-latency-mode",
      name: "Apply low-latency drawing mode now",
      callback: () => this.applyToAllViews(true)
    });

    this.addRibbonIcon("zap", "Toggle Excalidraw low-latency mode", () => this.toggleMode());

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      window.setTimeout(() => this.applyToActiveView(false), 100);
    }));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enabled) {
        window.setTimeout(() => this.applyToAllViews(false), 500);
      }
    });
  }

  getExcalidrawPlugin() {
    return this.app.plugins.getPlugin(EXCALIDRAW_PLUGIN_ID);
  }

  getExcalidrawViews() {
    return this.app.workspace
      .getLeavesOfType(EXCALIDRAW_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view && view.excalidrawAPI);
  }

  getActiveExcalidrawView() {
    const view = this.app.workspace.getActiveViewOfType?.(Object);
    if (view?.excalidrawAPI) return view;
    return this.getExcalidrawViews().find((candidate) => candidate === this.app.workspace.activeLeaf?.view);
  }

  buildLowLatencyOptions(current) {
    const options = Object.assign({}, current?.options || {});

    options.smoothing = Number(this.settings.smoothing);
    options.streamline = Number(this.settings.streamline);
    options.thinning = Number(this.settings.thinning);

    if (this.settings.linearEasing) options.easing = "linear";

    if (this.settings.removeTaper) {
      options.start = Object.assign({}, options.start || {}, { taper: 0 });
      options.end = Object.assign({}, options.end || {}, { taper: 0 });
    }

    return Object.assign({}, current || {}, { options });
  }

  applyToView(view, saveBackup = true) {
    const api = view?.excalidrawAPI;
    if (!api || typeof api.getAppState !== "function" || typeof api.updateScene !== "function") return false;

    const appState = api.getAppState();
    const current = appState?.currentStrokeOptions;
    if (!current) return false;

    const key = getFileKey(view);
    if (saveBackup && !this.settings.backups[key]) {
      this.settings.backups[key] = clone(current);
      this.saveData(this.settings);
    }

    const updated = this.buildLowLatencyOptions(current);
    api.updateScene({ appState: { currentStrokeOptions: updated } });
    return true;
  }

  restoreView(view) {
    const api = view?.excalidrawAPI;
    const backup = this.settings.backups[getFileKey(view)];
    if (!api || !backup || typeof api.updateScene !== "function") return false;
    api.updateScene({ appState: { currentStrokeOptions: clone(backup) } });
    return true;
  }

  applyToActiveView(showNotice) {
    if (!this.settings.enabled) return 0;
    const view = this.getExcalidrawViews().find((candidate) => candidate === this.app.workspace.activeLeaf?.view);
    const applied = view && this.applyToView(view) ? 1 : 0;
    if (showNotice) {
      new Notice(applied ? "Low-latency mode applied." : "Open an Excalidraw drawing first.");
    }
    return applied;
  }

  applyToAllViews(showNotice) {
    if (!this.settings.enabled) return 0;
    const count = this.getExcalidrawViews().filter((view) => this.applyToView(view)).length;
    if (showNotice) {
      new Notice(count ? `Low-latency mode applied to ${count} Excalidraw drawing${count === 1 ? "" : "s"}.` : "Open an Excalidraw drawing first.");
    }
    return count;
  }

  async toggleMode() {
    if (this.settings.enabled) {
      const views = this.getExcalidrawViews();
      views.forEach((view) => this.restoreView(view));
      this.settings.enabled = false;
      this.settings.backups = {};
      await this.saveData(this.settings);
      new Notice("Excalidraw low-latency mode disabled and original pen settings restored.");
      return;
    }

    this.settings.enabled = true;
    await this.saveData(this.settings);
    this.applyToAllViews(false);
    new Notice("Excalidraw low-latency mode enabled.");
  }

  async setEnabled(enabled) {
    if (Boolean(enabled) === this.settings.enabled) return;
    await this.toggleMode();
  }

  restoreOnUnload() {
    if (!this.settings?.enabled) return;
    this.getExcalidrawViews().forEach((view) => this.restoreView(view));
  }

  onunload() {
    this.restoreOnUnload();
  }
}

class LowLatencySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Excalidraw Low Latency" });
    containerEl.createEl("p", {
      text: "This changes the active Excalidraw pen while the mode is enabled. It does not modify your drawing files."
    });

    new Setting(containerEl)
      .setName("Enable low-latency mode")
      .setDesc("Automatically applies the profile to open and newly opened Excalidraw drawings.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange((value) => this.plugin.setEnabled(value)));

    new Setting(containerEl)
      .setName("Smoothing")
      .setDesc("Lower values preserve more of your immediate hand movement.")
      .addSlider((slider) => slider
        .setLimits(0, 1, 0.05)
        .setValue(Number(this.plugin.settings.smoothing))
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.smoothing = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyToAllViews(false);
        }));

    new Setting(containerEl)
      .setName("Streamline")
      .setDesc("Set to zero for the most immediate stroke response.")
      .addSlider((slider) => slider
        .setLimits(0, 1, 0.05)
        .setValue(Number(this.plugin.settings.streamline))
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.streamline = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyToAllViews(false);
        }));

    new Setting(containerEl)
      .setName("Thinning")
      .setDesc("Set to zero for a consistent pen width, or increase it if you want pressure variation.")
      .addSlider((slider) => slider
        .setLimits(-1, 1, 0.05)
        .setValue(Number(this.plugin.settings.thinning))
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.thinning = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyToAllViews(false);
        }));

    new Setting(containerEl)
      .setName("Use linear easing")
      .setDesc("Removes extra easing from the stroke shape.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.linearEasing)
        .onChange(async (value) => {
          this.plugin.settings.linearEasing = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyToAllViews(false);
        }));

    new Setting(containerEl)
      .setName("Remove stroke taper")
      .setDesc("Keeps the beginning and end of a stroke from being delayed or narrowed.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.removeTaper)
        .onChange(async (value) => {
          this.plugin.settings.removeTaper = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyToAllViews(false);
        }));

    new Setting(containerEl)
      .setName("Apply now")
      .setDesc("Apply the current profile to every open Excalidraw drawing.")
      .addButton((button) => button
        .setButtonText("Apply")
        .onClick(() => this.plugin.applyToAllViews(true)));

    new Setting(containerEl)
      .setName("Restore and disable")
      .setDesc("Turn the mode off and restore the pen settings captured before applying it.")
      .addButton((button) => button
        .setWarning()
        .setButtonText("Restore")
        .onClick(() => {
          if (this.plugin.settings.enabled) this.plugin.toggleMode();
        }));
  }
}

module.exports = ExcalidrawLowLatencyPlugin;
