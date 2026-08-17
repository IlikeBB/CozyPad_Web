/**
 * 建立在「能在遠端執行一條命令」之上的服務層。
 * Electron bridge 與測試 mock 共用同一份實作，唯一的平台差異是傳進來的 exec 函式。
 */
export * from './RemoteFilesPort';
export * from './shellRemoteFiles';
export * from './telemetryService';
export * from './tmuxProvisioner';
export * from './remoteSettingsService';
