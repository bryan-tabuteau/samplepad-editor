/* App imports */
import { Actions, Drive } from 'const'
import { showNotice } from 'actions/notice'
import { Sample } from 'state/models'
import { openSampleFileDialog } from 'util/fileDialog'
import { copySample } from 'util/storage'

/* Electron imports */
const { store, fs, path } = window.api

/**
 * responsible for managing sample file and display names
 *
 *  if a display name would be overwritten, its ok to overwrite its equivalent filename
 *    : kick.wav (stored as kick1.wav), when uploading another kick.wav should overwrite
 *
 *  but dont overwrite files that have been truncated
 *    : TR-909-KICK.wav (stored as TR-909-1.wav), when uploading a file called TR-909-1.wav
 *      it'd have to get renamed to not overwrite on disk
 *
 *  display names always include the extension, and are matched case insensitively
 */
class SampleStore {

  constructor(settings) {
    /** @var deviceId => path */
    this.devicePaths = store.get('devicePaths') || {}

    /** @var deviceId => {fileName => fileNameOnDisk} */
    this.samples = store.get('samples') || {}

    /** @var all the samples on the current device {fileName => fileNameOnDisk} */
    this.deviceSamples = {}

    this._loadFilenames()
  }

  getSamples() {
    return this.deviceSamples
  }

  /**
   * @return {String[]} the display names of all samples on the current device, sorted
   */
  getSampleNames() {
    return Object.keys(this.deviceSamples)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  }

  hasSample(fileName) {
    return !!this._findKey(fileName)
  }

  getFileNameOnDisk(fileName) {
    return this.devicePath + "/" + this.deviceSamples[this._findKey(fileName)]
  }

  /**
   * Get the string to write to a kit file for the given file
   * A sample that isn't on the card is written as-is, so a kit never loses its reference to it
   * @param {String} fileName
   * @return {String}
   */
  getWriteFileName(fileName) {
    if (!fileName) {
      return ""
    }

    let key = this._findKey(fileName)
    let fileNameOnDisk = key ? this.deviceSamples[key] : fileName

    return this._dropExtension(fileNameOnDisk).substr(0, Drive.MAX_FILENAME_LENGTH)
  }

  getFileNameFromKitFile(fileName) {
    if (!fileName) {
      return ""
    }

    let reverseList = this._getFlippedDeviceSamples()

    return reverseList[fileName.toLowerCase()] || fileName
  }

  /**
   * Open a file dialog, and move the selected files into the drive
   */
  importSamples() {
    return (dispatch, getState) => {
      openSampleFileDialog()
        .then(result => {
          if (result.canceled) {
            return null
          }

          dispatch(showNotice("is-warning", "Import processing..."))

          let state = getState()
          let fileCount = state.drive.samples.length

          // run the import on a timeout to let the notice above show
          setTimeout(() => {
            let importResult

            try {
              importResult = this.importFiles(result.filePaths, fileCount)
            } catch (err) {
              console.error(err)
              dispatch(showNotice("is-danger", "There was a problem importing samples."))
              return
            }

            dispatch({ type: Actions.RESET_SAMPLES, samples: this.getSampleNames() })

            let summary = this.getImportSummary(importResult)
            dispatch(showNotice(summary.style, summary.text))
          }, 100)
        })
    }
  }

  /**
   * Copy the given files (and the contents of any directories, recursively) into the drive
   * @param {String[]} filePaths
   * @param {Number} currentCount - the number of samples already on the drive
   * @return {{imported: Number, failed: String[], ignored: String[], limited: String[]}}
   *   failed:  samples that could not be read or written
   *   ignored: files that are not wav files
   *   limited: samples skipped because the drive is full
   */
  importFiles(filePaths, currentCount) {
    let result = { imported: 0, failed: [], ignored: [], limited: [] }
    let fileCount = currentCount

    let parseDirectory = (fileList) => {
      fileList.forEach((file) => {
        if (fs.isDirectory(file)) {
          // read directories recursively
          parseDirectory(fs.getFileListFromDirectory(file))
          return
        }

        let samplePath = path.parse(file)

        if (samplePath.ext.toLowerCase() !== Drive.SAMPLE_EXTENSION) {
          result.ignored.push(samplePath.base)
          return
        }

        // overwriting a sample with the same display name doesn't use up another slot
        let previousKey = this._findKey(samplePath.base)
        let previous = previousKey ? { key: previousKey, fileNameOnDisk: this.deviceSamples[previousKey] } : null

        if (!previous && fileCount >= Drive.MAX_SAMPLES) {
          result.limited.push(samplePath.base)
          return
        }

        try {
          let sample = this.addSample(samplePath.base, false)

          try {
            copySample(file, this.devicePath, sample.fileNameOnDisk)
          } catch (err) {
            this._undoAddSample(sample.fileName, previous)
            throw err
          }

          result.imported++
          if (!previous) {
            fileCount++
          }
        } catch (err) {
          result.failed.push(samplePath.base)
        }
      })
    }

    try {
      parseDirectory(filePaths)
    } finally {
      this._saveSamples()
    }

    return result
  }

  /**
   * Describe the outcome of an import to the user
   * @param {Object} result - from importFiles
   * @return {{style: String, text: String}}
   */
  getImportSummary(result) {
    let parts = []

    if (result.imported) {
      parts.push(result.imported + (result.imported === 1 ? " sample" : " samples") + " imported.")
    } else {
      parts.push("No samples were imported.")
    }
    if (result.failed.length) {
      parts.push(result.failed.length + " could not be imported (" + this._listNames(result.failed) + ").")
    }
    if (result.limited.length) {
      parts.push(result.limited.length + " skipped, the card is limited to " + Drive.MAX_SAMPLES + " samples.")
    }
    if (result.ignored.length) {
      parts.push(result.ignored.length + " non-wav " + (result.ignored.length === 1 ? "file" : "files") + " ignored.")
    }

    let hasProblem = result.failed.length || result.limited.length || !result.imported

    return {
      style: hasProblem ? "is-warning" : "is-success",
      text: parts.join(" ")
    }
  }

  /**
   * Load the sample list for a card. The list of samples is always checked against what
   * is actually on the card, since files can be added or removed outside of this app
   * @param {String} deviceId
   * @param {String} devicePath - where the card is mounted right now
   * @return {{added: String[], removed: String[]}} what changed since the card was last seen
   */
  loadSamplesFromDirectory(deviceId, devicePath) {
    this.deviceId = deviceId
    this.devicePath = devicePath

    let filesOnDisk = fs.getSampleFiles(devicePath).map((dirent) => dirent.name)
    let filesOnDiskByLowerCase = Object.fromEntries(filesOnDisk.map((name) => [name.toLowerCase(), name]))

    let samples = {}
    let claimed = {}
    let added = []
    let removed = []

    Object.entries(this.samples[deviceId] || {}).forEach(([displayName, fileNameOnDisk]) => {
      // older versions stored display names without an extension
      let fileName = this._hasExtension(displayName) ? displayName : displayName + Drive.SAMPLE_EXTENSION
      let actualFileName = filesOnDiskByLowerCase[fileNameOnDisk.toLowerCase()]

      if (!actualFileName || claimed[actualFileName]) {
        removed.push(displayName)
        return
      }

      claimed[actualFileName] = true
      samples[fileName] = actualFileName
    })

    filesOnDisk.forEach((fileName) => {
      if (!claimed[fileName]) {
        samples[fileName] = fileName
        added.push(fileName)
      }
    })

    this.deviceSamples = samples

    this
      ._saveSamples()
      ._saveDevicePath(devicePath)

    return { added, removed }
  }

  /**
   * Add a new file to the current device
   * @param {String} fileName - the display name, including extension
   */
  addSample(fileName, save=true) {
    let fileNameOnDisk

    let existingKey = this._findKey(fileName)
    if (existingKey) {
      // overwriting a sample - reuse its file on disk, so no orphaned copies are left behind
      fileNameOnDisk = this.deviceSamples[existingKey]
      delete this.deviceSamples[existingKey]
    } else {
      fileNameOnDisk = this._getFormattedFileName(fileName)
    }

    this.deviceSamples[fileName] = fileNameOnDisk
    this._loadFilenames()

    if (save) {
      this._saveSamples()
    }

    return Sample(fileName, fileNameOnDisk)
  }

  /**
   * Revert addSample, e.g. because the file could not be written
   * @param {String} fileName
   * @param {?{key: String, fileNameOnDisk: String}} previous - what addSample replaced, if anything
   */
  _undoAddSample(fileName, previous) {
    delete this.deviceSamples[fileName]

    if (previous) {
      this.deviceSamples[previous.key] = previous.fileNameOnDisk
    }

    this._loadFilenames()
  }

  _getFlippedDeviceSamples() {
    let ret = {}
    Object.keys(this.deviceSamples).forEach(key => {
      ret[this.deviceSamples[key].toLowerCase()] = key
    })
    return ret
  }

  _saveSamples() {
    this.samples[this.deviceId] = this.deviceSamples
    store.save('samples', this.samples)
    this._loadFilenames()

    return this
  }

  _saveDevicePath(devicePath) {
    this.devicePaths[this.deviceId] = devicePath
    store.save('devicePaths', this.devicePaths)

    return this
  }

  _reset() {
    store.save('devicePaths', {})
    store.save('samples', {})
  }

  _loadFilenames() {
    /** the file names as stored on disk - this is used for r/w only, not file uniqueness */
    this.fileNamesOnDisk = Object.fromEntries(
      Object.entries(this.deviceSamples).map(([fileName, fileNameOnDisk]) => [fileNameOnDisk.toLowerCase(), true])
    )

    /** lowercase file name => the file name displayed to the user - this is used for uniqueness and lookups */
    this.fileNames = Object.fromEntries(
      Object.keys(this.deviceSamples).map((fileName) => [fileName.toLowerCase(), fileName])
    )
  }

  /**
   * @param {String} fileName
   * @return {String|undefined} the display name the sample is stored under, matched case insensitively
   */
  _findKey(fileName) {
    return fileName ? this.fileNames[fileName.toLowerCase()] : undefined
  }

  _fileExistsOnDisk(fileName) {
    return this.fileNamesOnDisk[(fileName).toLowerCase()] || false
  }

  _hasExtension(fileName) {
    return fileName.toLowerCase().endsWith(Drive.SAMPLE_EXTENSION)
  }

  _dropExtension(fileName) {
    return this._hasExtension(fileName)
      ? fileName.substr(0, fileName.length - Drive.SAMPLE_EXTENSION.length)
      : fileName
  }

  _listNames(names) {
    let shown = names.slice(0, 3).join(", ")

    return names.length > 3 ? shown + ", ..." : shown
  }

  _getFormattedFileName(displayName) {
    // drop the extension
    let fileName = this._dropExtension(displayName)

    // remove any non-alphanumeric characters
    fileName = fileName.replace(/[^0-9a-z]/gi, '')

    // a name made of nothing but symbols still needs something to go on
    if (!fileName) {
      fileName = "sample"
    }

    // ideally, use the actual name or some portion of it, truncate it to a max length
    fileName = fileName.substr(0, Drive.MAX_FILENAME_LENGTH)
    if (!this._fileExistsOnDisk(fileName + Drive.SAMPLE_EXTENSION)) {
      return fileName + Drive.SAMPLE_EXTENSION
    }

    // the best filename is already taken
    // start counting up from 0 and replacing characters at the end of the string
    // e.g. bassdrum.wav->bassdru1.wav...bassdr99.wav or kick.wav -> kick1.wav...kick3456.wav
    let count = 0
    let insertPos = fileName.length

    while (true) {
      count = count + 1
      let fileCount = '' + count

      while (insertPos > 0 && insertPos + fileCount.length > Drive.MAX_FILENAME_LENGTH) {
        insertPos--
      }

      if (insertPos === 0) {
        //shit, thats a lot of files with the same name, like d9999999.wav and they want to add more?
        throw new Error("Cannot import sample file")
      }

      let testFileName = fileName.substr(0, insertPos) + fileCount
      if (!this._fileExistsOnDisk(testFileName + Drive.SAMPLE_EXTENSION)) {
        return testFileName + Drive.SAMPLE_EXTENSION
      }
    }
  }
}

export default new SampleStore()
