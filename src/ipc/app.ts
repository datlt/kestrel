import { invoke } from './invoke';

export interface SettingsFile {
  path: string;
  /** null when the file does not exist yet. */
  text: string | null;
}

export interface AppInfo {
  version: string;
  platform: 'macos' | 'windows' | 'linux';
  configDir: string;
  dataDir: string;
  cacheDir: string;
}

export const appSettingsRead = () => invoke<SettingsFile>('app_settings_read');
export const appSettingsWrite = (text: string) => invoke<void>('app_settings_write', { text });
export const appInfo = () => invoke<AppInfo>('app_info');
export const appLog = (level: 'info' | 'warn' | 'error', message: string) =>
  invoke<void>('app_log', { level, message }).catch(() => {});
