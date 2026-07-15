import { describe, expect, it } from 'vitest'
import { estimateEncodedMailBytes, makeCopyCommand, mergedFileName, partCountFor, partFileName } from '../src/common/split'

describe('文件拆分规则', () => {
  it('按连续分片计算总数', () => {
    expect(partCountFor(7_000_001, 7_000_000)).toBe(2)
  })

  it('生成可排序的分片名称', () => {
    expect(partFileName('项目汇总.xlsx', 2, 3)).toBe('项目汇总.xlsx.part002of003')
  })

  it('生成 Windows 合并命令', () => {
    expect(makeCopyCommand('项目汇总.xlsx', 3)).toBe(
      'copy /b "项目汇总.xlsx.part001of003"+"项目汇总.xlsx.part002of003"+"项目汇总.xlsx.part003of003" "项目汇总_合并后.xlsx"'
    )
    expect(mergedFileName('报告.pdf')).toBe('报告_合并后.pdf')
  })

  it('估算 Base64 邮件体积', () => {
    expect(estimateEncodedMailBytes(7_000_000)).toBeLessThan(9_900_000)
  })
})
