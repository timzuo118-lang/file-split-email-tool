import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, SaveAccountInput } from '../common/types'

const api = {
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  preview: (filePath: string) => ipcRenderer.invoke('split:preview', filePath),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('task:create', input),
  listTasks: () => ipcRenderer.invoke('task:list'),
  startTask: (id: string) => ipcRenderer.invoke('task:start', id),
  pauseTask: (id: string) => ipcRenderer.invoke('task:pause', id),
  terminateTask: (id: string) => ipcRenderer.invoke('task:terminate', id),
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  getAccount: () => ipcRenderer.invoke('account:get'),
  saveAccount: (input: SaveAccountInput) => ipcRenderer.invoke('account:save', input),
  removeAccount: () => ipcRenderer.invoke('account:remove'),
  onTaskUpdated: (listener: () => void) => {
    const callback = () => listener()
    ipcRenderer.on('task:updated', callback)
    return () => ipcRenderer.removeListener('task:updated', callback)
  }
}

contextBridge.exposeInMainWorld('mailApp', api)
