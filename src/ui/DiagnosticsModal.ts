import { Modal, Notice, type App, type WorkspaceLeaf } from 'obsidian';
import { atlasPlugin, atlasVersion } from '../atlas/bridge';
import { formatReport, inspect } from '../atlas/internals';

export class DiagnosticsModal extends Modal {
  constructor(app: App, private readonly leaf: WorkspaceLeaf | null) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('Atlas 3D: compatibility with Atlas VTT');

    if (atlasPlugin(this.app) === undefined) {
      contentEl.createEl('p', { text: 'Atlas VTT is not installed or not enabled.' });
      return;
    }
    if (this.leaf === null) {
      contentEl.createEl('p', { text: 'Open a scene in Atlas VTT first, then run this again: the hooks are checked on its tab.' });
      return;
    }

    const version = atlasVersion(this.app);
    const capabilities = inspect(this.leaf);
    contentEl.createEl('p', { text: version ? `Atlas VTT ${version}` : 'Atlas VTT (version unknown)' });

    const list = contentEl.createEl('ul', { cls: 'atlas3d-diagnostics' });
    for (const c of capabilities) {
      const item = list.createEl('li', { cls: c.ok ? 'is-ok' : 'is-missing' });
      item.createSpan({ cls: 'atlas3d-diagnostics-mark', text: c.ok ? '✓' : '✗' });
      item.createSpan({ text: c.ok ? ` ${c.feature}` : ` ${c.feature} — without it: ${c.without}` });
    }

    const present = capabilities.filter((c) => c.ok).length;
    contentEl.createEl('p', { cls: 'atlas3d-muted', text: `${present} of ${capabilities.length} hooks available.` });
    const copy = contentEl.createEl('button', { text: 'Copy report' });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(formatReport(version, capabilities)).then(() => new Notice('Report copied.'));
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}