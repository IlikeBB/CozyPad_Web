export function monitorCommand(tool) {
  if (!['nvtop', 'htop'].includes(tool)) throw Object.assign(new Error('不支援的監看工具。'), { status: 400 });
  // The program name comes from this allowlist, never from arbitrary shell input.
  return `if command -v ${tool} >/dev/null 2>&1; then exec ${tool}; else printf 'CozyPad: 遠端尚未安裝 ${tool}。請在伺服器安裝後，按重新開啟再試。\\n'; exit 127; fi`;
}
