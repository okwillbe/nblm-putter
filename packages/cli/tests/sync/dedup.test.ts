import { describe, it, expect } from 'vitest'
import { filterNewSources } from '../../src/sync/dedup'

describe('filterNewSources', () => {
  it('returns all uploaded when existing is empty', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf'], [])).toEqual(['a.pdf', 'b.pdf'])
  })

  it('excludes names already present in existing', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf', 'c.pdf'], ['b.pdf'])).toEqual(['a.pdf', 'c.pdf'])
  })

  it('returns empty when all uploaded already exist', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf'], ['a.pdf', 'b.pdf'])).toEqual([])
  })

  it('preserves original order of uploaded', () => {
    expect(filterNewSources(['c.pdf', 'a.pdf', 'b.pdf'], ['a.pdf'])).toEqual(['c.pdf', 'b.pdf'])
  })

  it('matches names exactly (no partial match)', () => {
    expect(filterNewSources(['report.pdf', 'report.pdf.bak'], ['report.pdf'])).toEqual(['report.pdf.bak'])
  })
})
