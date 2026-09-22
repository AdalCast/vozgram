/** EventEmitter minimo: varias clases de GramJS lo extienden. */
export class EventEmitter {
  private _h = new Map<string, Function[]>()
  on(e: string, f: Function) {
    const l = this._h.get(e) ?? []
    l.push(f); this._h.set(e, l); return this
  }
  once(e: string, f: Function) {
    const g = (...a: unknown[]) => { this.off(e, g); f(...a) }
    return this.on(e, g)
  }
  off(e: string, f: Function) {
    const l = this._h.get(e)
    if (l) this._h.set(e, l.filter(x => x !== f))
    return this
  }
  removeListener(e: string, f: Function) { return this.off(e, f) }
  removeAllListeners(e?: string) { e ? this._h.delete(e) : this._h.clear(); return this }
  emit(e: string, ...a: unknown[]) {
    const l = this._h.get(e)
    if (!l?.length) return false
    for (const f of [...l]) f(...a)
    return true
  }
  listenerCount(e: string) { return (this._h.get(e) ?? []).length }
}
export default { EventEmitter }
