import { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus, RotateCw } from 'lucide-react';
import { mediaType } from '../../../../packages/contracts/src/media-types.mjs';
import { serverQuery } from '../api';
import { Busy, IconButton } from './Controls';
import './media-preview.css';

export const mediaFileUrl = (serverId: string, path: string, download = false) => `/api/files/media?${serverQuery(serverId, path)}${download ? '&download=1' : ''}`;
const fileSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export function MediaPreview({ serverId, path, name, version = 0 }: { serverId: string; path: string; name: string; version?: number }) {
  const format = mediaType(path);
  const [attempt, setAttempt] = useState(0), [stamp] = useState(() => Date.now());
  const [phase, setPhase] = useState<'checking' | 'loading' | 'ready'>('checking');
  const [error, setError] = useState(''), [bytes, setBytes] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const url = `${mediaFileUrl(serverId, path)}&v=${stamp}-${version}-${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    setPhase('checking'); setError(''); setBytes(0); setDimensions({ width: 0, height: 0 }); setZoom(null);
    void (async () => {
      try {
        const result = await fetch(url, { method: 'HEAD', credentials: 'same-origin', signal: controller.signal });
        if (!result.ok) {
          if (result.status === 401) window.dispatchEvent(new Event('cozypad:session-expired'));
          throw new Error(result.status === 404 ? '找不到此媒體檔案，可能已移動或刪除。' : result.status === 403 ? '沒有權限讀取此媒體檔案。' : result.status === 415 ? '此格式無法預覽，請下載後開啟。' : '無法讀取媒體，請確認 SSH 連線後重試。');
        }
        if (controller.signal.aborted) return;
        setBytes(Number(result.headers.get('content-length')) || 0); setPhase('loading');
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '媒體讀取失敗。'); }
    })();
    return () => controller.abort();
  }, [url]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pauseHidden = () => { if (document.hidden || video.closest('[hidden], [inert]')) video.pause(); };
    const observer = new MutationObserver(pauseHidden);
    for (let parent = video.parentElement; parent; parent = parent.parentElement) observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'inert'] });
    document.addEventListener('visibilitychange', pauseHidden); pauseHidden();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', pauseHidden); video.pause(); };
  }, [url, phase]);
  const failed = () => setError(format?.kind === 'video' ? '影片無法播放。檔案可能已損壞、連線中斷，或瀏覽器不支援此編碼；可下載後使用本機播放器開啟。' : '圖片無法顯示。檔案可能已損壞、連線中斷，或瀏覽器不支援此格式。');
  const loaded = (width: number, height: number) => { setDimensions({ width, height }); setPhase('ready'); };
  const changeZoom = (factor: number) => setZoom(value => Math.min(4, Math.max(0.1, (value ?? (imageRef.current?.clientWidth || dimensions.width) / dimensions.width) * factor)));
  return <section className="media-preview" aria-label={format?.kind === 'video' ? '影片檢視器' : '圖片檢視器'} aria-busy={!error && phase !== 'ready'}>
    <div className="media-controls"><span className="media-details">{dimensions.width > 0 && `${dimensions.width} × ${dimensions.height}`}{dimensions.width > 0 && bytes > 0 && ' · '}{bytes > 0 && fileSize(bytes)}</span>
      {!error && format?.kind === 'image' && <><button className={`media-text-button ${zoom === null ? 'active' : ''}`} aria-pressed={zoom === null} onClick={() => setZoom(null)}>符合視窗</button><button className={`media-text-button ${zoom === 1 ? 'active' : ''}`} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>實際大小</button><IconButton label="縮小圖片" disabled={phase !== 'ready' || zoom !== null && zoom <= 0.1} onClick={() => changeZoom(1 / 1.25)}><Minus size={16} /></IconButton><span className="media-zoom">{zoom === null ? '自動' : `${Math.round(zoom * 100)}%`}</span><IconButton label="放大圖片" disabled={phase !== 'ready' || zoom !== null && zoom >= 4} onClick={() => changeZoom(1.25)}><Plus size={16} /></IconButton></>}
    </div>
    {error ? <div className="media-error"><p className="error" role="alert">{error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}><RotateCw size={16} />重新載入媒體</button><a className="secondary" href={mediaFileUrl(serverId, path, true)}>下載檔案</a></div> : <div className={`media-stage ${zoom === null ? 'media-fit' : 'media-natural'}`}>
      {phase !== 'ready' && <div className="media-loading" role="status"><Busy label={phase === 'checking' ? '正在開啟媒體' : format?.kind === 'video' ? '讀取影片資訊' : '讀取圖片'} /></div>}
      {phase !== 'checking' && (format?.kind === 'video' ? <video ref={videoRef} key={url} src={url} controls playsInline preload="metadata" aria-label={`影片預覽 ${name}`} onLoadedMetadata={event => loaded(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} onError={failed}>瀏覽器不支援影片播放，請下載後開啟。</video>
        : <img ref={imageRef} key={url} src={url} alt={`圖片預覽 ${name}`} draggable={false} style={zoom === null || !dimensions.width ? undefined : { width: dimensions.width * zoom }} onLoad={event => loaded(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={failed} />)}
    </div>}
    {!error && format?.kind === 'video' && <p className="media-hint"><Maximize size={13} aria-hidden="true" />使用播放器控制播放、音量、進度與全螢幕。播放支援取決於瀏覽器的影片編碼。</p>}
  </section>;
}
