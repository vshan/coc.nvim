import { Neovim } from '@chemzqm/neovim'
import { Disposable } from 'vscode-languageserver-protocol'
import events from './events'
import Increment from './increment'
import Complete from './model/complete'
import sources from './sources'
import { CompleteConfig, CompleteOption, RecentScore, VimCompleteItem, WorkspaceConfiguration } from './types'
import { disposeAll } from './util'
import { isCocItem } from './util/complete'
import { fuzzyMatch, getCharCodes } from './util/fuzzy'
import { byteSlice } from './util/string'
import workspace from './workspace'
const logger = require('./util/logger')('completion')

export interface LastInsert {
  character: string
  timestamp: number
}

export class Completion implements Disposable {
  private increment: Increment
  private lastInsert?: LastInsert
  private lastChangedI: number
  private lastPumvisible = 0
  private insertMode = false
  private nvim: Neovim
  private completing = false
  private disposables: Disposable[] = []
  private completeItems: VimCompleteItem[] = []
  private complete: Complete | null = null
  private recentScores: RecentScore = {}
  private option: CompleteOption = null
  private preferences: WorkspaceConfiguration

  constructor() {
    this.preferences = workspace.getConfiguration('coc.preferences')

    workspace.onDidChangeConfiguration(_e => {
      this.preferences = workspace.getConfiguration('coc.preferences')
    }, null, this.disposables)
  }

  // vim's logic for filter items
  private filterItemsVim(input: string): VimCompleteItem[] {
    return this.completeItems.filter(item => {
      return item.word.startsWith(input)
    })
  }

  // TODO this is incorrect sometimes
  private getCompleteItem(word: string): VimCompleteItem | null {
    let { completeItems } = this
    if (!completeItems) return null
    return completeItems.find(o => o.word == word)
  }

  private addRecent(word: string): void {
    if (!word || !this.option) return
    let { input } = this.option
    if (!input.length) return
    let key = `${input.slice(0, 1)}|${word}`
    let val = this.recentScores[key]
    if (!val) {
      this.recentScores[key] = 0.01
    } else {
      this.recentScores[key] = Math.min(val + 0.01, 0.1)
    }
  }

  private async getResumeInput(): Promise<string> {
    let { option, increment } = this
    let [, lnum, col] = await this.nvim.call('getcurpos')
    if (lnum != option.linenr || col <= option.col) {
      increment.stop()
      return null
    }
    let line = option.document.getline(lnum - 1)
    return byteSlice(line, option.col, col - 1)
  }

  private get isTriggered(): boolean {
    let { option } = this
    let { document, triggerCharacter } = option
    return triggerCharacter && !document.isWord(triggerCharacter)
  }

  private get bufnr(): number {
    let { option } = this
    return option ? option.bufnr : null
  }

  private get input(): string {
    let { option } = this
    return option ? option.input : null
  }

  public init(nvim: Neovim): void {
    this.nvim = nvim
    let increment = this.increment = new Increment(nvim)
    this.disposables.push(events.on('InsertCharPre', this.onInsertCharPre, this))
    this.disposables.push(events.on('InsertLeave', this.onInsertLeave, this))
    this.disposables.push(events.on('InsertEnter', this.onInsertEnter, this))
    this.disposables.push(events.on('TextChangedP', this.onTextChangedP, this))
    this.disposables.push(events.on('TextChangedI', this.onTextChangedI, this))
    this.disposables.push(events.on('CompleteDone', this.onCompleteDone, this))
    nvim.mode.then(({ mode }) => {
      this.insertMode = mode.startsWith('i')
    }, _e => {
      // noop
    })
    // stop change emit on completion
    increment.on('start', () => {
      this.completeItems = []
      let { document } = this.option
      document.paused = true
    })
    increment.on('stop', () => {
      let { document } = this.option
      document.paused = false
      this.option = null
    })
  }

  public get isActivted(): boolean {
    return this.increment.isActivted
  }

  private getCompleteConfig(): CompleteConfig {
    let config = workspace.getConfiguration('coc.preferences')
    return {
      maxItemCount: config.get<number>('maxCompleteItemCount', 50),
      timeout: config.get<number>('timeout', 500)
    }
  }

  public get hasLatestChangedI(): boolean {
    let { lastChangedI } = this
    return lastChangedI && Date.now() - lastChangedI < 80
  }

  public startCompletion(option: CompleteOption): void {
    Object.defineProperty(option, 'document', {
      value: workspace.getDocument(option.bufnr),
      enumerable: false
    })
    if (option.document == null || this.completing) return
    this.completing = true
    this._doComplete(option).then(() => {
      this.completing = false
    }).catch(e => {
      this.completing = false
      workspace.showMessage(`Error happens on complete: ${e.message}`)
      logger.error('', e.stack)
    })
  }

  private async resumeCompletion(resumeInput: string, isChangedP = false): Promise<void> {
    let { nvim, increment, option, complete, insertMode } = this
    if (!complete || !complete.results) return
    option.input = resumeInput
    let items = complete.filterResults(resumeInput)
    if (!insertMode || !items || items.length === 0) {
      this.nvim.call('coc#_hide', [], true)
      increment.stop()
      return
    }
    if (isChangedP) {
      let filtered = this.filterItemsVim(resumeInput)
      if (filtered.length == items.length) {
        return
      }
    }
    nvim.call('coc#_set_context', [option.col, items], true)
    this.completeItems = items
    await nvim.call('coc#_do_complete', [])
    await this.onPumVisible()
  }

  private async onPumVisible(): Promise<void> {
    this.lastPumvisible = Date.now()
    let first = this.completeItems[0]
    let noselect = this.preferences.get<boolean>('noselect')
    if (!noselect) await sources.doCompleteResolve(first)
  }

  private async _doComplete(option: CompleteOption): Promise<void> {
    let { document, linenr, line } = option
    let { nvim, increment } = this
    this.option = option
    increment.start()
    logger.trace(`options: ${JSON.stringify(option)}`)
    let arr = sources.getCompleteSources(option)
    logger.trace(`Activted sources: ${arr.map(o => o.name).join(',')}`)
    let config = this.getCompleteConfig()
    this.complete = new Complete(option, this.recentScores, config)
    let items = await this.complete.doComplete(arr)
    if (items.length == 0 || !this.insertMode) {
      increment.stop()
      return
    }
    // changedtick could change without content change
    if (document.getline(linenr - 1) == line) {
      nvim.call('coc#_set_context', [option.col, items], true)
      this.completeItems = items
      await nvim.call('coc#_do_complete', [])
      await this.onPumVisible()
      return
    }
    let search = await this.getResumeInput()
    if (search == null) return
    await this.resumeCompletion(search)
  }

  private async onTextChangedP(): Promise<void> {
    let { increment, input } = this
    if (Math.abs(Date.now() - this.lastPumvisible) < 10) return
    if (this.hasLatestChangedI || this.completing || !increment.isActivted) return
    let { latestInsert } = this
    let search = await this.getResumeInput()
    if (search == null || input == search) return
    if (latestInsert) {
      await this.resumeCompletion(search, true)
      return
    }
    let item = this.getCompleteItem(search)
    if (item) await sources.doCompleteResolve(item)
  }

  private async onTextChangedI(bufnr: number): Promise<void> {
    this.lastChangedI = Date.now()
    if (this.completing) return
    let { nvim, increment, input } = this
    let { latestInsertChar } = this
    if (increment.isActivted) {
      if (bufnr !== this.bufnr) return
      let search = await this.getResumeInput()
      if (search == null || search == input) return
      if (!increment.isActivted) return
      let { document } = this.option
      let len = input.length
      if (!this.isTriggered && len == 0 && document.isWord(search[0])) {
        increment.stop()
      } else {
        return await this.resumeCompletion(search)
      }
    }
    if (!latestInsertChar) return
    // check trigger
    let shouldTrigger = await this.shouldTrigger(latestInsertChar)
    if (!shouldTrigger) return
    let option: CompleteOption = await nvim.call('coc#util#get_complete_option')
    if (latestInsertChar) option.triggerCharacter = latestInsertChar
    logger.trace('trigger completion with', option)
    this.startCompletion(option)
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    if (!isCocItem(item)) return
    let { increment } = this
    try {
      increment.stop()
      this.addRecent(item.word)
      await sources.doCompleteDone(item)
    } catch (e) {
      logger.error(`error on complete done`, e.message)
    }
  }

  private async onInsertLeave(): Promise<void> {
    this.insertMode = false
    this.nvim.call('coc#_hide', [], true)
    this.increment.stop()
  }

  private async onInsertEnter(): Promise<void> {
    this.insertMode = true
    let autoTrigger = this.preferences.get<string>('autoTrigger', 'always')
    if (autoTrigger !== 'always') return
    let trigger = this.preferences.get<boolean>('triggerAfterInsertEnter', false)
    if (trigger && !this.completing) {
      let option = await this.nvim.call('coc#util#get_complete_option')
      this.startCompletion(option)
    }
  }

  private onInsertCharPre(character: string): void {
    let { increment } = this
    this.lastInsert = {
      character,
      timestamp: Date.now(),
    }
    if (this.completing) return
    if (increment.isActivted) {
      let { input } = this.option
      if (!this.hasMatch(input + character)) {
        this.nvim.call('coc#_hide', [], true)
        increment.stop()
      }
    }
  }

  private get latestInsert(): LastInsert | null {
    let { lastInsert } = this
    let d = workspace.isVim ? 100 : 50
    if (!lastInsert || Date.now() - lastInsert.timestamp > d) {
      return null
    }
    return lastInsert
  }

  private get latestInsertChar(): string {
    let { latestInsert } = this
    if (!latestInsert) return ''
    return latestInsert.character
  }

  private async shouldTrigger(character: string): Promise<boolean> {
    if (!character || character == ' ') return false
    let autoTrigger = this.preferences.get<string>('autoTrigger', 'always')
    if (autoTrigger == 'none') return false
    let doc = await workspace.document
    // let [, lnum, col] = await this.nvim.call('getcurpos')
    // let line = doc.getline(lnum - 1)
    if (sources.shouldTrigger(character, doc.filetype)) return true
    if (doc.isWord(character)) return autoTrigger == 'always'
    return false
  }

  public dispose(): void {
    if (this.increment) {
      this.increment.removeAllListeners()
      this.increment.stop()
    }
    disposeAll(this.disposables)
  }

  public hasMatch(search: string): boolean {
    let { completeItems } = this
    if (!completeItems) return false
    let codes = getCharCodes(search)
    for (let o of completeItems) {
      let s = o.filterText || o.word
      if (fuzzyMatch(codes, s)) {
        return true
      }
    }
    return false
  }
}

export default new Completion()
