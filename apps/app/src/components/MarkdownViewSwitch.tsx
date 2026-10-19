export function MarkdownViewSwitch({ preview, onChange }: { preview: boolean; onChange: (preview: boolean) => void }) {
  return <div className="markdown-view-switch" role="group" aria-label="Markdown 顯示方式">
    <button type="button" aria-pressed={preview} className={preview ? 'active' : ''} onClick={() => onChange(true)}>預覽</button>
    <button type="button" aria-pressed={!preview} className={!preview ? 'active' : ''} onClick={() => onChange(false)}>原始碼</button>
  </div>;
}
