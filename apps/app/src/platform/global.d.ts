import type { PlatformBridge } from '@cozypad/contracts';

declare global {
  interface Window {
    /** Electron preload 注入的 bridge；瀏覽器模式下不存在。 */
    cozypad?: PlatformBridge;
  }
}

export {};
