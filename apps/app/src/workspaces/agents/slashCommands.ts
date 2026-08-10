import type { SlashCommand } from '@cozypad/contracts';

export const commonAgentSlashCommands: SlashCommand[] = [
  { name: 'help', description: '列出可用指令' },
  { name: 'resume', description: '接續既有工作' },
  { name: 'clear', description: '清空目前對話' },
  { name: 'compact', description: '壓縮歷史並保留重點' },
  { name: 'model', description: '切換模型或推論設定' },
  { name: 'status', description: '檢查目前 agent 狀態' },
  { name: 'init', description: '初始化目前專案設定' },
  { name: 'login', description: '登入 CLI 帳號' },
  { name: 'logout', description: '登出 CLI 帳號' },
  { name: 'settings', description: '開啟或檢查設定' },
  { name: 'review', description: '審查目前變更' },
  { name: 'diff', description: '顯示工作區變更' },
  { name: 'plan', description: '整理執行計畫' },
  { name: 'approvals', description: '檢查需要核准的操作' },
];
