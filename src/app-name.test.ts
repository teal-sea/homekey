// index.html and package.json cannot import a module, so they repeat the name
// by hand. A rename that misses one of them fails here instead of shipping.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_SLUG } from './app-name'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the app name', () => {
  it('is the <title> in index.html', () => {
    expect(read('../index.html')).toContain(`<title>${APP_NAME}</title>`)
  })

  it('is the package name in package.json, as a slug', () => {
    expect((JSON.parse(read('../package.json')) as { name: string }).name).toBe(APP_SLUG)
  })

  it('has a slug that is safe in a file name and a storage key', () => {
    expect(APP_SLUG).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })
})
