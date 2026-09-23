/**
 * splitSqlStatements — a semicolon only ends a statement when it is one.
 *
 * The regression this exists for: a `;` written inside a `--` comment in the
 * app's CREATE TABLE for `recordings` cut the statement in half, SQLite
 * rejected the fragment, the table was never created, and every migration that
 * followed failed with "no such table: recordings". The old implementation was
 * `schema.split(';')`.
 */
import { describe, it, expect } from 'vitest'
import { splitSqlStatements } from '../src/engine'

describe('splitSqlStatements', () => {
  it('splits ordinary statements and drops the empty pieces', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;;\n  \n')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a semicolon written inside a line comment', () => {
    const schema = [
      'CREATE TABLE recordings (',
      '    id TEXT PRIMARY KEY,',
      "    -- measured from the file; anything else is an estimate",
      '    duration_source TEXT',
      ');',
    ].join('\n')
    const statements = splitSqlStatements(schema)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('duration_source TEXT')
  })

  it('keeps a semicolon written inside a block comment', () => {
    const statements = splitSqlStatements('CREATE TABLE t (/* one; two */ id TEXT);')
    expect(statements).toEqual(['CREATE TABLE t (/* one; two */ id TEXT)'])
  })

  it('keeps a semicolon written inside a string literal', () => {
    const statements = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;")
    expect(statements).toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT 1'])
  })

  it('keeps a semicolon inside a quoted identifier', () => {
    expect(splitSqlStatements('CREATE TABLE "odd;name" (id TEXT);')).toEqual([
      'CREATE TABLE "odd;name" (id TEXT)',
    ])
  })

  it("treats SQLite's doubled-quote escape as staying inside the literal", () => {
    const statements = splitSqlStatements("SELECT 'it''s; fine'; SELECT 2;")
    expect(statements).toEqual(["SELECT 'it''s; fine'", 'SELECT 2'])
  })

  it('returns the last statement even without a trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('returns nothing for an empty or comment-only script', () => {
    expect(splitSqlStatements('')).toEqual([])
    expect(splitSqlStatements('-- nothing here;\n')).toEqual(['-- nothing here;'])
  })
})
