/** 主人打過的一句話。 */
export type Prompt = {
  /** 送出時的原文（前後空白去掉）。 */
  text: string
  /** 送出的時間，毫秒。 */
  at: number
}

/** 清單裡的一列，畫成一顆可以點的按鈕。 */
export type Row = {
  /** 第幾句，從 0 起算（畫面上顯示的是加 1）。 */
  at: number
  /** 按鈕上的字，已經裁到放得下。 */
  label: string
  /** 是不是現在選中的那一句。 */
  isSelected: boolean
  /** 是不是單純的同意用語（照推薦、可以…，畫成暗色）。 */
  isShort: boolean
}

/** 整個側邊欄要畫的東西，由 layoutOf 排好。 */
export type Layout = {
  /** 標題列的右邊：「共 N 句」。 */
  count: string
  /** 清單上要畫的幾列，照先後。 */
  rows: Row[]
  /** 全文那一塊的標題：「第 N 句・時:分」；沒有任何一句時是空字串。 */
  title: string
  /** 全文，已經依寬度換好行；放不下的部分不在這裡。 */
  detail: string[]
  /** 全文還有幾行放不下；0 表示全部都放得下。 */
  hidden: number
}

/** 單純表示同意的回覆，整句只有這些（不分大小寫、不管結尾標點）才畫成暗色。 */
export const ACKS: ReadonlySet<string> = new Set([
  '照推薦',
  '可以',
  '可以了',
  '好',
  '好的',
  '對',
  '要',
  '不要',
  '不用',
  '繼續',
  '收到',
  'ok',
  'okay',
  'yes',
])

/**
 * 【行為】一段字在終端機佔幾格寬：中日韓文字、全形標點、表情符號算 2 格，其他算 1 格。
 *   跟 ctx-panel、files、timeline 的同名函式一樣。
 */
export function widthOf(text: string): number {
  let width = 0

  for (const glyph of text) {
    const code = glyph.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += isWide ? 2 : 1
  }

  return width
}

/** 【行為】把一段字裁到最多 max 格寬，超過時留開頭、結尾補「…」；放得下就原樣回傳。max 小於 1 回空字串。 */
export function fit(text: string, max: number): string {
  if (widthOf(text) <= max) {
    return text
  }

  if (max < 1) {
    return ''
  }

  let kept = ''

  for (const glyph of text) {
    if (widthOf(kept + glyph) > max - 1) {
      break
    }

    kept += glyph
  }

  return `${kept}…`
}

/**
 * 【行為】把一段字依寬度換行：先照原本的換行切開，每一段再在超過 columns 格寬的地方硬切。
 *   空的段落保留成空字串（原文的空行）。columns 小於 1 當 1。
 */
export function wrapOf(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    let current = ''

    for (const glyph of paragraph) {
      if (widthOf(current + glyph) > width) {
        lines.push(current)
        current = ''
      }

      current += glyph
    }

    lines.push(current)
  }

  return lines
}

/** 【行為】毫秒寫成本地時間的「時:分」，兩位數補零（09:05）。 */
export function clockOf(ms: number): string {
  const date = new Date(ms)

  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

/**
 * 【行為】是不是單純的同意用語：去掉空白和結尾的標點、喵、顏文字之類的符號，轉小寫後，整句剛好是 ACKS 裡的一個。
 *   「幫我刪除」這種很短的要求不算。
 */
export function isShortOf(text: string): boolean {
  const core = text
    .trim()
    .toLowerCase()
    .replace(/[\s。．.，,！!？?～~喵…]+$/u, '')
    .replace(/\s+/g, ' ')

  return ACKS.has(core)
}

/**
 * 【何時能呼叫】columns 至少 24、rows 至少 12 才排得好看；更小也不會壞，只是放得少。
 * 【行為】排出側邊欄要畫的東西。selected 是選中的第幾句（從 0 起算），null 表示跟著最新的一句；超出範圍的會被拉回來。
 *   全文最多佔 rows 的四成（至少 3 行），放不下的行數記在 hidden；清單用剩下的列數（至少 3 列），
 *   只列選中那句附近的幾句：選中最新的一句時列最後幾句。每一列寫「▸」（選中的）、編號、時間、
 *   原文的第一段（換行變空白），裁到 columns 格寬。prompts 是空的時候 rows、detail 都是空的。
 */
export function layoutOf(prompts: readonly Prompt[], selected: number | null, columns: number, rows: number): Layout {
  const count = `共 ${prompts.length} 句`

  if (prompts.length === 0) {
    return { count, rows: [], title: '', detail: [], hidden: 0 }
  }

  const chosen = Math.min(prompts.length - 1, Math.max(0, selected ?? prompts.length - 1))
  const prompt = prompts[chosen] as Prompt
  const wrapped = wrapOf(prompt.text, columns)
  const detailRoom = Math.max(3, Math.floor(rows * 0.4))
  const detail = wrapped.slice(0, detailRoom)
  const hidden = wrapped.length - detail.length
  // 標題、空行、分隔線、全文標題、（還有幾行）、空行、按鈕列
  const fixed = 6 + (hidden > 0 ? 1 : 0)
  const listRoom = Math.max(3, rows - fixed - detail.length)
  const start = Math.min(Math.max(0, chosen - Math.floor(listRoom / 2)), Math.max(0, prompts.length - listRoom))
  const digits = `${prompts.length}`.length
  const list: Row[] = prompts.slice(start, start + listRoom).map((item, offset) => {
    const at = start + offset
    const head = `${at === chosen ? '▸ ' : '  '}${`${at + 1}`.padStart(digits)}  ${clockOf(item.at)}  `

    return {
      at,
      label: head + fit(item.text.replace(/\s+/g, ' '), columns - widthOf(head)),
      isSelected: at === chosen,
      isShort: isShortOf(item.text),
    }
  })

  return { count, rows: list, title: `第 ${chosen + 1} 句・${clockOf(prompt.at)}`, detail, hidden }
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 widthOf、fit 從 ~/Workspace/projects/ctx-panel 系列複製（這裡的 fit 沒有 keepTail）；mod 之間不能互相 import。
// 2026-10-03 一開始照規格用「10 個字以內」判斷短回覆，測試時「幫我做時間軸」也被變暗；主人同意改成固定的同意用語清單。
// 2026-10-03 clockOf 用 Date 的本地時間；測試只驗「兩位數:兩位數」的格式，不驗是幾點，因為測試機的時區不一定。
// #endregion
