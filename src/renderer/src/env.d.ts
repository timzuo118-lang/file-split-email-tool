/// <reference types="vite/client" />

import type { AccountInfo, CreateTaskInput, HistoryRecord, SaveAccountInput, SendTask, SplitPreview } from '../../common/types'

declare global {
  interface Window {
    mailApp: {
      selectFile(): Promise<string | null>
      preview(filePath: string): Promise<SplitPreview>
      createTask(input: CreateTaskInput): Promise<SendTask>
      listTasks(): Promise<SendTask[]>
      startTask(id: string): Promise<SendTask>
      pauseTask(id: string): Promise<SendTask>
      terminateTask(id: string): Promise<SendTask>
      listHistory(): Promise<HistoryRecord[]>
      clearHistory(): Promise<void>
      getAccount(): Promise<AccountInfo>
      saveAccount(input: SaveAccountInput): Promise<AccountInfo>
      removeAccount(): Promise<void>
      onTaskUpdated(listener: () => void): () => void
    }
  }
}

export {}
