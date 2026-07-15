import './style.css'
import type { AccountInfo, HistoryRecord, SendTask, SplitPreview } from '../../common/types'

type View = 'send' | 'progress' | 'history' | 'settings'

const app = document.querySelector<HTMLDivElement>('#app')!
let currentView: View = 'send'
let preview: SplitPreview | undefined
let tasks: SendTask[] = []
let history: HistoryRecord[] = []
let account: AccountInfo = { address: '', saved: false }
let selectedTaskId: string | undefined
let toastTimer: number | undefined
let confirmingSend = false

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function formatDate(value: string | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function statusText(status: SendTask['status']): string {
  return ({ draft: '等待确认', sending: '正在发送', terminating: '正在终止', paused: '已暂停', failed: '发送失败', terminated: '已终止', completed: '发送完成' })[status]
}

function statusClass(status: SendTask['status']): string {
  return ({ draft: 'neutral', sending: 'active', terminating: 'warning', paused: 'warning', failed: 'danger', terminated: 'danger', completed: 'success' })[status]
}

function message(error: unknown, kind: 'error' | 'success' = 'error'): void {
  const element = document.querySelector<HTMLDivElement>('#toast')
  if (!element) return
  element.textContent = error instanceof Error ? error.message : String(error)
  element.className = `toast show ${kind}`
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { element.className = 'toast' }, 4600)
}

async function refresh(): Promise<void> {
  ;[tasks, history, account] = await Promise.all([window.mailApp.listTasks(), window.mailApp.listHistory(), window.mailApp.getAccount()])
  if (!selectedTaskId && tasks[0]) selectedTaskId = tasks[0].id
  if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = tasks[0]?.id
  render()
}

function layout(content: string): string {
  const active = (view: View) => currentView === view ? 'nav-item selected' : 'nav-item'
  return `
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">↗</span><span>文件拆分<br><small>邮件发送工具</small></span></div>
      <nav>
        <button class="${active('send')}" data-view="send"><span>＋</span> 新建发送</button>
        <button class="${active('progress')}" data-view="progress"><span>◌</span> 发送进度</button>
        <button class="${active('history')}" data-view="history"><span>□</span> 发送历史</button>
        <button class="${active('settings')}" data-view="settings"><span>⚙</span> 设置</button>
      </nav>
      <div class="sidebar-note"><span class="dot"></span> 网易 163 邮箱<br><small>单封邮件不超过 9.9MB</small></div>
    </aside>
    <section class="shell">
      <header class="topbar"><div><p class="eyebrow">安全地发送大附件</p><h1>${titleForView()}</h1></div><div class="account-state">${account.address ? `<span class="online-dot"></span>${escapeHtml(account.address)}` : '<span class="offline-dot"></span> 尚未配置发件邮箱'}</div></header>
      <main>${content}</main>
    </section>
    <div id="toast" class="toast" role="status"></div>`
}

function titleForView(): string {
  return ({ send: '新建发送任务', progress: '发送进度', history: '发送历史', settings: '设置' })[currentView]
}

function sendView(): string {
  const fileBox = preview
    ? `<div class="file-selected"><div class="file-icon">↥</div><div class="file-info"><strong>${escapeHtml(preview.fileName)}</strong><span>${formatBytes(preview.fileSize)} · SHA-256 已生成</span></div><button class="text-button" id="change-file">更换文件</button></div>`
    : `<button class="file-drop" id="choose-file"><span class="drop-icon">⇧</span><strong>选择需要发送的文件</strong><small>支持 Word、Excel、PowerPoint、PDF、ZIP、RAR、7Z</small><span class="choose-label">选择文件</span></button>`
  const previewCard = preview ? `
    <section class="panel preview-panel">
      <div class="section-heading"><div><p class="eyebrow">发送预览</p><h2>邮件拆分方案</h2></div><span class="badge neutral">发送前会再校验</span></div>
      <div class="metrics">
        <div><span>原文件大小</span><strong>${formatBytes(preview.fileSize)}</strong></div>
        <div><span>单份原始大小</span><strong>约 ${formatBytes(Math.min(preview.fileSize, preview.partSize))}</strong></div>
        <div><span>预计邮件数量</span><strong>${preview.totalParts} 封</strong></div>
        <div><span>最大完整邮件</span><strong>约 ${formatBytes(preview.estimatedMailSize)}</strong></div>
      </div>
      <div class="notice"><span>i</span><p>开始发送时会按真实邮件编码逐份复核大小；如接近上限，应用会自动调小分片，不会发送超过 9.9MB 的邮件。</p></div>
      ${preview.requiresLargeFileConfirmation ? `<label class="confirm-line"><input id="large-confirm" type="checkbox" /> 我已知晓：文件超过 200MB，邮件数量较多，可能触发邮箱频率限制。</label>` : ''}
    </section>` : ''
  return layout(`
    <div class="content-grid">
      <section class="panel send-panel">
        <div class="section-heading"><div><p class="eyebrow">第 1 步</p><h2>选择文件</h2></div></div>
        ${fileBox}
        <div class="section-heading recipient-heading"><div><p class="eyebrow">第 2 步</p><h2>填写收件人</h2></div></div>
        <label class="field-label" for="recipient">公司收件邮箱</label>
        <input id="recipient" class="input" type="email" placeholder="用户名或完整邮箱" autocomplete="email" />
        <p class="field-help">只输入用户名时，系统会自动补充 @ccb-life.com.cn；也可直接填写其他完整邮箱。每次任务只发送给一位收件人。</p>
        <button class="primary-button" id="confirm-send" ${preview ? '' : 'disabled'}>确认发送</button>
        <p class="send-tip">点击后将自动连续发送全部邮件，邮件间隔约 2 秒。</p>
      </section>
      <aside class="guide-card"><div class="guide-number">01</div><h3>收件人无需安装软件</h3><p>下载全部附件到同一文件夹，在地址栏输入 <code>cmd</code>，再执行邮件正文内的合并命令即可。</p><div class="guide-line"></div><strong>支持的文件类型</strong><div class="file-tags"><span>Word</span><span>Excel</span><span>PPT</span><span>PDF</span><span>压缩包</span></div></aside>
    </div>
    ${previewCard}`)
}

function progressView(): string {
  if (tasks.length === 0) return layout(`<section class="empty-state"><div class="empty-icon">◌</div><h2>还没有发送任务</h2><p>选择一个文件并确认发送后，这里会显示每一封邮件的状态。</p><button class="primary-button" data-view="send">新建发送任务</button></section>`)
  const current = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  const percentage = current.totalParts ? Math.round((current.completedParts / current.totalParts) * 100) : 0
  const partRows = current.partResults.map((part) => `<li><span class="part-index">${String(part.index).padStart(2, '0')}</span><span class="part-name">${escapeHtml(current.fileName)} · Part${part.index}</span><span class="part-attempt">${part.attempts ? `尝试 ${part.attempts} 次` : '等待发送'}</span><span class="badge ${part.status === 'sent' ? 'success' : part.status === 'failed' ? 'danger' : part.status === 'sending' ? 'active' : 'neutral'}">${({ pending: '等待', sending: '发送中', sent: '已发送', failed: '失败' })[part.status]}</span></li>`).join('')
  const action = current.status === 'sending'
    ? `<div class="task-actions"><button class="secondary-button" id="pause-task">暂停发送</button><button class="secondary-button danger-button" id="terminate-task">终止发送</button></div>`
    : current.status === 'draft' || current.status === 'paused' || current.status === 'failed'
      ? `<div class="task-actions"><button class="primary-button compact" id="resume-task">${current.status === 'failed' ? '从失败处继续' : '继续发送'}</button><button class="secondary-button danger-button" id="terminate-task">终止任务</button></div>`
      : ''
  return layout(`
    <div class="task-layout">
      <section class="panel task-list"><div class="section-heading"><div><p class="eyebrow">本机任务</p><h2>发送队列</h2></div></div>${tasks.map((task) => `<button class="task-item ${task.id === current.id ? 'selected' : ''}" data-task-id="${task.id}"><span class="task-file">${escapeHtml(task.fileName)}</span><span class="task-meta">${task.completedParts}/${task.totalParts} 封 · ${formatDate(task.updatedAt)}</span><span class="badge ${statusClass(task.status)}">${statusText(task.status)}</span></button>`).join('')}</section>
      <section class="panel task-detail">
        <div class="detail-top"><div><span class="badge ${statusClass(current.status)}">${statusText(current.status)}</span><h2>${escapeHtml(current.fileName)}</h2><p>发送至 ${escapeHtml(current.recipient)} · 原文件 ${formatBytes(current.fileSize)}</p></div>${action}</div>
        <div class="progress-label"><span>总进度</span><strong>${current.completedParts} / ${current.totalParts} 封 · ${percentage}%</strong></div>
        <div class="progress-track"><span style="width:${percentage}%"></span></div>
        ${current.currentPart ? `<p class="sending-caption">正在处理第 ${current.currentPart} 封邮件；暂停或终止会在当前网络请求结束后生效。</p>` : ''}
        ${current.status === 'terminating' ? '<p class="sending-caption">已请求终止，不会再开始发送新的分片。</p>' : ''}
        ${current.lastError ? `<div class="error-box"><strong>需要处理</strong><p>${escapeHtml(current.lastError)}</p></div>` : ''}
        <div class="part-section"><div class="section-heading"><div><p class="eyebrow">逐封状态</p><h3>附件发送情况</h3></div><span>${current.totalParts} 封</span></div><ul class="part-list">${partRows}</ul></div>
      </section>
    </div>`)
}

function historyView(): string {
  const rows = history.map((record) => `<tr><td><strong>${escapeHtml(record.fileName)}</strong><small>${formatBytes(record.fileSize)}</small></td><td>${escapeHtml(record.recipient)}</td><td>${record.totalParts} 封</td><td>${formatDate(record.sentAt ?? record.createdAt)}</td><td><span class="badge ${statusClass(record.status)}">${statusText(record.status)}</span></td></tr>`).join('')
  return layout(`
    <section class="panel history-panel"><div class="section-heading"><div><p class="eyebrow">保留最近 30 天</p><h2>发送历史</h2></div>${history.length ? '<button class="text-button danger-text" id="clear-history">清空历史记录</button>' : ''}</div>
    ${history.length ? `<div class="table-wrap"><table><thead><tr><th>文件</th><th>收件人</th><th>邮件数量</th><th>发送时间</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-inline">尚无已完成或失败的发送记录。</div>'}
    </section>`)
}

function settingsView(): string {
  const accountCard = account.address ? `<div class="saved-account"><div><span class="saved-icon">✓</span><strong>${escapeHtml(account.address)}</strong><p>${account.saved ? '授权密码已保存在本机系统安全凭据中。' : '本次会话可用；关闭应用后需要重新填写授权密码。'}</p></div><button class="secondary-button danger-button" id="remove-account">移除账号</button></div>` : ''
  return layout(`
    <div class="settings-layout"><section class="panel settings-panel"><div class="section-heading"><div><p class="eyebrow">发件账号</p><h2>网易 163 邮箱</h2></div><span class="badge neutral">仅支持 163</span></div>
    ${accountCard}
    <form id="account-form" class="account-form"><label class="field-label" for="sender-address">163 邮箱地址</label><input id="sender-address" class="input" type="email" placeholder="name@163.com" value="${escapeHtml(account.address)}" autocomplete="username" required />
    <label class="field-label" for="authorization-code">客户端授权密码</label><input id="authorization-code" class="input" type="password" placeholder="网易邮箱的 SMTP 客户端授权密码" autocomplete="current-password" required />
    <p class="field-help">请使用网易邮箱开启 SMTP 后生成的客户端授权密码，不要填写网页登录密码。</p>
    <label class="remember"><input id="remember-account" type="checkbox" checked /> 记住此账号和授权密码</label><button class="primary-button" type="submit">保存账号</button></form></section>
    <aside class="security-card"><span class="security-icon">⌾</span><h3>隐私与安全</h3><p>授权密码不会写入历史记录或普通配置文件。选择“记住”后，它仅保存到 macOS 钥匙串或 Windows 凭据管理器。</p><ul><li>不保留原文件副本</li><li>历史记录最多保存 30 天</li><li>可随时移除已保存账号</li></ul></aside></div>`)
}

function render(): void {
  app.innerHTML = currentView === 'send' ? sendView() : currentView === 'progress' ? progressView() : currentView === 'history' ? historyView() : settingsView()
  bindEvents()
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((element) => element.addEventListener('click', () => {
    currentView = element.dataset.view as View
    render()
  }))
  document.querySelector('#choose-file')?.addEventListener('click', chooseFile)
  document.querySelector('#change-file')?.addEventListener('click', chooseFile)
  document.querySelector('#confirm-send')?.addEventListener('click', confirmSend)
  document.querySelectorAll<HTMLElement>('[data-task-id]').forEach((element) => element.addEventListener('click', () => { selectedTaskId = element.dataset.taskId; render() }))
  document.querySelector('#pause-task')?.addEventListener('click', async () => {
    if (!selectedTaskId) return
    try { await window.mailApp.pauseTask(selectedTaskId); await refresh(); message('已请求暂停：当前邮件发送完毕后停止。', 'success') } catch (error) { message(error) }
  })
  document.querySelector('#resume-task')?.addEventListener('click', async () => {
    if (!selectedTaskId) return
    const button = document.querySelector<HTMLButtonElement>('#resume-task')
    if (button) button.disabled = true
    try { await window.mailApp.startTask(selectedTaskId); await refresh(); message('任务已开始处理。', 'success') } catch (error) { message(error); if (button) button.disabled = false }
  })
  document.querySelector('#terminate-task')?.addEventListener('click', async () => {
    if (!selectedTaskId || !window.confirm('确定终止此发送任务吗？已成功发送的邮件不会撤回。')) return
    const button = document.querySelector<HTMLButtonElement>('#terminate-task')
    if (button) button.disabled = true
    try { await window.mailApp.terminateTask(selectedTaskId); await refresh(); message('已请求终止，不会开始发送新的分片。', 'success') } catch (error) { message(error); if (button) button.disabled = false }
  })
  document.querySelector('#clear-history')?.addEventListener('click', async () => {
    if (!window.confirm('确定清空全部已完成和失败的发送历史吗？')) return
    try { await window.mailApp.clearHistory(); await refresh(); message('历史记录已清空。', 'success') } catch (error) { message(error) }
  })
  document.querySelector('#remove-account')?.addEventListener('click', async () => {
    if (!window.confirm('确定移除本机保存的网易账号和授权密码吗？')) return
    try { await window.mailApp.removeAccount(); await refresh(); message('已移除保存的账号。', 'success') } catch (error) { message(error) }
  })
  document.querySelector<HTMLFormElement>('#account-form')?.addEventListener('submit', saveAccount)
}

async function chooseFile(): Promise<void> {
  try {
    const filePath = await window.mailApp.selectFile()
    if (!filePath) return
    message('正在计算分片和校验值…', 'success')
    preview = await window.mailApp.preview(filePath)
    render()
  } catch (error) { message(error) }
}

async function confirmSend(): Promise<void> {
  if (confirmingSend) return
  const recipient = document.querySelector<HTMLInputElement>('#recipient')?.value.trim() ?? ''
  const confirmedLargeFile = document.querySelector<HTMLInputElement>('#large-confirm')?.checked ?? false
  if (!preview) return
  confirmingSend = true
  const button = document.querySelector<HTMLButtonElement>('#confirm-send')
  if (button) {
    button.disabled = true
    button.textContent = '正在创建任务…'
  }
  try {
    const task = await window.mailApp.createTask({ filePath: preview.filePath, recipient, confirmedLargeFile })
    selectedTaskId = task.id
    await window.mailApp.startTask(task.id)
    preview = undefined
    currentView = 'progress'
    await refresh()
    message('已开始发送。系统正在按实际编码复核每封邮件大小。', 'success')
  } catch (error) {
    message(error)
    if (button) {
      button.disabled = false
      button.textContent = '确认发送'
    }
  } finally {
    confirmingSend = false
  }
}

async function saveAccount(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const address = document.querySelector<HTMLInputElement>('#sender-address')?.value ?? ''
  const authorizationCode = document.querySelector<HTMLInputElement>('#authorization-code')?.value ?? ''
  const remember = document.querySelector<HTMLInputElement>('#remember-account')?.checked ?? true
  try {
    await window.mailApp.saveAccount({ address, authorizationCode, remember })
    await refresh()
    message('网易邮箱已保存。', 'success')
  } catch (error) { message(error) }
}

window.mailApp.onTaskUpdated(() => { void refresh() })
void refresh().catch((error) => { app.textContent = `应用初始化失败：${errorMessage(error)}` })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
