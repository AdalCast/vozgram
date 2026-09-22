export const join = (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/')
export const basename = (p: string) => String(p).split('/').pop() ?? ''
export const dirname = (p: string) => String(p).split('/').slice(0, -1).join('/') || '.'
export const resolve = (...p: string[]) => join(...p)
export const extname = (p: string) => {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i) : ''
}
export default { join, basename, dirname, resolve, extname }
