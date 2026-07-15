import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SUPPORTED_EXTENSIONS, type SplitPreview } from './types'

export const DEFAULT_PART_BYTES = 7_000_000
export const MAIL_LIMIT_BYTES = 9_900_000
export const SAFE_MAIL_LIMIT_BYTES = 9_880_000
export const LARGE_FILE_WARNING_BYTES = 200 * 1024 * 1024

export function getExtension(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase()
}

export function assertSupportedFile(filePath: string): void {
  const fileName = path.basename(filePath)
  const extension = getExtension(fileName)
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(`不支持“${extension || '无扩展名'}”文件。仅支持 Word、Excel、PowerPoint、PDF 与常见压缩包。`)
  }
  if (/["<>|?*]/.test(fileName)) {
    throw new Error('文件名含有 Windows 无法恢复的特殊字符，请先重命名文件后再发送。')
  }
}

export function partCountFor(fileSize: number, partSize: number): number {
  return Math.max(1, Math.ceil(fileSize / partSize))
}

export function partBytesFor(fileSize: number, partSize: number, partIndex: number): number {
  const start = (partIndex - 1) * partSize
  return Math.min(partSize, Math.max(0, fileSize - start))
}

export function partFileName(fileName: string, partIndex: number, totalParts: number): string {
  if (totalParts === 1) return fileName
  const width = Math.max(3, String(totalParts).length)
  return `${fileName}.part${String(partIndex).padStart(width, '0')}of${String(totalParts).padStart(width, '0')}`
}

export function mergedFileName(fileName: string): string {
  const parsed = path.parse(fileName)
  return `${parsed.name}_合并后${parsed.ext}`
}

function cmdQuote(value: string): string {
  return `"${value}"`
}

export function makeCopyCommand(fileName: string, totalParts: number): string {
  const inputs = Array.from({ length: totalParts }, (_, index) => cmdQuote(partFileName(fileName, index + 1, totalParts))).join('+')
  return `copy /b ${inputs} ${cmdQuote(mergedFileName(fileName))}`
}

export function estimateEncodedMailBytes(rawAttachmentBytes: number): number {
  const base64Bytes = Math.ceil(rawAttachmentBytes / 3) * 4
  const foldingBytes = Math.ceil(base64Bytes / 76) * 2
  return base64Bytes + foldingBytes + 12_000
}

export async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function makePreview(filePath: string, partSize = DEFAULT_PART_BYTES): Promise<SplitPreview> {
  assertSupportedFile(filePath)
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error('选择的路径不是文件。')
  const fileName = path.basename(filePath)
  const totalParts = partCountFor(stat.size, partSize)
  const largestPart = Math.min(stat.size, partSize)
  return {
    filePath,
    fileName,
    fileSize: stat.size,
    partSize,
    totalParts,
    estimatedMailSize: estimateEncodedMailBytes(largestPart),
    sha256: await sha256File(filePath),
    requiresLargeFileConfirmation: stat.size > LARGE_FILE_WARNING_BYTES,
    copyCommand: makeCopyCommand(fileName, totalParts)
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
}
