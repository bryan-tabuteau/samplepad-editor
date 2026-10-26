import { describe, it, expect, beforeEach, vi } from 'vitest'
import nodePath from 'path'

// a fake SD card: absolute path => file names in that directory
const h = vi.hoisted(() => ({
  disk: {},        // dir => [fileName]
  persisted: {},   // electron-store contents
  copies: [],      // [source, dir, newName]
  failCopy: new Set()
}))

vi.hoisted(() => {
  globalThis.window = {
    api: {
      store: {
        get: (k) => h.persisted[k],
        save: (k, v) => { h.persisted[k] = JSON.parse(JSON.stringify(v)) }
      },
      path: { parse: (f) => nodePath.parse(f) },
      fs: {
        isDirectory: (f) => f in h.disk,
        getFileListFromDirectory: (d) => h.disk[d].map((n) => d + '/' + n),
        getSampleFiles: (d) => h.disk[d]
          .filter((n) => n.toUpperCase().endsWith('.WAV') && !n.startsWith('.'))
          .map((name) => ({ name }))
      }
    }
  }
})

vi.mock('util/storage', () => ({
  copySample: (source, dir, newName) => {
    if (h.failCopy.has(nodePath.parse(source).base)) {
      throw new Error('bad wav')
    }
    h.copies.push([source, dir, newName])
    if (!(h.disk[dir] || []).includes(newName)) {
      h.disk[dir] = [...(h.disk[dir] || []), newName]
    }
  }
}))
vi.mock('util/fileDialog', () => ({ openSampleFileDialog: vi.fn() }))
vi.mock('actions/notice', () => ({ showNotice: vi.fn() }))

const CARD = 'E:/card'
const loadFresh = async () => {
  vi.resetModules()
  return (await import('util/sampleStore')).default
}

describe('SampleStore', () => {
  let store

  beforeEach(async () => {
    h.disk = { [CARD]: [] }
    h.persisted = {}
    h.copies = []
    h.failCopy = new Set()
    store = await loadFresh()
  })

  describe('importFiles', () => {
    beforeEach(() => store.loadSamplesFromDirectory('dev1', CARD))

    it('keeps a readable 8.3 name and the original display name', () => {
      store.importFiles(['C:/in/kick.wav', 'C:/in/snare.wav', 'C:/in/bassdrum.wav'], 0)

      expect(store.getSamples()).toEqual({
        'kick.wav': 'kick.wav',
        'snare.wav': 'snare.wav',
        'bassdrum.wav': 'bassdrum.wav'
      })
      expect(h.disk[CARD]).toEqual(['kick.wav', 'snare.wav', 'bassdrum.wav'])
    })

    it('truncates long names and avoids collisions', () => {
      store.importFiles(['C:/in/TR-909-KICK.wav', 'C:/in/TR-909-KICK2.wav'], 0)

      expect(store.getSamples()).toEqual({
        'TR-909-KICK.wav': 'TR909KIC.wav',
        'TR-909-KICK2.wav': 'TR909KI1.wav'
      })
    })

    it('accepts upper case extensions', () => {
      let result = store.importFiles(['C:/in/KICK.WAV'], 0)

      expect(result.imported).toBe(1)
      expect(Object.keys(store.getSamples())).toEqual(['KICK.WAV'])
      expect(store.getSamples()['KICK.WAV']).toMatch(/\.wav$/)
    })

    it('reads directories recursively and ignores other files', () => {
      h.disk['C:/in'] = ['a.wav', 'notes.txt', 'sub']
      h.disk['C:/in/sub'] = ['b.wav']

      let result = store.importFiles(['C:/in'], 0)

      expect(result.imported).toBe(2)
      expect(result.ignored).toEqual(['notes.txt'])
    })

    it('reports a copy failure and leaves no ghost entry', () => {
      h.failCopy.add('bad.wav')

      let result = store.importFiles(['C:/in/good.wav', 'C:/in/bad.wav'], 0)

      expect(result.imported).toBe(1)
      expect(result.failed).toEqual(['bad.wav'])
      expect(Object.keys(store.getSamples())).toEqual(['good.wav'])
    })

    it('overwrites a sample with the same display name, reusing its file', () => {
      let result = store.importFiles(['C:/in/kick.wav', 'C:/in/Kick.WAV'], 0)

      expect(result.failed).toEqual([])
      expect(store.getSamples()).toEqual({ 'Kick.WAV': 'kick.wav' })
      expect(h.disk[CARD]).toEqual(['kick.wav'])
    })

    it('stops at the sample limit and says so', () => {
      let result = store.importFiles(['C:/in/a.wav', 'C:/in/b.wav'], 510)

      expect(result.imported).toBe(1)
      expect(result.limited).toEqual(['b.wav'])
    })
  })

  describe('loadSamplesFromDirectory', () => {
    it('uses the path of this mount, not the one remembered for the device', () => {
      h.disk['D:/card'] = ['kick.wav']
      store.loadSamplesFromDirectory('dev1', 'D:/card')

      h.disk['F:/card'] = ['kick.wav']
      store.loadSamplesFromDirectory('dev1', 'F:/card')

      expect(store.getFileNameOnDisk('kick.wav')).toBe('F:/card/kick.wav')
    })

    it('drops samples that are no longer on the card and adds new ones', async () => {
      h.disk[CARD] = ['kick.wav', 'gone.wav']
      store.loadSamplesFromDirectory('dev1', CARD)

      h.disk[CARD] = ['kick.wav', 'new.wav']
      let report = store.loadSamplesFromDirectory('dev1', CARD)

      expect(Object.keys(store.getSamples()).sort()).toEqual(['kick.wav', 'new.wav'])
      expect(report).toEqual({ added: ['new.wav'], removed: ['gone.wav'] })
    })

    it('keeps long display names across loads, even from a fresh process', async () => {
      h.disk[CARD] = []
      store.loadSamplesFromDirectory('dev1', CARD)
      store.importFiles(['C:/in/TR-909-KICK.wav'], 0)

      let fresh = await loadFresh()
      let report = fresh.loadSamplesFromDirectory('dev1', CARD)

      expect(fresh.getSamples()).toEqual({ 'TR-909-KICK.wav': 'TR909KIC.wav' })
      expect(report).toEqual({ added: [], removed: [] })
    })

    it('matches files on disk case-insensitively', () => {
      h.disk[CARD] = ['KICK.WAV']
      store.loadSamplesFromDirectory('dev1', CARD)

      h.disk[CARD] = ['kick.wav']
      let report = store.loadSamplesFromDirectory('dev1', CARD)

      expect(report).toEqual({ added: [], removed: [] })
    })

    it('migrates entries saved by older versions without an extension', async () => {
      h.disk[CARD] = ['bass.wav']
      h.persisted.samples = { dev1: { bassdrum: 'bass.wav' } }
      h.persisted.devicePaths = { dev1: 'Z:/card' }
      store = await loadFresh()

      store.loadSamplesFromDirectory('dev1', CARD)

      expect(store.getSamples()).toEqual({ 'bassdrum.wav': 'bass.wav' })
    })

    it('leaves other devices untouched', async () => {
      h.disk[CARD] = ['kick.wav']
      h.persisted.samples = { other: { 'x.wav': 'x.wav' } }
      store = await loadFresh()

      store.loadSamplesFromDirectory('dev1', CARD)

      expect(h.persisted.samples.other).toEqual({ 'x.wav': 'x.wav' })
    })
  })

  describe('kit file names', () => {
    beforeEach(() => {
      h.disk[CARD] = ['kick.wav']
      store.loadSamplesFromDirectory('dev1', CARD)
      store.importFiles(['C:/in/TR-909-KICK.wav'], 0)
    })

    it('writes the on-card name without extension', () => {
      expect(store.getWriteFileName('TR-909-KICK.wav')).toBe('TR909KIC')
      expect(store.getWriteFileName('')).toBe('')
    })

    it('does not throw for a sample that is not on the card', () => {
      expect(store.getWriteFileName('INTERNAL.wav')).toBe('INTERNAL')
      expect(store.getWriteFileName('LONGERTHAN8.wav')).toBe('LONGERTH')
    })

    it('maps a kit file name back to the display name, ignoring case', () => {
      expect(store.getFileNameFromKitFile('TR909KIC.wav')).toBe('TR-909-KICK.wav')
      expect(store.getFileNameFromKitFile('tr909kic.WAV')).toBe('TR-909-KICK.wav')
      expect(store.getFileNameFromKitFile('mystery.wav')).toBe('mystery.wav')
    })

    it('knows which samples exist', () => {
      expect(store.hasSample('TR-909-KICK.wav')).toBe(true)
      expect(store.hasSample('tr-909-kick.WAV')).toBe(true)
      expect(store.hasSample('mystery.wav')).toBe(false)
    })
  })
})
