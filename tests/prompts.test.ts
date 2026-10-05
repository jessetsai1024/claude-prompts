import { expect, mock, test } from 'claude-code/testing'

import { clockOf, isShortOf, layoutOf, widthOf, wrapOf } from '../hooks/view'
import type { Prompt } from '../hooks/view'

const LONG = '我問過的問題。 把主人這次對話打過的每一句話列成一排，點一下就能看全文。\n對話很長、經過壓縮之後，比較容易找回「我剛剛到底要求了什麼」。參考 prompt-rail <- 幫我做這個 mod'

function promptsOf(count: number): Prompt[] {
  return Array.from({ length: count }, (_, at) => ({ text: at % 3 === 1 ? '照推薦' : `第 ${at + 1} 個要求：${LONG}`, at: at * 60_000 }))
}

test('換行、短回覆、時間格式', async () => {
  expect(wrapOf('abcdef', 4)).toEqual(['abcd', 'ef'])
  expect(wrapOf('中文字', 4)).toEqual(['中文', '字'])
  expect(wrapOf('a\n\nb', 10)).toEqual(['a', '', 'b'])
  expect(['照推薦', '可以', 'OK', '好的。', '可以喵～', ' yes! '].map(isShortOf)).toEqual([true, true, true, true, true, true])
  expect(['幫我刪除', '刪掉 crew', '幫我做時間軸', '可以了，選到 ctx 了', '不改了, 先這樣'].map(isShortOf)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ])
  expect(clockOf(0)).toMatch(/^\d\d:\d\d$/)
})

test('排版：每列放得下、預設選最新、選中的那句看得到、全文放不下會說還有幾行', async () => {
  const prompts = promptsOf(25)

  for (const columns of [24, 47, 73]) {
    const layout = layoutOf(prompts, null, columns, 38)

    for (const row of layout.rows) {
      expect(widthOf(row.label)).toBeLessThanOrEqual(columns)
    }

    for (const text of layout.detail) {
      expect(widthOf(text)).toBeLessThanOrEqual(columns)
    }
  }

  const latest = layoutOf(prompts, null, 47, 38)

  expect(latest.count).toBe('共 25 句')
  expect(latest.rows.at(-1)?.isSelected).toBe(true)
  expect(latest.rows.at(-1)?.label).toMatch(/^▸ 25  \d\d:\d\d  第 25 個要求/)
  expect(latest.title).toMatch(/^第 25 句・\d\d:\d\d$/)
  expect(latest.rows.find(row => row.label.includes('照推薦'))?.isShort).toBe(true)

  const early = layoutOf(prompts, 2, 47, 38)

  expect(early.rows.some(row => row.at === 2 && row.isSelected)).toBe(true)
  expect(early.rows[0]?.at).toBe(0)

  const tight = layoutOf([{ text: LONG.repeat(6), at: 0 }], null, 30, 20)

  expect(tight.detail.length).toBe(8)
  expect(tight.hidden).toBeGreaterThan(0)
  expect(layoutOf([], null, 47, 38).rows).toEqual([])
})

test('只記主人打的話；點選、上下一句、複製、放回輸入框、/clear 清空', async ($, on) => {
  mock.clock(on)
  const copied: string[] = []
  const filled: { text: string; mode?: string }[] = []
  let draft = ''

  on('ui.invalidate', (_, e, next) => next(e))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_, e) => {
    filled.push({ text: e.text, ...(e.mode === undefined ? {} : { mode: e.mode }) })

    return { isFilled: true } as never
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('classic.SessionStart', () => ({}) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'prompts',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prompts',
    props: {
      title: '我問過的',
      isFocused: true,
      bodyColumns: 47,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 38 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text', text: /還沒有打過任何一句話/ })).toBeDefined()

  const submit = (text: string, kind: string) =>
    $.prompt.submit({ text, wait: false, origin: { kind } } as never)

  await submit('幫我做時間軸', 'composer')
  await submit('快取保溫，回一個字就好', 'scheduled-trigger')
  await submit('<task-notification>done</task-notification>', 'task-notification')
  await submit('照推薦', 'composer')
  await submit('從手機打的', 'bridge')

  expect(await ui.find({ type: 'Text', text: /共 3 句/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /快取保溫/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^▸ 3 .*從手機打的/ })).toBeDefined()

  await ui.press({ key: 'row-0' })
  expect(await ui.find({ type: 'Text', text: /^第 1 句・/ })).toBeDefined()

  await ui.press({ key: 'newer' })
  expect(await ui.find({ type: 'Text', text: /^第 2 句・/ })).toBeDefined()

  await ui.press({ key: 'copy' })
  expect(copied).toEqual(['照推薦'])

  await ui.press({ key: 'fill' })
  draft = '打到一半'
  await ui.press({ key: 'older' })
  await ui.press({ key: 'fill' })
  expect(filled).toEqual([
    { text: '照推薦', mode: 'replace' },
    { text: '\n幫我做時間軸', mode: 'append' },
  ])

  // 選了舊的那句，新的一句進來時停在原地
  await submit('再一句', 'composer')
  expect(await ui.find({ type: 'Text', text: /^第 1 句・/ })).toBeDefined()

  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(await ui.find({ type: 'Text', text: /還沒有打過任何一句話/ })).toBeDefined()

  await ui.unmount()
})
