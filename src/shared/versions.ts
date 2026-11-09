import type { Ecosystem } from './deps'

export type UpdateKind = 'patch' | 'minor' | 'major'

/** How one ecosystem reads, orders and splits its version strings. */
interface Scheme {
  /** Null when either text is not a version of this ecosystem. */
  compare(a: string, b: string): number | null
  prerelease(version: string): boolean | null
  /** The numeric release components, such as `[1n, 2n, 3n]` for 1.2.3. */
  release(version: string): bigint[] | null
}

function scheme<T>(
  parse: (version: string) => T | null,
  compare: (a: T, b: T) => number,
  prerelease: (version: T) => boolean,
  release: (version: T) => bigint[]
): Scheme {
  return {
    compare(a, b) {
      const left = parse(a)
      const right = parse(b)
      return left && right ? compare(left, right) : null
    },
    prerelease(version) {
      const parsed = parse(version)
      return parsed ? prerelease(parsed) : null
    },
    release(version) {
      const parsed = parse(version)
      return parsed ? release(parsed) : null
    }
  }
}

function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Element by element; when one list is a prefix of the other, the shorter one is lower. */
function compareLists<T>(a: T[], b: T[], compare: (left: T, right: T) => number): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const result = compare(a[index], b[index])
    if (result) return result
  }
  return a.length - b.length
}

function dropTrailingZeros(numbers: bigint[]): bigint[] {
  let end = numbers.length
  while (end > 0 && numbers[end - 1] === 0n) end--
  return numbers.slice(0, end)
}

// SemVer 2, used by npm, crates.io and Go.

interface SemVer {
  release: bigint[]
  prerelease: string[]
}

// Missing minor and patch numbers are read as zero, because Go writes `v1` for v1.0.0 and OSV writes
// `0` for "every version". Build metadata, including Go's `+incompatible`, never affects order.
const semverPattern = /^v?(\d+)(?:\.(\d+)(?:\.(\d+))?)?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseSemVer(version: string): SemVer | null {
  const match = semverPattern.exec(version.trim())
  if (!match) return null
  const [, major, minor, patch, prerelease] = match
  if (prerelease && (!minor || !patch)) return null
  return {
    release: [BigInt(major), BigInt(minor ?? 0), BigInt(patch ?? 0)],
    prerelease: prerelease ? prerelease.split('.') : []
  }
}

function compareSemVerIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return compareBig(BigInt(a), BigInt(b))
  if (aNumeric) return -1
  if (bNumeric) return 1
  return compareText(a, b)
}

// A Go pseudo-version such as v0.0.0-20210101000000-abcdef123456 is a pre-release whose identifier
// starts with a timestamp, so plain SemVer order already puts it below the next release and orders
// pseudo-versions by time.
function compareSemVer(a: SemVer, b: SemVer): number {
  const release = compareLists(a.release, b.release, compareBig)
  if (release) return release
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length
  return compareLists(a.prerelease, b.prerelease, compareSemVerIdentifiers)
}

const semver = scheme(parseSemVer, compareSemVer, (version) => version.prerelease.length > 0, (version) => version.release)

// PEP 440, used by PyPI.

interface Pep440 {
  epoch: bigint
  release: bigint[]
  /** Rank 0, 1 and 2 for a, b and rc, with the number after it. */
  pre: [bigint, bigint] | null
  post: bigint | null
  dev: bigint | null
  local: string[] | null
}

// The pattern from the `packaging` library, which pip uses. Spelling variants such as `alpha`,
// `-pre.1`, `_rev2` or `1.0-1` are all accepted and normalized below.
const pep440Pattern = new RegExp(
  '^v?(?:(\\d+)!)?(\\d+(?:\\.\\d+)*)' +
  '(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\\d+)?)?' +
  '(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?' +
  '(?:[-_.]?(dev)[-_.]?(\\d+)?)?' +
  '(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$'
)

const pep440PreRank: Record<string, bigint> = { a: 0n, alpha: 0n, b: 1n, beta: 1n, c: 2n, rc: 2n, pre: 2n, preview: 2n }

function parsePep440(version: string): Pep440 | null {
  const match = pep440Pattern.exec(version.trim().toLowerCase())
  if (!match) return null
  const [, epoch, release, preLabel, preNumber, postImplicit, postLabel, postNumber, devLabel, devNumber, local] = match
  return {
    epoch: BigInt(epoch ?? 0),
    release: release.split('.').map(BigInt),
    pre: preLabel ? [pep440PreRank[preLabel], BigInt(preNumber ?? 0)] : null,
    post: postImplicit !== undefined ? BigInt(postImplicit) : postLabel ? BigInt(postNumber ?? 0) : null,
    dev: devLabel ? BigInt(devNumber ?? 0) : null,
    local: local ? local.split(/[-_.]/) : null
  }
}

/**
 * The sort key of `packaging.version.Version`. A bare dev release such as 1.0.dev1 sorts before every
 * pre-release of 1.0, a release without a pre-release after all of them, and a dev release before the
 * release or post-release it leads to.
 */
function pep440Key(version: Pep440): bigint[][] {
  const pre = version.pre ?? (version.post === null && version.dev !== null ? [-1n, 0n] : [3n, 0n])
  return [
    [version.epoch],
    dropTrailingZeros(version.release),
    pre,
    [version.post ?? -1n],
    version.dev === null ? [1n, 0n] : [0n, version.dev]
  ]
}

// A numeric local segment sorts above any text one, and a version with a local part above the same
// version without one.
function comparePep440Local(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return compareBig(BigInt(a), BigInt(b))
  if (aNumeric) return 1
  if (bNumeric) return -1
  return compareText(a, b)
}

function comparePep440(a: Pep440, b: Pep440): number {
  const key = compareLists(pep440Key(a), pep440Key(b), (left, right) => compareLists(left, right, compareBig))
  if (key) return key
  if (!a.local || !b.local) return (a.local ? 1 : 0) - (b.local ? 1 : 0)
  return compareLists(a.local, b.local, comparePep440Local)
}

const pep440 = scheme(
  parsePep440,
  comparePep440,
  (version) => version.pre !== null || version.dev !== null,
  (version) => version.release
)

// Gem::Version, used by RubyGems.

interface GemVersion {
  /** Numbers and letter runs in order, such as `[1n, 0n, 'rc', 1n]` for 1.0.rc1. */
  segments: (bigint | string)[]
  prerelease: boolean
}

const gemPattern = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseGem(version: string): GemVersion | null {
  const trimmed = version.trim()
  if (!gemPattern.test(trimmed)) return null
  // RubyGems reads a hyphen as the start of a pre-release, so 1.0-1 is 1.0.pre.1.
  const text = trimmed.replaceAll('-', '.pre.')
  return {
    segments: (text.match(/[0-9]+|[a-z]+/gi) ?? []).map((segment) => /^\d/.test(segment) ? BigInt(segment) : segment),
    prerelease: /[a-zA-Z]/.test(text)
  }
}

/** Trailing zeros are dropped separately from the release part and from the pre-release part. */
function canonicalGemSegments(version: GemVersion): (bigint | string)[] {
  const firstText = version.segments.findIndex((segment) => typeof segment === 'string')
  const split = firstText === -1 ? version.segments.length : firstText
  const trim = (segments: (bigint | string)[]): (bigint | string)[] => {
    let end = segments.length
    while (end > 0 && segments[end - 1] === 0n) end--
    return segments.slice(0, end)
  }
  return [...trim(version.segments.slice(0, split)), ...trim(version.segments.slice(split))]
}

function compareGem(a: GemVersion, b: GemVersion): number {
  const left = canonicalGemSegments(a)
  const right = canonicalGemSegments(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftSegment = left[index] ?? 0n
    const rightSegment = right[index] ?? 0n
    if (leftSegment === rightSegment) continue
    if (typeof leftSegment === 'string' && typeof rightSegment === 'string') return compareText(leftSegment, rightSegment)
    if (typeof leftSegment === 'bigint' && typeof rightSegment === 'bigint') return compareBig(leftSegment, rightSegment)
    // A letter makes a pre-release, so text sorts below a number in the same place.
    return typeof leftSegment === 'string' ? -1 : 1
  }
  return 0
}

const gem = scheme(
  parseGem,
  compareGem,
  (version) => version.prerelease,
  (version) => {
    const firstText = version.segments.findIndex((segment) => typeof segment === 'string')
    return version.segments.slice(0, firstText === -1 ? undefined : firstText).filter((segment) => typeof segment === 'bigint')
  }
)

// Composer, used by Packagist.

interface ComposerVersion {
  /** As Composer's `VersionParser::normalize` writes it, such as `1.2.0.0-beta2`. */
  normalized: string
  release: bigint[]
  stable: boolean
}

const composerPattern = /^v?(\d{1,5})(\.\d+)?(\.\d+)?(\.\d+)?[._-]?(?:(stable|beta|b|RC|alpha|a|patch|pl|p)((?:[.-]?\d+)*)?)?([.-]?dev)?$/i
const composerBranchPattern = /^v?(\d+)(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?$/
const composerStability: Record<string, string> = { a: 'alpha', b: 'beta', p: 'patch', pl: 'patch', rc: 'RC' }

/** Branches such as `dev-main` have no order and are left to the text comparison. */
function parseComposer(version: string): ComposerVersion | null {
  const text = version.trim().replace(/\+\S+$/, '')
  const match = composerPattern.exec(text)
  if (match) {
    const [, major, minor, patch, fourth, stabilityLabel, stabilityNumber, dev] = match
    const release = [major, minor, patch, fourth].map((part) => BigInt(part ? part.replace('.', '') : 0))
    let normalized = release.join('.')
    const lowered = stabilityLabel?.toLowerCase()
    // Composer drops a `-dev` suffix after an explicit `stable`.
    if (lowered === 'stable') return { normalized, release, stable: true }
    const stability = lowered ? composerStability[lowered] ?? lowered : null
    if (stability) normalized += `-${stability}${(stabilityNumber ?? '').replace(/^[.-]+/, '')}`
    if (dev) normalized += '-dev'
    return { normalized, release, stable: !dev && (!stability || stability === 'patch') }
  }
  // A branch alias such as 2.1.x-dev, which Composer reads as the highest 2.1 version in development.
  const branch = /^(.*?)[.-]?dev$/i.exec(text)
  const parts = branch && composerBranchPattern.exec(branch[1])
  if (!parts) return null
  const release = parts.slice(1, 5).map((part) => {
    const digits = part?.replace('.', '')
    return digits && /^\d+$/.test(digits) ? BigInt(digits) : 9999999n
  })
  return { normalized: `${release.join('.')}-dev`, release, stable: false }
}

// PHP's version_compare, which Composer uses on normalized versions.
const phpSpecialForms: [string, number][] = [['dev', 0], ['alpha', 1], ['a', 1], ['beta', 2], ['b', 2], ['RC', 3], ['rc', 3], ['#', 4], ['pl', 5], ['p', 5]]

function phpSpecialRank(form: string): number {
  return phpSpecialForms.find(([name]) => form.startsWith(name))?.[1] ?? -6
}

function phpVersionParts(version: string): string[] {
  return version.replace(/(\d)(?=[^\d.])|([^\d.])(?=\d)/g, '$1$2.').split(/[^0-9A-Za-z]+/).filter(Boolean)
}

function phpVersionCompare(a: string, b: string): number {
  const left = phpVersionParts(a)
  const right = phpVersionParts(b)
  const isNumber = (part: string): boolean => /^\d/.test(part)
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const leftPart = left[index]
    const rightPart = right[index]
    const result = isNumber(leftPart) && isNumber(rightPart)
      ? compareBig(BigInt(leftPart), BigInt(rightPart))
      : Math.sign(phpSpecialRank(isNumber(leftPart) ? '#' : leftPart) - phpSpecialRank(isNumber(rightPart) ? '#' : rightPart))
    if (result) return result
  }
  // An extra number makes a version higher; an extra word ranks against a number, so -beta lowers
  // it and -patch raises it.
  if (left.length > right.length) return isNumber(left[right.length]) ? 1 : Math.sign(phpSpecialRank(left[right.length]) - 4)
  if (right.length > left.length) return isNumber(right[left.length]) ? -1 : Math.sign(4 - phpSpecialRank(right[left.length]))
  return 0
}

const composer = scheme(
  parseComposer,
  (a, b) => phpVersionCompare(a.normalized, b.normalized),
  (version) => !version.stable,
  (version) => version.release
)

const schemes: Record<Ecosystem, Scheme> = {
  npm: semver,
  'crates.io': semver,
  Go: semver,
  PyPI: pep440,
  RubyGems: gem,
  Packagist: composer
}

/** Compares runs of digits as numbers and everything else as text, for versions no scheme accepts. */
function compareLoosely(a: string, b: string): number {
  const left = a.trim().match(/\d+|\D+/g) ?? []
  const right = b.trim().match(/\d+|\D+/g) ?? []
  const result = compareLists(left, right, (leftPart, rightPart) =>
    /^\d/.test(leftPart) && /^\d/.test(rightPart) ? compareBig(BigInt(leftPart), BigInt(rightPart)) : compareText(leftPart, rightPart))
  return result || compareText(a, b)
}

/** Negative when `a` is older than `b`, positive when newer, by the ecosystem's own rules. Never throws. */
export function compareVersions(ecosystem: Ecosystem, a: string, b: string): number {
  return schemes[ecosystem].compare(a, b) ?? compareLoosely(a, b)
}

export function isPrerelease(ecosystem: Ecosystem, version: string): boolean {
  return schemes[ecosystem].prerelease(version) ?? false
}

/**
 * How big a jump between two versions is under caret rules. It is major when the first non-zero
 * component changes, so 0.3 to 0.4 and 0.0.3 to 0.0.4 count as breaking just as 1.x to 2.x does.
 */
export function updateKind(ecosystem: Ecosystem, from: string, to: string): UpdateKind {
  if (ecosystem === 'PyPI') {
    const left = parsePep440(from)
    const right = parsePep440(to)
    if (left && right && left.epoch !== right.epoch) return 'major'
  }
  const leading = (version: string): bigint[] | null => {
    const digits = /^\D*?(\d+(?:\.\d+)*)/.exec(version.trim())
    return digits ? digits[1].split('.').map(BigInt) : null
  }
  const left = schemes[ecosystem].release(from) ?? leading(from)
  const right = schemes[ecosystem].release(to) ?? leading(to)
  if (!left || !right) return 'major'
  const component = (release: bigint[], index: number): bigint => release[index] ?? 0n
  // Components past the third count as patches, as they do in a four-part Composer version.
  const nonZero = left.findIndex((part) => part !== 0n)
  const firstNonZero = nonZero === -1 ? 2 : Math.min(nonZero, 2)
  for (let index = 0; index <= firstNonZero; index++) {
    if (component(left, index) !== component(right, index)) return 'major'
  }
  return component(left, 1) !== component(right, 1) ? 'minor' : 'patch'
}
