import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import { layoutOf } from './view'
import type { Prompt } from './view'

const PANE = 'prompts'
// 側邊欄縮在輸入框上面時拿不到真正的高度，用這個當作可用列數
const INLINE_ROWS = 34
// 主人自己打的：輸入框（composer），或從手機、網頁遠端操作（bridge）
const TYPED_BY_PERSON = new Set(['composer', 'bridge'])

/** mod 在記憶體裡記的全部東西；register 每次載入建一份新的。 */
type State = {
  prompts: Prompt[]
  // 選中第幾句（從 0 起算）；null 是跟著最新的一句
  selected: number | null
}

/** 現在選中的那一句；清單是空的回 undefined。 */
function chosenOf(state: State): Prompt | undefined {
  const at = state.selected ?? state.prompts.length - 1

  return state.prompts[Math.min(state.prompts.length - 1, Math.max(0, at))]
}

/** 把選中的那句複製到剪貼簿，結果用一則小提示告訴主人。 */
async function copyChosen($: EngineInterface, state: State, press: UiPressArgument): Promise<void> {
  const prompt = chosenOf(state)

  if (prompt === undefined) {
    return
  }

  try {
    const copied = await $.ui.copy({ text: prompt.text, surface: press.surface })

    $.ui.toast(copied.isCopied ? '複製好了' : `沒有複製成功（${copied.reason}）`)
  } catch {
    $.ui.toast('沒有複製成功')
  }
}

/** 把選中的那句放回輸入框：輸入框是空的就直接放，已經有字就換一行接在後面。 */
async function fillChosen($: EngineInterface, state: State): Promise<void> {
  const prompt = chosenOf(state)

  if (prompt === undefined) {
    return
  }

  try {
    const draft = await $.prompt.read()
    const filled =
      draft.text.trim() === ''
        ? await $.prompt.fill({ text: prompt.text, mode: 'replace' })
        : await $.prompt.fill({ text: `\n${prompt.text}`, mode: 'append' })

    if (!filled.isFilled) {
      $.ui.toast(`沒有放進輸入框${filled.refusal === undefined ? '' : `（${filled.refusal}）`}`)
    }
  } catch {
    $.ui.toast('沒有放進輸入框')
  }
}

/**
 * 【職責】把「我問過的」面板接上 Claude Code：提供 /prompts，在側邊欄列出主人這次對話打過的每一句話，
 *   選一句看全文、複製、放回輸入框。只記主人自己送出的話（輸入框、遠端操作）；排程送的（快取保溫）、
 *   背景工作的通知、別的 session 傳來的都不記。不改送出的內容、不連網路、不寫檔。
 * 【何時能呼叫】引擎載入這個 mod 時呼叫一次；重新載入會再呼叫，清單從空的開始（載入前打的話不會補回來）。
 * 【行為】有人在用的 session（不是 claude -p）一開始就自己打開側邊欄；終端機不夠寬時先等著，
 *   寬度夠了才出現（主人自己開過的 110 格，沒開過的 144 格，這是系統的規定）。
 *   /prompts：側邊欄沒開就開、開著就關。/prompts close：關掉。/prompts 數字：用那個寬度（格數）開。
 *   清單預設選中最新的一句，有新的一句進來時跟著換；主人自己選過某一句之後就停在那句，選回最新的一句才恢復跟著。
 *   點一列（或按 K、J 往上、往下）換選中的那句，下半部顯示全文。按 C 複製全文，按 E 放回輸入框
 *   （輸入框是空的就直接放，已經有字就換一行接在後面），失敗或出錯時跳一則小提示，不會丟出錯誤。
 *   整句只是「照推薦」「可以」「好」這類同意用語的畫成暗色，其他不管多短都正常顯示。/clear 之後清空。
 */
export const register: Register = on => {
  const state: State = { prompts: [], selected: null }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompts',
      description: '側邊欄的「我問過的」：這次對話打過的每一句話；/prompts 開或關',
      immediate: true,
    })

    // 一開 session 就自己打開；不是主人叫的，終端機要夠寬才放得出來，不夠寬就先等著，不用等它
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: '我問過的' })
    }

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear'] }, ($, e, next) => {
    state.prompts = []
    state.selected = null
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()

    if (TYPED_BY_PERSON.has(e.origin.kind) && text !== '') {
      state.prompts.push({ text, at: await $.clock.now() })
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('command.run', { command: 'prompts' }, async ($, e) => {
    const arg = e.args.trim()
    const wanted = Number.parseInt(arg, 10)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (arg === 'close' || (arg === '' && isUp)) {
      await $.ui.close({ id: PANE })

      return {}
    }

    const opened = await $.ui.open(
      Number.isInteger(wanted) && wanted > 0
        ? { id: PANE, title: '我問過的', columns: wanted }
        : { id: PANE, title: '我問過的' },
    )

    if (!opened.isPlaced) {
      return { text: `側邊欄沒有被放出來：${opened.reason}` }
    }

    // 重新打開時引擎可能直接拿上次畫好的結果來用，所以自己要求重畫
    $.ui.invalidate('ui.render')

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : INLINE_ROWS
    const columns = e.props.bodyColumns
    const layout = layoutOf(state.prompts, state.selected, columns, rows)
    const last = state.prompts.length - 1
    const select = (at: number) => {
      const target = Math.min(last, Math.max(0, at))

      // 選回最新的一句就恢復「跟著最新的」
      state.selected = target === last ? null : target
      $.ui.invalidate('ui.render')
    }
    const current = state.selected ?? last
    const header = Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [Text({ bold: true, children: ['我問過的'] }), Text({ dimColor: true, children: [layout.count] })],
    })

    if (layout.rows.length === 0) {
      return Box({
        flexDirection: 'column',
        children: [header, Text({ children: [' '] }), Text({ dimColor: true, children: ['這次對話還沒有打過任何一句話'] })],
      })
    }

    return Box({
      flexDirection: 'column',
      children: [
        header,
        Text({ children: [' '] }),
        ...layout.rows.map(row =>
          Button({
            key: `row-${row.at}`,
            label: row.label,
            plain: true,
            ...(row.isShort && !row.isSelected ? { dimColor: true } : {}),
            onPress: () => select(row.at),
          }),
        ),
        Text({ dimColor: true, children: ['─'.repeat(Math.max(1, columns))] }),
        Text({ bold: true, children: [layout.title] }),
        ...layout.detail.map(text => Text({ wrap: 'truncate-end', children: [text === '' ? ' ' : text] })),
        ...(layout.hidden > 0
          ? [Text({ dimColor: true, children: [`…還有 ${layout.hidden} 行，按 C 複製全文`] })]
          : []),
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          flexWrap: 'wrap',
          children: [
            Button({ key: 'older', label: '上一句', hotkey: 'k', plain: true, onPress: () => select(current - 1) }),
            Button({ key: 'newer', label: '下一句', hotkey: 'j', plain: true, onPress: () => select(current + 1) }),
            Button({ key: 'copy', label: '複製', hotkey: 'c', plain: true, onPress: press => void copyChosen($, state, press) }),
            Button({ key: 'fill', label: '放回輸入框', hotkey: 'e', plain: true, onPress: () => void fillChosen($, state) }),
          ],
        }),
      ],
    })
  })
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 只認 e.origin.kind 是 composer、bridge 的；快取保溫走 scheduled-trigger，背景工作是 task-notification。
//   斜線指令（/ctx 這種 immediate 的）不經過 prompt.submit；skill 類的斜線指令送出時 e.text 長什麼樣子未在真機驗過。
// 2026-10-03 按鈕的 hotkey 只能是一個數字或小寫字母，方向鍵不行，所以上下選用 K、J。hotkey 要側邊欄拿到鍵盤才有效
//   （點一下側邊欄、ctrl+x tab），輸入框有焦點時按 C、E 是打字。
// 2026-10-03 --resume 不從 $.session.messages() 補回舊的話：那裡沒有時間、分不出排程送的，壓縮過的也不見了。主人同意。
// #endregion
