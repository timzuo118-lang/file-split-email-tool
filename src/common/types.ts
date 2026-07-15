export const SUPPORTED_EXTENSIONS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'zip', 'rar', '7z'] as const

export type TaskStatus = 'draft' | 'sending' | 'terminating' | 'paused' | 'failed' | 'terminated' | 'completed'

export interface SplitPreview {
  filePath: string
  fileName: string
  fileSize: number
  partSize: number
  totalParts: number
  estimatedMailSize: number
  sha256: string
  requiresLargeFileConfirmation: boolean
  copyCommand: string
}

export interface SendTask extends SplitPreview {
  id: string
  recipient: string
  status: TaskStatus
  completedParts: number
  currentPart?: number
  createdAt: string
  updatedAt: string
  sentAt?: string
  lastError?: string
  partResults: PartResult[]
}

export interface PartResult {
  index: number
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  error?: string
  sentAt?: string
}

export interface HistoryRecord {
  id: string
  fileName: string
  fileSize: number
  recipient: string
  totalParts: number
  status: TaskStatus
  createdAt: string
  sentAt?: string
  lastError?: string
}

export interface AccountInfo {
  address: string
  saved: boolean
}

export interface AppState {
  tasks: SendTask[]
}

export interface SaveAccountInput {
  address: string
  authorizationCode: string
  remember: boolean
}

export interface CreateTaskInput {
  filePath: string
  recipient: string
  confirmedLargeFile: boolean
}
