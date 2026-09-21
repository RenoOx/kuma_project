import { useRef, useState } from 'react'

export interface KeyedRow<T> {
  /** Stable across edits, reorders and removals. Never derived from the value. */
  key: string
  value: T
}

export interface KeyedDraft<T> {
  rows: KeyedRow<T>[]
  /** The draft as the server wants it: values only, in order. */
  values: T[]
  add: (value: T) => void
  update: (index: number, value: T) => void
  remove: (index: number) => void
}

/**
 * An editable list whose rows keep their React identity.
 *
 * Services, payment methods and special days all live in jsonb arrays with no
 * ids, so every one of these lists was keyed on `${someField}-${index}`. That
 * key changes the moment the field is edited and, worse, the row at index 2
 * keeps index 2 after the row above it is deleted — so React reconciles the
 * deleted row's DOM state onto its successor, and a focused input or an open
 * form lands on the wrong row.
 *
 * The key is minted here when the row is created and travels with it. It exists
 * only in the browser; the values that go to the server are untouched.
 */
export function useKeyedDraft<T>(initial: T[]): KeyedDraft<T> {
  const nextKey = useRef(0)
  const mint = (): string => {
    nextKey.current += 1
    return `row-${nextKey.current}`
  }

  const [rows, setRows] = useState<KeyedRow<T>[]>(() =>
    initial.map((value) => ({ key: mint(), value })),
  )

  // Re-seeded when the SERVER's list changes, which the lazy initializer above
  // cannot do on its own — it runs once and never looks again.
  //
  // Without this the card never comes clean after a save. Adding a service
  // sends it with no id; the server mints one and answers with it; the draft
  // keeps the id-less copy, so `dirty` stays true forever, the "Guardado" tick
  // never appears and the button stays lit. The row IS in Postgres — the panel
  // just has no way to admit it.
  //
  // Compared by CONTENT, not identity: every refetch hands back a fresh array,
  // so a reference check would re-seed on any invalidation and throw away edits
  // in progress. By content, saving a different card on the same screen leaves
  // this list byte-identical and the draft untouched.
  const served = JSON.stringify(initial)
  const [syncedTo, setSyncedTo] = useState(served)
  if (syncedTo !== served) {
    setSyncedTo(served)
    setRows(initial.map((value) => ({ key: mint(), value })))
  }

  return {
    rows,
    values: rows.map((row) => row.value),
    add: (value) => setRows((prev) => [...prev, { key: mint(), value }]),
    update: (index, value) =>
      setRows((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row))),
    remove: (index) => setRows((prev) => prev.filter((_, i) => i !== index)),
  }
}
