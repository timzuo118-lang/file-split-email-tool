import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
// keytar 是 CommonJS 原生模块；使用命名空间导入可避免打包后错误地读取不存在的 default 导出。
import * as keytar from 'keytar'
import nodemailer from 'nodemailer'
import {
  DEFAULT_PART_BYTES,
  SAFE_MAIL_LIMIT_BYTES,
  estimateEncodedMailBytes,
  formatBytes,
  makeCopyCommand,
  makePreview,
  partBytesFor,
  partCountFor,
  partFileName
} from '../common/split'
import type { AccountInfo, AppState, CreateTaskInput, HistoryRecord, PartResult, SaveAccountInput, SendTask, SplitPreview } from '../common/types'

const SERVICE_NAME = '文件拆分邮件发送工具'
const SMTP_HOST = 'smtp.163.com'
const SMTP_PORT = 465
const DEFAULT_RECIPIENT_DOMAIN = '@ccb-life.com.cn'
const RETRY_COUNT = 3
const SEND_INTERVAL_MS = 2_000
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

class TerminationRequestedError extends Error {
  constructor() {
    super('发送任务已请求终止。')
    this.name = 'TerminationRequestedError'
  }
}

interface Settings {
  accountAddress?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertEmail(address: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('请输入有效的收件邮箱地址。')
}

function normalizeRecipient(address: string): string {
  const trimmed = address.trim()
  return trimmed.includes('@') ? trimmed : `${trimmed}${DEFAULT_RECIPIENT_DOMAIN}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class TaskStore {
  private state: AppState = { tasks: [] }
  private settings: Settings = {}
  private readonly statePath: string
  private readonly settingsPath: string

  constructor(userDataPath: string) {
    this.statePath = path.join(userDataPath, 'tasks.json')
    this.settingsPath = path.join(userDataPath, 'settings.json')
  }

  async load(): Promise<void> {
    this.state = await this.readJson<AppState>(this.statePath, { tasks: [] })
    this.settings = await this.readJson<Settings>(this.settingsPath, {})
    for (const task of this.state.tasks) {
      if (task.status === 'sending') {
        task.status = 'paused'
        task.lastError = '应用在发送过程中关闭，请确认后继续发送。'
        task.updatedAt = new Date().toISOString()
      }
    }
    this.removeExpiredHistory()
    await this.save()
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw error
    }
  }

  private async writeJson(filePath: string, payload: unknown): Promise<void> {
    const temporaryPath = `${filePath}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(temporaryPath, filePath)
  }

  async save(): Promise<void> {
    this.removeExpiredHistory()
    await this.writeJson(this.statePath, this.state)
    await this.writeJson(this.settingsPath, this.settings)
  }

  private removeExpiredHistory(): void {
    const cutoff = Date.now() - HISTORY_RETENTION_MS
    this.state.tasks = this.state.tasks.filter((task) => {
      const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'terminated'
      return !isTerminal || new Date(task.updatedAt).getTime() >= cutoff
    })
  }

  tasks(): SendTask[] {
    return [...this.state.tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  }

  task(id: string): SendTask {
    const task = this.state.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error('未找到该发送任务。')
    return task
  }

  add(task: SendTask): void {
    this.state.tasks.unshift(task)
  }

  getSettings(): Settings {
    return { ...this.settings }
  }

  setAccount(address?: string): void {
    this.settings.accountAddress = address
  }

  clearTerminalTasks(): void {
    this.state.tasks = this.state.tasks.filter((task) => task.status !== 'completed' && task.status !== 'failed' && task.status !== 'terminated')
  }
}

class MailApplication {
  private readonly store: TaskStore
  private mainWindow: BrowserWindow | undefined
  private readonly pauseRequested = new Set<string>()
  private readonly terminationRequested = new Set<string>()
  private readonly starting = new Set<string>()
  private readonly running = new Set<string>()
  private sessionCredential: { address: string; authorizationCode: string } | undefined

  constructor(userDataPath: string) {
    this.store = new TaskStore(userDataPath)
  }

  async initialize(): Promise<void> {
    await this.store.load()
  }

  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private notify(task?: SendTask): void {
    this.mainWindow?.webContents.send('task:updated', task ?? null)
  }

  private hasActiveWork(): boolean {
    return this.starting.size > 0 || this.running.size > 0
  }

  async selectFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择需要发送的文件',
      properties: ['openFile'],
      filters: [{ name: '支持的文件', extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'zip', 'rar', '7z'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  }

  async preview(filePath: string): Promise<SplitPreview> {
    return makePreview(filePath)
  }

  async createTask(input: CreateTaskInput): Promise<SendTask> {
    const recipient = normalizeRecipient(input.recipient)
    assertEmail(recipient)
    if (this.hasActiveWork()) throw new Error('已有发送任务正在启动或进行，请先暂停、终止或完成当前任务。')
    const preview = await makePreview(input.filePath)
    if (preview.requiresLargeFileConfirmation && !input.confirmedLargeFile) {
      throw new Error('该文件超过 200MB，邮件数量较多，可能触发邮箱频率限制。请勾选确认后继续。')
    }
    const now = new Date().toISOString()
    const task: SendTask = {
      ...preview,
      id: randomUUID(),
      recipient,
      status: 'draft',
      completedParts: 0,
      createdAt: now,
      updatedAt: now,
      partResults: this.createPartResults(preview.totalParts)
    }
    this.store.add(task)
    await this.store.save()
    this.notify(task)
    return task
  }

  private createPartResults(totalParts: number): PartResult[] {
    return Array.from({ length: totalParts }, (_, index) => ({ index: index + 1, status: 'pending', attempts: 0 }))
  }

  async listTasks(): Promise<SendTask[]> {
    return this.store.tasks()
  }

  async history(): Promise<HistoryRecord[]> {
    return this.store.tasks()
      .filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'terminated')
      .map(({ id, fileName, fileSize, recipient, totalParts, status, createdAt, sentAt, lastError }) => ({
        id, fileName, fileSize, recipient, totalParts, status, createdAt, sentAt, lastError
      }))
  }

  async clearHistory(): Promise<void> {
    if (this.hasActiveWork()) throw new Error('发送进行中，暂时不能清空历史记录。')
    this.store.clearTerminalTasks()
    await this.store.save()
    this.notify()
  }

  async getAccount(): Promise<AccountInfo> {
    const savedAddress = this.store.getSettings().accountAddress
    const address = this.sessionCredential?.address ?? savedAddress
    return { address: address ?? '', saved: Boolean(savedAddress) }
  }

  async saveAccount(input: SaveAccountInput): Promise<AccountInfo> {
    const address = input.address.trim().toLowerCase()
    assertEmail(address)
    if (!address.endsWith('@163.com')) throw new Error('v0.1 仅支持网易 163 邮箱（@163.com）。')
    if (!input.authorizationCode.trim()) throw new Error('请输入网易邮箱客户端授权密码。')
    const previousAddress = this.store.getSettings().accountAddress
    this.sessionCredential = { address, authorizationCode: input.authorizationCode.trim() }
    if (input.remember) {
      await keytar.setPassword(SERVICE_NAME, address, input.authorizationCode.trim())
      this.store.setAccount(address)
    } else {
      await keytar.deletePassword(SERVICE_NAME, address)
      if (previousAddress) await keytar.deletePassword(SERVICE_NAME, previousAddress)
      this.store.setAccount(undefined)
    }
    if (previousAddress && previousAddress !== address) await keytar.deletePassword(SERVICE_NAME, previousAddress)
    await this.store.save()
    return this.getAccount()
  }

  async removeAccount(): Promise<void> {
    const savedAddress = this.store.getSettings().accountAddress
    if (savedAddress) await keytar.deletePassword(SERVICE_NAME, savedAddress)
    if (this.sessionCredential && this.sessionCredential.address !== savedAddress) {
      await keytar.deletePassword(SERVICE_NAME, this.sessionCredential.address)
    }
    this.sessionCredential = undefined
    this.store.setAccount(undefined)
    await this.store.save()
  }

  async start(taskId: string): Promise<SendTask> {
    const task = this.store.task(taskId)
    if (task.status === 'completed' || task.status === 'terminated') throw new Error('该任务已经结束，不能继续发送。')
    if (task.status === 'sending' || task.status === 'terminating' || this.starting.has(taskId) || this.running.has(taskId)) {
      throw new Error('该任务正在启动或发送，不能重复执行。')
    }
    if (this.hasActiveWork()) throw new Error('已有发送任务正在启动或进行。')

    // 在读取凭据之前即占用启动锁，防止双击或重复 IPC 调用并行启动同一个任务。
    this.starting.add(taskId)
    try {
      await this.getCredential()
      this.pauseRequested.delete(taskId)
      this.terminationRequested.delete(taskId)
      task.status = 'sending'
      task.lastError = undefined
      task.updatedAt = new Date().toISOString()
      this.running.add(taskId)
      await this.store.save()
      this.notify(task)
      void this.run(taskId)
      return task
    } finally {
      this.starting.delete(taskId)
    }
  }

  async pause(taskId: string): Promise<SendTask> {
    const task = this.store.task(taskId)
    if (task.status !== 'sending') throw new Error('当前任务没有在发送。')
    this.pauseRequested.add(taskId)
    task.status = 'paused'
    task.updatedAt = new Date().toISOString()
    await this.store.save()
    this.notify(task)
    return task
  }

  async terminate(taskId: string): Promise<SendTask> {
    const task = this.store.task(taskId)
    if (task.status === 'completed' || task.status === 'terminated') throw new Error('该任务已经结束。')

    if (this.running.has(taskId)) {
      this.terminationRequested.add(taskId)
      this.pauseRequested.delete(taskId)
      task.status = 'terminating'
      task.updatedAt = new Date().toISOString()
      await this.store.save()
      this.notify(task)
      return task
    }

    task.status = 'terminated'
    task.currentPart = undefined
    task.lastError = undefined
    task.sentAt = new Date().toISOString()
    task.updatedAt = task.sentAt
    await this.store.save()
    this.notify(task)
    return task
  }

  private async run(taskId: string): Promise<void> {
    const task = this.store.task(taskId)
    try {
      const credential = await this.getCredential()
      await this.ensureSourceUnchanged(task)
      if (task.completedParts === 0) await this.preflight(task, credential.address)
      const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user: credential.address, pass: credential.authorizationCode },
        tls: { minVersion: 'TLSv1.2' }
      })

      for (let index = task.completedParts + 1; index <= task.totalParts; index += 1) {
        if (this.pauseRequested.has(task.id) || this.terminationRequested.has(task.id)) return
        task.currentPart = index
        const part = task.partResults[index - 1]
        part.status = 'sending'
        task.updatedAt = new Date().toISOString()
        await this.store.save()
        this.notify(task)
        await this.sendOnePart(task, index, credential.address, transport)
        task.completedParts = index
        task.currentPart = undefined
        task.updatedAt = new Date().toISOString()
        await this.store.save()
        this.notify(task)
        if (this.pauseRequested.has(task.id) || this.terminationRequested.has(task.id)) return
        if (index < task.totalParts) await sleep(SEND_INTERVAL_MS)
      }

      if (this.terminationRequested.has(task.id)) return
      task.status = 'completed'
      task.sentAt = new Date().toISOString()
      task.lastError = undefined
    } catch (error) {
      if (!this.pauseRequested.has(task.id) && !this.terminationRequested.has(task.id)) {
        task.status = 'failed'
        task.lastError = errorMessage(error)
      }
    } finally {
      if (this.terminationRequested.has(task.id)) {
        task.status = 'terminated'
        task.currentPart = undefined
        task.lastError = undefined
        task.sentAt = new Date().toISOString()
      } else if (this.pauseRequested.has(task.id)) {
        task.status = 'paused'
        task.currentPart = undefined
      }
      task.updatedAt = new Date().toISOString()
      this.running.delete(task.id)
      await this.store.save()
      this.notify(task)
    }
  }

  private async ensureSourceUnchanged(task: SendTask): Promise<void> {
    const stat = await fs.stat(task.filePath)
    if (!stat.isFile() || stat.size !== task.fileSize) throw new Error('源文件已移动或大小发生变化，无法继续发送。请重新创建任务。')
  }

  private async preflight(task: SendTask, from: string): Promise<void> {
    let candidateSize = task.partSize || DEFAULT_PART_BYTES
    for (let revision = 0; revision < 8; revision += 1) {
      const totalParts = partCountFor(task.fileSize, candidateSize)
      const copyCommand = makeCopyCommand(task.fileName, totalParts)
      let tooLarge = false
      for (let index = 1; index <= totalParts; index += 1) {
        const partBuffer = await this.readPart(task, index, candidateSize)
        const raw = await this.buildMime(task, from, index, totalParts, copyCommand, partBuffer)
        if (raw.byteLength >= SAFE_MAIL_LIMIT_BYTES) {
          tooLarge = true
          break
        }
      }
      if (!tooLarge) {
        task.partSize = candidateSize
        task.totalParts = totalParts
        task.estimatedMailSize = estimateEncodedMailBytes(Math.min(task.fileSize, candidateSize))
        task.copyCommand = copyCommand
        task.partResults = this.createPartResults(totalParts)
        task.updatedAt = new Date().toISOString()
        await this.store.save()
        this.notify(task)
        return
      }
      candidateSize = Math.floor(candidateSize * 0.94)
    }
    throw new Error('无法将分片调整到邮件大小限制内，请更换文件后重试。')
  }

  private async sendOnePart(task: SendTask, index: number, from: string, transport: nodemailer.Transporter): Promise<void> {
    const result = task.partResults[index - 1]
    const content = await this.readPart(task, index, task.partSize)
    const raw = await this.buildMime(task, from, index, task.totalParts, task.copyCommand, content)
    if (raw.byteLength >= SAFE_MAIL_LIMIT_BYTES) throw new Error(`第 ${index} 封邮件编码后超过 9.9MB，已停止发送。`)

    let lastError = '未知发送错误'
    for (let attempt = 1; attempt <= RETRY_COUNT; attempt += 1) {
      if (this.terminationRequested.has(task.id)) throw new TerminationRequestedError()
      try {
        result.attempts = attempt
        result.status = 'sending'
        await transport.sendMail(this.mailOptions(task, from, index, task.totalParts, content))
        result.status = 'sent'
        result.sentAt = new Date().toISOString()
        result.error = undefined
        return
      } catch (error) {
        if (error instanceof TerminationRequestedError || this.terminationRequested.has(task.id)) throw new TerminationRequestedError()
        lastError = errorMessage(error)
        result.error = lastError
        if (attempt < RETRY_COUNT && this.isSafeToRetry(error)) {
          await sleep(SEND_INTERVAL_MS)
          continue
        }
        result.status = 'failed'
        if (!this.isSafeToRetry(error)) {
          throw new Error(`第 ${index} 封邮件的投递结果无法确认：${lastError}。为避免重复发送，应用没有自动重试；请检查收件箱后再决定是否继续。`)
        }
      }
    }
    result.status = 'failed'
    throw new Error(`第 ${index} 封邮件连续 ${RETRY_COUNT} 次发送失败：${lastError}`)
  }

  private isSafeToRetry(error: unknown): boolean {
    const responseCode = (error as { responseCode?: unknown }).responseCode
    // SMTP 明确返回 4xx 时，服务器尚未接受本封邮件，可安全重试；网络中断等情况无法确认投递结果，不重试以避免重复邮件。
    return typeof responseCode === 'number' && responseCode >= 400 && responseCode < 500
  }

  private async readPart(task: SendTask, index: number, partSize: number): Promise<Buffer> {
    const bytes = partBytesFor(task.fileSize, partSize, index)
    const offset = (index - 1) * partSize
    const handle = await fs.open(task.filePath, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      await handle.read(buffer, 0, bytes, offset)
      return buffer
    } finally {
      await handle.close()
    }
  }

  private emailText(task: SendTask, index: number, totalParts: number): string {
    const attachmentName = partFileName(task.fileName, index, totalParts)
    const mergedName = task.fileName.replace(/(\.[^.]+)$/, '_合并后$1')
    return [
      `原始文件：${task.fileName}`,
      `原始大小：${formatBytes(task.fileSize)}`,
      `当前分片：第 ${index} / ${totalParts} 份（附件：${attachmentName}）`,
      '',
      'Windows 合并说明：',
      '1. 下载全部邮件附件到同一个文件夹。',
      '2. 在该文件夹的地址栏输入 cmd 后回车。',
      '3. 复制并执行以下命令：',
      task.copyCommand,
      `4. 将生成 ${mergedName}。`,
      '',
      `原始文件 SHA-256：${task.sha256}`,
      `可用命令核验：certutil -hashfile "${mergedName}" SHA256`
    ].join('\r\n')
  }

  private mailOptions(task: SendTask, from: string, index: number, totalParts: number, content: Buffer): nodemailer.SendMailOptions {
    return {
      from: from,
      to: task.recipient,
      subject: `${task.fileName}_Part${index}`,
      messageId: `<${task.id}.part${index}@file-split-mailer.local>`,
      text: this.emailText(task, index, totalParts),
      attachments: [{ filename: partFileName(task.fileName, index, totalParts), content }]
    }
  }

  private async buildMime(task: SendTask, from: string, index: number, totalParts: number, copyCommand: string, content: Buffer): Promise<Buffer> {
    const originalCommand = task.copyCommand
    task.copyCommand = copyCommand
    try {
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
      const info = await transport.sendMail(this.mailOptions(task, from, index, totalParts, content))
      if (Buffer.isBuffer(info.message)) return info.message
      if (typeof info.message === 'string') return Buffer.from(info.message)
      throw new Error('无法生成邮件大小校验内容。')
    } finally {
      task.copyCommand = originalCommand
    }
  }

  private async getCredential(): Promise<{ address: string; authorizationCode: string }> {
    if (this.sessionCredential) return this.sessionCredential
    const address = this.store.getSettings().accountAddress
    if (!address) throw new Error('请先在设置中配置网易 163 邮箱和客户端授权密码。')
    const authorizationCode = await keytar.getPassword(SERVICE_NAME, address)
    if (!authorizationCode) throw new Error('未找到保存的邮箱授权密码，请重新在设置中配置。')
    return { address, authorizationCode }
  }
}

let mainWindow: BrowserWindow | undefined
let mailApp: MailApplication

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    minWidth: 960,
    height: 780,
    minHeight: 660,
    backgroundColor: '#f5f7fb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mailApp.setWindow(mainWindow)
  mainWindow.on('closed', () => { mainWindow = undefined })
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('dialog:selectFile', () => mailApp.selectFile())
  ipcMain.handle('split:preview', (_event, filePath: string) => mailApp.preview(filePath))
  ipcMain.handle('task:create', (_event, input: CreateTaskInput) => mailApp.createTask(input))
  ipcMain.handle('task:list', () => mailApp.listTasks())
  ipcMain.handle('task:start', (_event, id: string) => mailApp.start(id))
  ipcMain.handle('task:pause', (_event, id: string) => mailApp.pause(id))
  ipcMain.handle('task:terminate', (_event, id: string) => mailApp.terminate(id))
  ipcMain.handle('history:list', () => mailApp.history())
  ipcMain.handle('history:clear', () => mailApp.clearHistory())
  ipcMain.handle('account:get', () => mailApp.getAccount())
  ipcMain.handle('account:save', (_event, input: SaveAccountInput) => mailApp.saveAccount(input))
  ipcMain.handle('account:remove', () => mailApp.removeAccount())
}

app.whenReady().then(async () => {
  mailApp = new MailApplication(app.getPath('userData'))
  await mailApp.initialize()
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
