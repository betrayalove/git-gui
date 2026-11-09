import { describe, expect, it } from 'vitest'
import { cvssScore, severityOfScore } from '../src/shared/cvss'

describe('CVSS 3.x base scores', () => {
  // Vectors and scores as GitHub's advisory database publishes them.
  it.each([
    ['GHSA-p6mc-m468-83gw', 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H', 7.4],
    ['GHSA-jfh8-c2jp-5v3q', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H/E:H', 10],
    ['GHSA-35jh-r3h4-6jhm', 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H', 7.2],
    ['GHSA-jf85-cpcp-j695', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H', 9.1],
    ['GHSA-fvqr-27wr-82fm', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N', 6.5],
    ['GHSA-w8r8-w5w4-4w4v', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 7.5],
    ['GHSA-952p-6rrq-rcjv', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L', 5.3],
    ['GHSA-mc8m-rr6c-r5qr', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N', 4.3],
    ['GHSA-47w9-6r3f-938g', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
    ['GHSA-7mr3-28h5-m5vx', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N', 7.7],
    ['GHSA-3gq2-x4qg-p4g6', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:N/A:N', 5],
    ['GHSA-5q7h-w9jf-cx97', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N', 9.3],
    ['GHSA-hhf9-qw4v-72xp', 'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N', 8.4],
    ['GHSA-3cgg-c5pp-57h6', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
    ['GHSA-j77q-2qqg-6989', 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H/E:H', 10],
    ['GHSA-7xfp-9c55-5vqj', 'CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N', 5.9]
  ])('scores %s as published', (_advisory, vector, score) => {
    expect(cvssScore(vector)).toBe(score)
  })

  it('scores a vector without impact as zero', () => {
    expect(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:N')).toBe(0)
  })

  it('ignores temporal and environmental metrics', () => {
    expect(cvssScore('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N/E:U/RL:O/RC:R/CR:L/MAV:P/MS:C')).toBe(6.5)
  })

  it('accepts base metrics in any order', () => {
    expect(cvssScore('CVSS:3.1/A:H/I:H/C:N/S:U/UI:N/PR:N/AC:H/AV:N')).toBe(7.4)
  })
})

describe('CVSS 4.0 scores', () => {
  // Vectors and scores as GitHub's advisory database publishes them.
  it.each([
    ['GHSA-5xjx-3w67-w9x9', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N', 9.3],
    ['GHSA-5w5g-j6hw-6p8f', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:H/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 8.6],
    ['GHSA-vp5q-ff62-jwqv', 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:N/VI:H/VA:N/SC:H/SI:H/SA:N', 8.3],
    ['GHSA-mrwp-f3q8-3g9p', 'CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', 8.2],
    ['GHSA-f9j6-8p6x-r9j6', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N', 7.1],
    ['GHSA-42gh-23hr-vphw', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N', 7.1],
    ['GHSA-g3hv-75wg-m249', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N', 6.9],
    ['GHSA-3g3m-2fjr-6pw4', 'CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N', 6.3],
    ['GHSA-9vw2-f4vp-x7gf', 'CVSS:4.0/AV:L/AC:L/AT:P/PR:L/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 5.4],
    ['GHSA-mc8m-rr6c-r5qr', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N', 5.3],
    ['GHSA-9gh4-xw24-9xh5', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N', 5.3],
    ['GHSA-662x-8wvj-2276', 'CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N', 2.3]
  ])('scores %s as published', (_advisory, vector, score) => {
    expect(cvssScore(vector)).toBe(score)
  })

  // From the test data of Red Hat's `cvss` library, which matches the reference calculator.
  it.each([
    ['CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:A', 7.3],
    ['CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:P', 5.9],
    ['CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:U', 4.1],
    ['CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/CR:H/IR:H/AR:M', 7.2],
    ['CVSS:4.0/AV:N/AC:H/AT:P/PR:H/UI:N/VC:H/VI:N/VA:H/SC:N/SI:H/SA:N/E:A/CR:H/IR:H/AR:L/MAV:L/MAC:H/MAT:P/MPR:L/MUI:A/MVC:N/MVI:H/MVA:N/MSC:H/MSI:N/MSA:N/S:P/AU:Y/R:A/V:D/RE:M/U:Green', 5.5],
    ['CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:L/SA:L/E:U/CR:L/IR:L/AR:M/MAV:L/MAC:H/MAT:P/MPR:N/MUI:A/MVC:H/MVI:H/MVA:N/MSC:N/MSI:S/MSA:N/S:P/AU:Y/R:I/V:D/RE:H/U:Amber', 5.8],
    ['CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N/E:A', 0]
  ])('scores %s', (vector, score) => {
    expect(cvssScore(vector)).toBe(score)
  })

  it('rounds half up despite floating point error', () => {
    // The unrounded score comes out as 8.549999999999999.
    expect(cvssScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:L/VA:N/SC:H/SI:H/SA:H')).toBe(8.6)
  })
})

describe('invalid vectors', () => {
  it.each([
    ['CVSS 2', 'AV:N/AC:L/Au:N/C:P/I:P/A:P'],
    ['CVSS 2 with a prefix', 'CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P'],
    ['an unknown version', 'CVSS:3.2/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['empty text', ''],
    ['a missing 3.x base metric', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H'],
    ['a repeated 3.x metric', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/A:L'],
    ['an unknown 3.x value', 'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['an unknown 3.x metric', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZ:H'],
    ['a trailing slash', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/'],
    ['a missing 4.0 base metric', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N'],
    ['4.0 metrics out of order', 'CVSS:4.0/AC:L/AV:N/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'],
    ['a repeated 4.0 metric', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:A/E:A'],
    ['an unknown 4.0 value', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:S']
  ])('returns null for %s', (_case, vector) => {
    expect(cvssScore(vector)).toBeNull()
  })
})

describe('severity of a score', () => {
  it.each([
    [0, 'low'],
    [3.9, 'low'],
    [4, 'moderate'],
    [6.9, 'moderate'],
    [7, 'high'],
    [8.9, 'high'],
    [9, 'critical'],
    [10, 'critical']
  ] as const)('rates %s as %s', (score, severity) => {
    expect(severityOfScore(score)).toBe(severity)
  })
})
