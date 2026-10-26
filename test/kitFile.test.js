import { describe, it, expect, beforeEach, vi } from 'vitest'
import nodePath from 'path'

const h = vi.hoisted(() => ({ persisted: {}, files: {} }))

vi.hoisted(() => {
  globalThis.window = {
    api: {
      store: {
        get: (k) => h.persisted[k],
        save: (k, v) => { h.persisted[k] = JSON.parse(JSON.stringify(v)) }
      },
      path: { parse: (f) => nodePath.parse(f) },
      fs: {
        exists: (f) => f in h.files,
        readFileBufferArray: (f) => h.files[f],
        getSampleFiles: () => []
      }
    }
  }
})

vi.mock('util/storage', () => ({ copySample: vi.fn() }))
vi.mock('util/fileDialog', () => ({ openSampleFileDialog: vi.fn() }))
vi.mock('actions/notice', () => ({ showNotice: vi.fn() }))

import { DeviceType, KitBuffer } from 'const'
import { KitModel, PadModel } from 'state/models'

describe('kit files', () => {
  let SampleStore, kitFile
  const drive = { deviceType: DeviceType.SAMPLERACK }

  const makeKit = (fileNames) => {
    let pads = {}
    KitBuffer.PAD_FILE_ORDER[drive.deviceType].forEach((padType) => {
      let pad = PadModel.getPad(padType)
      pads[pad.id] = pad
    })
    let ids = Object.keys(pads)
    ids.forEach((id, i) => { pads[id].fileName = fileNames[i] || '' })

    return { kit: KitModel('KITS', 'TEST.KIT', false, true, true, 'TEST', ids), pads, ids }
  }

  beforeEach(async () => {
    h.persisted = {}
    h.files = {}
    vi.resetModules()
    SampleStore = (await import('util/sampleStore')).default
    kitFile = await import('util/kitFile')
    SampleStore.deviceId = 'dev1'
    SampleStore.devicePath = 'E:/card'
    SampleStore.deviceSamples = { 'TR-909-KICK.wav': 'TR909KIC.wav' }
    SampleStore._loadFilenames()
  })

  it('writes the on-card name and reads the display name back', () => {
    let { kit, pads, ids } = makeKit(['TR-909-KICK.wav'])

    h.files['KITS/TEST.KIT'] = kitFile.getKitFileBuffer(drive, kit, pads)
    let result = kitFile.getKitAndPadsFromFile(drive, 'KITS/TEST.KIT')

    expect(result.pads[Object.keys(result.pads)[0]].fileName).toBe('TR-909-KICK.wav')
  })

  it('saves a kit that uses a sample that is not on the card, keeping the reference', () => {
    let { kit, pads } = makeKit(['MISSING.wav'])

    expect(() => kitFile.getKitFileBuffer(drive, kit, pads)).not.toThrow()

    h.files['KITS/TEST.KIT'] = kitFile.getKitFileBuffer(drive, kit, pads)
    let result = kitFile.getKitAndPadsFromFile(drive, 'KITS/TEST.KIT')

    expect(result.pads[Object.keys(result.pads)[0]].fileName).toBe('MISSING.wav')
  })
})
