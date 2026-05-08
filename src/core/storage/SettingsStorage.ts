/**
 * SettingsStorage - Handles settings.json read/write in vault/.claude/
 *
 * Settings are stored as JSON in the vault's .claude/settings.json file.
 * This replaces the previous approach of storing settings in Obsidian's data.json.
 *
 * User-facing settings go here (including permissions, like Claude Code).
 * Machine-specific state (lastEnvHash, model tracking) stays in Obsidian's data.json.
 */

import type { ObsidianCodeSettings, Permission, PlatformBlockedCommands } from '../types';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Fields that are machine-specific state or loaded separately. */
type StateFields =
  | 'slashCommands'
  | 'lastEnvHash'
  | 'lastClaudeModel'
  | 'lastCustomModel';

/** Settings stored in .claude/settings.json (user-facing, shareable). */
export type StoredSettings = Omit<ObsidianCodeSettings, StateFields>;

/** Path to settings file relative to vault root. */
export const SETTINGS_PATH = '.claude/settings.json';

function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Coerces stored `permissions` into the array shape this plugin expects.
 *
 * The plugin uses `Permission[]` (a list of "Always Allow" approvals).
 * However, the Claude Code CLI uses the same .claude/settings.json file with
 * a different schema (`{ allow?: string[]; deny?: string[] }`). When users
 * have both tools writing to this file, plugin reads can encounter the wrong
 * shape; render code (for...of, .filter, .length) then throws.
 *
 * Anything that is not an array of valid Permission entries is treated as
 * empty so the settings UI never crashes on cross-tool data.
 */
function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Permission =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as Permission).toolName === 'string' &&
      typeof (item as Permission).pattern === 'string'
  );
}

function normalizeBlockedCommands(value: unknown): PlatformBlockedCommands {
  const defaults = getDefaultBlockedCommands();

  // Migrate old string[] format to new platform-keyed structure
  if (Array.isArray(value)) {
    return {
      unix: normalizeCommandList(value, defaults.unix),
      windows: [...defaults.windows],
    };
  }

  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    unix: normalizeCommandList(candidate.unix, defaults.unix),
    windows: normalizeCommandList(candidate.windows, defaults.windows),
  };
}

export class SettingsStorage {
  constructor(private adapter: VaultFileAdapter) {}

  /** Load settings from .claude/settings.json, merging with defaults. */
  async load(): Promise<StoredSettings> {
    try {
      if (!(await this.adapter.exists(SETTINGS_PATH))) {
        return this.getDefaults();
      }

      const content = await this.adapter.read(SETTINGS_PATH);
      const stored = JSON.parse(content) as Record<string, unknown>;
      const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
      const permissions = normalizePermissions(stored.permissions);

      return {
        ...this.getDefaults(),
        ...stored,
        blockedCommands,
        permissions,
      } as StoredSettings;
    } catch (error) {
      console.error('[ObsidianCode] Failed to load settings:', error);
      return this.getDefaults();
    }
  }

  /** Save settings to .claude/settings.json. */
  async save(settings: StoredSettings): Promise<void> {
    try {
      const content = JSON.stringify(settings, null, 2);
      await this.adapter.write(SETTINGS_PATH, content);
    } catch (error) {
      console.error('[ObsidianCode] Failed to save settings:', error);
      throw error;
    }
  }

  /** Check if settings file exists. */
  async exists(): Promise<boolean> {
    return this.adapter.exists(SETTINGS_PATH);
  }

  /** Get default settings (excluding state fields). */
  private getDefaults(): StoredSettings {
    const {
      slashCommands: _,
      lastEnvHash: __,
      lastClaudeModel: ___,
      lastCustomModel: ____,
      ...defaults
    } = DEFAULT_SETTINGS;
    return defaults;
  }
}
