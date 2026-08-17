import type { PlatformBridge } from '@cozypad/contracts';
import { createMockBridge } from './mockBridge';

let cached: PlatformBridge | null = null;

/**
 * 依執行環境選擇平台實作：
 * Electron preload 注入的 bridge → 瀏覽器 mock。
 */
export function getBridge(): PlatformBridge {
  if (cached !== null) return cached;

  if (window.cozypad !== undefined) {
    cached = window.cozypad;
    return cached;
  }

  cached = createMockBridge();
  return cached;
}
