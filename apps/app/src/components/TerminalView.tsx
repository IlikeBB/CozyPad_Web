import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { createLegacyWebSocketUrl } from '../platform/legacyApiRoutes';

const LEGACY_TERMINAL_RECONNECT_MAX_ATTEMPTS = 240;
const LEGACY_TERMINAL_CONTROL_PREFIX = '\0COZYPAD:';
const TERMINAL_OPEN_TIMEOUT_MS = 30000;

export interface TerminalModifiers {
  ctrl: boolean;
  alt: boolean;
}

export interface TerminalHandle {
  paste(text: string): void;
  run(command: string): void;
  focus(): void;
  /** 直接送出原始序列（ESC、方向鍵等），不套用 modifier。 */
  sendRaw(data: string): void;
  /** sticky modifier：作用於下一個輸入字元（Termux 行為）。 */
  setModifier(mod: 'ctrl' | 'alt', on: boolean): void;
}

/** a-z 與 @[\]^_ 轉為對應 control character（Ctrl+C → \x03）。 */
function toControlChar(ch: string): string | null {
  if (ch >= 'a' && ch <= 'z') return String.fromCharCode(ch.charCodeAt(0) - 96);
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  return null;
}

/** 右鍵行為：有選取＝複製選取，無選取＝貼上剪貼簿（Flutter 版同款）。 */
async function handleTerminalContextMenu(
  term: Terminal,
  paste: (text: string) => void,
  notify: (message: string) => void,
): Promise<void> {
  const bridge = getBridge();
  const selection = term.getSelection();
  if (selection !== '') {
    try {
      await bridge.writeClipboard(selection);
      term.clearSelection();
      notify('已複製選取內容');
    } catch {
      notify('複製失敗');
    }
    return;
  }
  try {
    const text = await bridge.readClipboard();
    if (text !== '') paste(text);
    else notify('剪貼簿是空的');
  } catch {
    notify('貼上失敗');
  }
}

interface TerminalViewProps {
  profileId?: string;
  legacyServerId?: string;
  legacyTerminalId?: string;
  initialCwd?: string;
  onExit?: () => void;
  onHandle?: (handle: TerminalHandle | null) => void;
  onNotify?: (message: string) => void;
  onModifiersChange?: (modifiers: TerminalModifiers) => void;
}

function createLegacyTerminalUrl(
  serverId: string,
  terminalId: string,
  cols: number,
  rows: number,
  reuse: boolean,
  cwd: string,
): string {
  const url = createLegacyWebSocketUrl('/api/ssh/terminal');
  url.searchParams.set('serverId', serverId);
  url.searchParams.set('terminalId', terminalId);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  if (reuse) url.searchParams.set('reuse', '1');
  if (!reuse && cwd.trim()) url.searchParams.set('cwd', cwd.trim());
  return url.toString();
}

function createLegacyTerminalId(): string {
  const random =
    typeof window !== 'undefined' && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `term-${random}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 150);
}

function sendLegacyTerminalControl(socket: WebSocket | null, payload: object): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(`${LEGACY_TERMINAL_CONTROL_PREFIX}${JSON.stringify(payload)}`);
}

async function writeWebSocketDataToTerminal(term: Terminal, data: unknown): Promise<void> {
  if (typeof data === 'string') {
    term.write(data);
    return;
  }
  if (data instanceof ArrayBuffer) {
    term.write(new TextDecoder().decode(data));
    return;
  }
  if (data instanceof Blob) {
    term.write(await data.text());
  }
}

export function TerminalView({
  profileId,
  legacyServerId,
  legacyTerminalId,
  initialCwd = '~',
  onExit,
  onHandle,
  onNotify,
  onModifiersChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const onModifiersChangeRef = useRef(onModifiersChange);
  onModifiersChangeRef.current = onModifiersChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bridge = getBridge();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", monospace',
      theme: {
        background: '#101014',
        foreground: '#e6e6e6',
        cursor: '#ffb454',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    if (import.meta.env.DEV) {
      (window as unknown as { __cozypadDebug?: object }).__cozypadDebug = {
        term,
        bridge,
      };
    }

    let terminalId: string | null = null;
    let disposed = false;
    const unsubscribes: (() => void)[] = [];
    const modifiers: TerminalModifiers = { ctrl: false, alt: false };
    let legacySocket: WebSocket | null = null;

    const notifyModifiers = (): void => {
      onModifiersChangeRef.current?.({ ...modifiers });
    };

    const pasteToTerminal = (text: string): void => {
      if (legacyServerId) {
        if (legacySocket?.readyState === WebSocket.OPEN) {
          legacySocket.send(text);
        }
        return;
      }
      if (terminalId !== null && profileId) {
        bridge.writeTerminal({ terminalId, dataBase64: textToBase64(text) });
      }
    };

    /** 套用 sticky modifier 後送出（軟鍵盤輸入經過這裡）。 */
    const sendWithModifiers = (data: string): void => {
      let out = data;
      if (modifiers.ctrl && data.length === 1) {
        out = toControlChar(data) ?? out;
        modifiers.ctrl = false;
        notifyModifiers();
      }
      if (modifiers.alt && out.length === 1) {
        out = `${out}`;
        modifiers.alt = false;
        notifyModifiers();
      }
      pasteToTerminal(out);
    };

    // 右鍵在 terminal 建立時就綁定，即使開啟 session 失敗仍可複製畫面內容。
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      void handleTerminalContextMenu(term, pasteToTerminal, (message) =>
        onNotifyRef.current?.(message),
      );
    };
    container.addEventListener('contextmenu', onContextMenu);

    if (legacyServerId) {
      const stableTerminalId = legacyTerminalId || createLegacyTerminalId();
      terminalId = stableTerminalId;
      let reconnectAttempts = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

      const dataDisposable = term.onData((data) => {
        sendWithModifiers(data);
      });
      const resizeDisposable = term.onResize(({ cols, rows }) => {
        sendLegacyTerminalControl(legacySocket, { type: 'resize', cols, rows });
      });
      const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
      observer.observe(container);

      const openLegacySocket = (reuse: boolean): void => {
        if (disposed) return;
        legacySocket?.close();
        let socketOpened = false;
        let socketTimedOut = false;
        let firstMessageReceived = false;
        let readyTimedOut = false;
        const socket = new WebSocket(
          createLegacyTerminalUrl(
            legacyServerId,
            stableTerminalId,
            term.cols,
            term.rows,
            reuse,
            initialCwd,
          ),
        );
        legacySocket = socket;
        const openTimeout = window.setTimeout(() => {
          if (disposed || socket.readyState !== WebSocket.CONNECTING) return;
          socketTimedOut = true;
          term.write(
            `\r\n\x1b[31m[CozyPad] terminal open timed out after ${Math.round(
              TERMINAL_OPEN_TIMEOUT_MS / 1000,
            )}s. Reopen manually after checking SSH.\x1b[0m\r\n`,
          );
          socket.close();
        }, TERMINAL_OPEN_TIMEOUT_MS);
        let readyTimeout: number | null = null;
        const clearReadyTimeout = () => {
          if (readyTimeout !== null) {
            window.clearTimeout(readyTimeout);
            readyTimeout = null;
          }
        };

        const scheduleReconnect = (reason: string): void => {
          if (disposed) return;
          if (reconnectAttempts >= LEGACY_TERMINAL_RECONNECT_MAX_ATTEMPTS) {
            term.write(
              `\r\n\x1b[31m[CozyPad] terminal auto-reconnect paused after ${LEGACY_TERMINAL_RECONNECT_MAX_ATTEMPTS} reuse attempts. Press Terminal again or switch back to this tab to reconnect manually.\x1b[0m\r\n`,
            );
            return;
          }
          reconnectAttempts += 1;
          const delayMs = Math.min(15000, 900 + reconnectAttempts * 400);
          term.write(
            `\r\n\x1b[2m[CozyPad] terminal ${reason}; reattaching ${reconnectAttempts}/${LEGACY_TERMINAL_RECONNECT_MAX_ATTEMPTS} in ${Math.ceil(
              delayMs / 1000,
            )}s...\x1b[0m\r\n`,
          );
          reconnectTimer = setTimeout(() => openLegacySocket(true), delayMs);
        };

        socket.addEventListener('open', () => {
          window.clearTimeout(openTimeout);
          socketOpened = true;
          readyTimeout = window.setTimeout(() => {
            if (disposed || legacySocket !== socket || firstMessageReceived) return;
            readyTimedOut = true;
            term.write(
              `\r\n\x1b[31m[CozyPad] terminal did not become ready after ${Math.round(
                TERMINAL_OPEN_TIMEOUT_MS / 1000,
              )}s. Reopen manually after checking SSH.\x1b[0m\r\n`,
            );
            socket.close();
          }, TERMINAL_OPEN_TIMEOUT_MS);
          sendLegacyTerminalControl(socket, { type: 'resize', cols: term.cols, rows: term.rows });
          term.focus();
          onHandleRef.current?.({
            paste: pasteToTerminal,
            run: (command) => pasteToTerminal(command + '\r'),
            focus: () => term.focus(),
            sendRaw: pasteToTerminal,
            setModifier: (mod, on) => {
              modifiers[mod] = on;
              notifyModifiers();
            },
          });
        });

        socket.addEventListener('message', (event) => {
          firstMessageReceived = true;
          reconnectAttempts = 0;
          clearReadyTimeout();
          void writeWebSocketDataToTerminal(term, event.data);
        });

        socket.addEventListener('close', () => {
          window.clearTimeout(openTimeout);
          clearReadyTimeout();
          if (disposed) return;
          onHandleRef.current?.(null);
          legacySocket = null;
          if (socketTimedOut || readyTimedOut) {
            if (reuse) scheduleReconnect(socketTimedOut ? 'open timed out' : 'ready timed out');
            return;
          }
          if (!socketOpened) {
            if (reuse) {
              scheduleReconnect('could not reattach');
              return;
            }
            term.write(
              '\r\n\x1b[31m[CozyPad] terminal could not open; retry manually after checking the SSH server and key.\x1b[0m\r\n',
            );
            return;
          }
          scheduleReconnect('disconnected');
        });

        socket.addEventListener('error', () => {
          window.clearTimeout(openTimeout);
          clearReadyTimeout();
          term.write('\r\n\x1b[31m[CozyPad] terminal connection error\x1b[0m\r\n');
        });
      };

      openLegacySocket(false);

      return () => {
        disposed = true;
        onHandleRef.current?.(null);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        container.removeEventListener('contextmenu', onContextMenu);
        observer.disconnect();
        dataDisposable.dispose();
        resizeDisposable.dispose();
        legacySocket?.close();
        legacySocket = null;
        term.dispose();
      };
    }

    if (!profileId) {
      term.write('\r\nfailed to open terminal: no SSH profile selected\r\n');
      return () => {
        disposed = true;
        onHandleRef.current?.(null);
        container.removeEventListener('contextmenu', onContextMenu);
        term.dispose();
      };
    }

    unsubscribes.push(
      bridge.onTerminalOutput((event) => {
        if (event.terminalId === terminalId) {
          term.write(base64ToBytes(event.dataBase64));
        }
      }),
    );
    unsubscribes.push(
      bridge.onTerminalClosed((event) => {
        if (event.terminalId === terminalId) {
          terminalId = null;
          term.write('\r\n[2m[session closed][0m\r\n');
          onExitRef.current?.();
        }
      }),
    );

    const dataDisposable = term.onData((data) => {
      sendWithModifiers(data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (terminalId) void bridge.resizeTerminal({ terminalId, cols, rows });
    });

    let localOpenDone = false;
    const localOpenTimeout = window.setTimeout(() => {
      if (disposed || localOpenDone) return;
      localOpenDone = true;
      term.write(
        `\r\nfailed to open terminal: timed out after ${Math.round(
          TERMINAL_OPEN_TIMEOUT_MS / 1000,
        )}s\r\n`,
      );
    }, TERMINAL_OPEN_TIMEOUT_MS);

    void bridge
      .openTerminal({ profileId, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (localOpenDone) {
          void bridge.closeTerminal({ terminalId: opened.terminalId });
          return;
        }
        localOpenDone = true;
        window.clearTimeout(localOpenTimeout);
        if (disposed) {
          void bridge.closeTerminal({ terminalId: opened.terminalId });
          return;
        }
        terminalId = opened.terminalId;
        term.focus();
        onHandleRef.current?.({
          paste: pasteToTerminal,
          run: (command) => pasteToTerminal(command + '\r'),
          focus: () => term.focus(),
          sendRaw: pasteToTerminal,
          setModifier: (mod, on) => {
            modifiers[mod] = on;
            notifyModifiers();
          },
        });
      })
      .catch((error: unknown) => {
        if (localOpenDone) return;
        localOpenDone = true;
        window.clearTimeout(localOpenTimeout);
        term.write(`\r\nfailed to open terminal: ${String(error)}\r\n`);
      });

    const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
    observer.observe(container);

    return () => {
      disposed = true;
      onHandleRef.current?.(null);
      container.removeEventListener('contextmenu', onContextMenu);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      window.clearTimeout(localOpenTimeout);
      if (terminalId) void bridge.closeTerminal({ terminalId });
      term.dispose();
    };
  }, [initialCwd, legacyServerId, legacyTerminalId, profileId]);

  return <div className="terminal-host" ref={containerRef} />;
}
