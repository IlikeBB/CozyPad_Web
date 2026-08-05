import { useRef } from 'react';

export function LegacyV2Workspace() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  return (
    <div className="legacy-v2-workspace">
      <header className="legacy-v2-header">
        <div>
          <h2>CozyPad v2 Web</h2>
        </div>
        <div className="legacy-v2-actions">
          <button type="button" onClick={() => frameRef.current?.contentWindow?.location.reload()}>
            Reload
          </button>
          <a href="/legacy-v2/index.html" target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </header>
      <iframe
        ref={frameRef}
        className="legacy-v2-frame"
        src="/legacy-v2/index.html"
        title="CozyPad v2 web page"
      />
    </div>
  );
}
