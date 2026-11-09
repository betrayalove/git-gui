import type { Severity } from './deps'

export function severityOfScore(score: number): Severity {
  if (score < 4) return 'low'
  if (score < 7) return 'moderate'
  if (score < 9) return 'high'
  return 'critical'
}

/**
 * The score of a CVSS 3.0, 3.1 or 4.0 vector, or null for version 2 and for anything that is not a
 * valid vector. For 3.x it is the base score; temporal and environmental metrics are checked but
 * ignored. For 4.0 the threat and environmental metrics take part when present, because 4.0 has a
 * single formula and that is the score advisories publish for such a vector.
 */
export function cvssScore(vector: string): number | null {
  const [prefix, ...parts] = vector.trim().split('/')
  if (prefix === 'CVSS:3.0' || prefix === 'CVSS:3.1') return cvss3Score(parts)
  if (prefix === 'CVSS:4.0') return cvss4Score(parts)
  return null
}

// CVSS 3.1 specification, section 7. Version 3.0 uses the same formulas; 3.1 only made Roundup exact.

const cvss3Base: Record<string, string[]> = {
  AV: ['N', 'A', 'L', 'P'],
  AC: ['L', 'H'],
  PR: ['N', 'L', 'H'],
  UI: ['N', 'R'],
  S: ['U', 'C'],
  C: ['H', 'L', 'N'],
  I: ['H', 'L', 'N'],
  A: ['H', 'L', 'N']
}

const cvss3Optional: Record<string, string[]> = {
  E: ['X', 'U', 'P', 'F', 'H'],
  RL: ['X', 'O', 'T', 'W', 'U'],
  RC: ['X', 'U', 'R', 'C'],
  CR: ['X', 'L', 'M', 'H'],
  IR: ['X', 'L', 'M', 'H'],
  AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'],
  MAC: ['X', 'L', 'H'],
  MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'R'],
  MS: ['X', 'U', 'C'],
  MC: ['X', 'N', 'L', 'H'],
  MI: ['X', 'N', 'L', 'H'],
  MA: ['X', 'N', 'L', 'H']
}

const cvss3Weights: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 }
}

/** Roundup from Appendix A of the 3.1 specification, which avoids floating point errors. */
function roundUp(value: number): number {
  const integer = Math.round(value * 100000)
  return integer % 10000 === 0 ? integer / 100000 : (Math.floor(integer / 10000) + 1) / 10
}

function cvss3Score(parts: string[]): number | null {
  const metrics = new Map<string, string>()
  for (const part of parts) {
    const [key, value, extra] = part.split(':')
    const allowed = cvss3Base[key] ?? cvss3Optional[key]
    if (extra !== undefined || !allowed?.includes(value) || metrics.has(key)) return null
    metrics.set(key, value)
  }
  if (Object.keys(cvss3Base).some((key) => !metrics.has(key))) return null
  const metric = (key: string): string => metrics.get(key)!

  const changed = metric('S') === 'C'
  const privileges = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[metric('PR')]!
  const impactSubScore = 1 - (1 - cvss3Weights.CIA[metric('C')]) * (1 - cvss3Weights.CIA[metric('I')]) * (1 - cvss3Weights.CIA[metric('A')])
  const impact = changed ? 7.52 * (impactSubScore - 0.029) - 3.25 * Math.pow(impactSubScore - 0.02, 15) : 6.42 * impactSubScore
  const exploitability = 8.22 * cvss3Weights.AV[metric('AV')] * cvss3Weights.AC[metric('AC')] * privileges * cvss3Weights.UI[metric('UI')]
  if (impact <= 0) return 0
  return changed ? roundUp(Math.min(1.08 * (impact + exploitability), 10)) : roundUp(Math.min(impact + exploitability, 10))
}

// CVSS 4.0 follows the reference calculator by FIRST and Red Hat (github.com/RedHatProductSecurity/
// cvss-v4-calculator, cvss40.js), step for step, so floating point results match it exactly.

/** Every metric in the order a vector must list them, with its allowed values. The first 11 are required. */
const cvss4Metrics: [string, string[]][] = [
  ['AV', ['N', 'A', 'L', 'P']],
  ['AC', ['L', 'H']],
  ['AT', ['N', 'P']],
  ['PR', ['N', 'L', 'H']],
  ['UI', ['N', 'P', 'A']],
  ['VC', ['N', 'L', 'H']],
  ['VI', ['N', 'L', 'H']],
  ['VA', ['N', 'L', 'H']],
  ['SC', ['N', 'L', 'H']],
  ['SI', ['N', 'L', 'H']],
  ['SA', ['N', 'L', 'H']],
  ['E', ['X', 'A', 'P', 'U']],
  ['CR', ['X', 'H', 'M', 'L']],
  ['IR', ['X', 'H', 'M', 'L']],
  ['AR', ['X', 'H', 'M', 'L']],
  ['MAV', ['X', 'N', 'A', 'L', 'P']],
  ['MAC', ['X', 'L', 'H']],
  ['MAT', ['X', 'N', 'P']],
  ['MPR', ['X', 'N', 'L', 'H']],
  ['MUI', ['X', 'N', 'P', 'A']],
  ['MVC', ['X', 'H', 'L', 'N']],
  ['MVI', ['X', 'H', 'L', 'N']],
  ['MVA', ['X', 'H', 'L', 'N']],
  ['MSC', ['X', 'H', 'L', 'N']],
  ['MSI', ['X', 'S', 'H', 'L', 'N']],
  ['MSA', ['X', 'S', 'H', 'L', 'N']],
  ['S', ['X', 'N', 'P']],
  ['AU', ['X', 'N', 'Y']],
  ['R', ['X', 'A', 'U', 'I']],
  ['V', ['X', 'D', 'C']],
  ['RE', ['X', 'L', 'M', 'H']],
  ['U', ['X', 'Clear', 'Green', 'Amber', 'Red']]
]

const cvss4RequiredCount = 11

/** The score of the highest severity vector in each macro vector, from the specification. */
const macroVectorScores = new Map(`
  000000:10 000001:9.9 000010:9.8 000011:9.5 000020:9.5 000021:9.2 000100:10 000101:9.6 000110:9.3
  000111:8.7 000120:9.1 000121:8.1 000200:9.3 000201:9 000210:8.9 000211:8 000220:8.1 000221:6.8
  001000:9.8 001001:9.5 001010:9.5 001011:9.2 001020:9 001021:8.4 001100:9.3 001101:9.2 001110:8.9
  001111:8.1 001120:8.1 001121:6.5 001200:8.8 001201:8 001210:7.8 001211:7 001220:6.9 001221:4.8
  002001:9.2 002011:8.2 002021:7.2 002101:7.9 002111:6.9 002121:5 002201:6.9 002211:5.5 002221:2.7
  010000:9.9 010001:9.7 010010:9.5 010011:9.2 010020:9.2 010021:8.5 010100:9.5 010101:9.1 010110:9
  010111:8.3 010120:8.4 010121:7.1 010200:9.2 010201:8.1 010210:8.2 010211:7.1 010220:7.2 010221:5.3
  011000:9.5 011001:9.3 011010:9.2 011011:8.5 011020:8.5 011021:7.3 011100:9.2 011101:8.2 011110:8
  011111:7.2 011120:7 011121:5.9 011200:8.4 011201:7 011210:7.1 011211:5.2 011220:5 011221:3
  012001:8.6 012011:7.5 012021:5.2 012101:7.1 012111:5.2 012121:2.9 012201:6.3 012211:2.9 012221:1.7
  100000:9.8 100001:9.5 100010:9.4 100011:8.7 100020:9.1 100021:8.1 100100:9.4 100101:8.9 100110:8.6
  100111:7.4 100120:7.7 100121:6.4 100200:8.7 100201:7.5 100210:7.4 100211:6.3 100220:6.3 100221:4.9
  101000:9.4 101001:8.9 101010:8.8 101011:7.7 101020:7.6 101021:6.7 101100:8.6 101101:7.6 101110:7.4
  101111:5.8 101120:5.9 101121:5 101200:7.2 101201:5.7 101210:5.7 101211:5.2 101220:5.2 101221:2.5
  102001:8.3 102011:7 102021:5.4 102101:6.5 102111:5.8 102121:2.6 102201:5.3 102211:2.1 102221:1.3
  110000:9.5 110001:9 110010:8.8 110011:7.6 110020:7.6 110021:7 110100:9 110101:7.7 110110:7.5
  110111:6.2 110120:6.1 110121:5.3 110200:7.7 110201:6.6 110210:6.8 110211:5.9 110220:5.2 110221:3
  111000:8.9 111001:7.8 111010:7.6 111011:6.7 111020:6.2 111021:5.8 111100:7.4 111101:5.9 111110:5.7
  111111:5.7 111120:4.7 111121:2.3 111200:6.1 111201:5.2 111210:5.7 111211:2.9 111220:2.4 111221:1.6
  112001:7.1 112011:5.9 112021:3 112101:5.8 112111:2.6 112121:1.5 112201:2.3 112211:1.3 112221:0.6
  200000:9.3 200001:8.7 200010:8.6 200011:7.2 200020:7.5 200021:5.8 200100:8.6 200101:7.4 200110:7.4
  200111:6.1 200120:5.6 200121:3.4 200200:7 200201:5.4 200210:5.2 200211:4 200220:4 200221:2.2
  201000:8.5 201001:7.5 201010:7.4 201011:5.5 201020:6.2 201021:5.1 201100:7.2 201101:5.7 201110:5.5
  201111:4.1 201120:4.6 201121:1.9 201200:5.3 201201:3.6 201210:3.4 201211:1.9 201220:1.9 201221:0.8
  202001:6.4 202011:5.1 202021:2 202101:4.7 202111:2.1 202121:1.1 202201:2.4 202211:0.9 202221:0.4
  210000:8.8 210001:7.5 210010:7.3 210011:5.3 210020:6 210021:5 210100:7.3 210101:5.5 210110:5.9
  210111:4 210120:4.1 210121:2 210200:5.4 210201:4.3 210210:4.5 210211:2.2 210220:2 210221:1.1
  211000:7.5 211001:5.5 211010:5.8 211011:4.5 211020:4 211021:2.1 211100:6.1 211101:5.1 211110:4.8
  211111:1.8 211120:2 211121:0.9 211200:4.6 211201:1.8 211210:1.7 211211:0.7 211220:0.8 211221:0.2
  212001:5.3 212011:2.4 212021:1.4 212101:2.4 212111:1.2 212121:0.5 212201:1 212211:0.3 212221:0.1
`.trim().split(/\s+/).map((entry) => {
  const [macroVector, score] = entry.split(':')
  return [macroVector, Number(score)] as const
}))

/** The highest severity vectors of each equivalence class, by class level. */
const maxComposed = {
  eq1: [['AV:N/PR:N/UI:N'], ['AV:A/PR:N/UI:N', 'AV:N/PR:L/UI:N', 'AV:N/PR:N/UI:P'], ['AV:P/PR:N/UI:N', 'AV:A/PR:L/UI:P']],
  eq2: [['AC:L/AT:N'], ['AC:H/AT:N', 'AC:L/AT:P']],
  // Indexed by EQ3 and then by EQ6.
  eq3eq6: [
    [['VC:H/VI:H/VA:H/CR:H/IR:H/AR:H'], ['VC:H/VI:H/VA:L/CR:M/IR:M/AR:H', 'VC:H/VI:H/VA:H/CR:M/IR:M/AR:M']],
    [
      ['VC:L/VI:H/VA:H/CR:H/IR:H/AR:H', 'VC:H/VI:L/VA:H/CR:H/IR:H/AR:H'],
      ['VC:L/VI:H/VA:L/CR:H/IR:M/AR:H', 'VC:L/VI:H/VA:H/CR:H/IR:M/AR:M', 'VC:H/VI:L/VA:H/CR:M/IR:H/AR:M', 'VC:H/VI:L/VA:L/CR:M/IR:H/AR:H', 'VC:L/VI:L/VA:H/CR:H/IR:H/AR:M']
    ],
    [[], ['VC:L/VI:L/VA:L/CR:H/IR:H/AR:H']]
  ],
  eq4: [['SC:H/SI:S/SA:S'], ['SC:H/SI:H/SA:H'], ['SC:L/SI:L/SA:L']],
  eq5: [['E:A'], ['E:P'], ['E:U']]
}

/** The depth of each macro vector, in steps of severity distance, plus one. */
const maxSeverity = {
  eq1: [1, 4, 5],
  eq2: [1, 2],
  // EQ3 level 2 has no high impact, so EQ6 is always 1 there.
  eq3eq6: [[7, 6], [8, 8], [NaN, 10]],
  eq4: [6, 5, 4]
}

const metricLevels: Record<string, Record<string, number>> = {
  AV: { N: 0.0, A: 0.1, L: 0.2, P: 0.3 },
  PR: { N: 0.0, L: 0.1, H: 0.2 },
  UI: { N: 0.0, P: 0.1, A: 0.2 },
  AC: { L: 0.0, H: 0.1 },
  AT: { N: 0.0, P: 0.1 },
  VC: { H: 0.0, L: 0.1, N: 0.2 },
  VI: { H: 0.0, L: 0.1, N: 0.2 },
  VA: { H: 0.0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 },
  SI: { S: 0.0, H: 0.1, L: 0.2, N: 0.3 },
  SA: { S: 0.0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0.0, M: 0.1, L: 0.2 },
  IR: { H: 0.0, M: 0.1, L: 0.2 },
  AR: { H: 0.0, M: 0.1, L: 0.2 },
  E: { U: 0.2, P: 0.1, A: 0 }
}

/** Unset threat and requirement metrics count as the worst case. */
const worstCaseDefaults: Record<string, string> = { E: 'A', CR: 'H', IR: 'H', AR: 'H' }

function parseCvss4(parts: string[]): Map<string, string> | null {
  const metrics = new Map<string, string>()
  let expected = 0
  for (const part of parts) {
    const [key, value, extra] = part.split(':')
    if (extra !== undefined) return null
    while (expected < cvss4Metrics.length && cvss4Metrics[expected][0] !== key) {
      if (expected < cvss4RequiredCount) return null
      expected++
    }
    if (expected === cvss4Metrics.length || !cvss4Metrics[expected][1].includes(value)) return null
    metrics.set(key, value)
    expected++
  }
  return expected < cvss4RequiredCount ? null : metrics
}

function cvss4Score(parts: string[]): number | null {
  const metrics = parseCvss4(parts)
  if (!metrics) return null
  const effective = (metric: string): string => {
    const value = metrics.get(metric) ?? 'X'
    if (value === 'X' && worstCaseDefaults[metric]) return worstCaseDefaults[metric]
    const modified = metrics.get(`M${metric}`)
    return modified && modified !== 'X' ? modified : value
  }

  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every((metric) => effective(metric) === 'N')) return 0

  const [AV, PR, UI, AC, AT, VC, VI, VA, SC, SI, SA, CR, IR, AR, E] =
    ['AV', 'PR', 'UI', 'AC', 'AT', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA', 'CR', 'IR', 'AR', 'E'].map(effective)
  const eq1 = AV === 'N' && PR === 'N' && UI === 'N' ? 0 : (AV === 'N' || PR === 'N' || UI === 'N') && AV !== 'P' ? 1 : 2
  const eq2 = AC === 'L' && AT === 'N' ? 0 : 1
  const eq3 = VC === 'H' && VI === 'H' ? 0 : VC === 'H' || VI === 'H' || VA === 'H' ? 1 : 2
  const eq4 = effective('MSI') === 'S' || effective('MSA') === 'S' ? 0 : SC === 'H' || SI === 'H' || SA === 'H' ? 1 : 2
  const eq5 = E === 'A' ? 0 : E === 'P' ? 1 : 2
  const eq6 = (CR === 'H' && VC === 'H') || (IR === 'H' && VI === 'H') || (AR === 'H' && VA === 'H') ? 0 : 1

  const lookup = (...levels: number[]): number => macroVectorScores.get(levels.join('')) ?? NaN
  const value = lookup(eq1, eq2, eq3, eq4, eq5, eq6)

  // 1a. The maximal scoring difference to the next lower macro vector of each class, NaN when there is none.
  const lowerEq1 = lookup(eq1 + 1, eq2, eq3, eq4, eq5, eq6)
  const lowerEq2 = lookup(eq1, eq2 + 1, eq3, eq4, eq5, eq6)
  // EQ3 and EQ6 move together: 00 can go to 01 or 10, 01 to 11, 10 to 11 and 11 to 21.
  const lowerEq3eq6 = eq3 === 0 && eq6 === 0
    ? Math.max(lookup(eq1, eq2, eq3, eq4, eq5, eq6 + 1), lookup(eq1, eq2, eq3 + 1, eq4, eq5, eq6))
    : eq3 === 1 && eq6 === 0
      ? lookup(eq1, eq2, eq3, eq4, eq5, eq6 + 1)
      : eq3 === 2
        ? lookup(eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1)
        : lookup(eq1, eq2, eq3 + 1, eq4, eq5, eq6)
  const lowerEq4 = lookup(eq1, eq2, eq3, eq4 + 1, eq5, eq6)
  const lowerEq5 = lookup(eq1, eq2, eq3, eq4, eq5 + 1, eq6)

  // 1b. The severity distance from the first highest severity vector of this macro vector that is at
  // least as severe in every metric. When none is, the reference keeps the distances of the last one.
  const maxVectors: string[] = []
  for (const eq1Max of maxComposed.eq1[eq1]) {
    for (const eq2Max of maxComposed.eq2[eq2]) {
      for (const eq3eq6Max of maxComposed.eq3eq6[eq3][eq6]) {
        for (const eq4Max of maxComposed.eq4[eq4]) {
          for (const eq5Max of maxComposed.eq5[eq5]) maxVectors.push([eq1Max, eq2Max, eq3eq6Max, eq4Max, eq5Max].join('/'))
        }
      }
    }
  }
  let distances: Record<string, number> = {}
  for (const maxVector of maxVectors) {
    const maxValues = new Map(maxVector.split('/').map((part) => part.split(':') as [string, string]))
    distances = Object.fromEntries(Object.entries(metricLevels).map(([metric, levels]) =>
      [metric, levels[effective(metric)] - levels[maxValues.get(metric)!]]))
    if (Object.values(distances).every((distance) => distance >= 0)) break
  }

  const step = 0.1
  // 1c and 1d. Each class's share of its depth, times its maximal scoring difference.
  const classes: [number, number, number][] = [
    [value - lowerEq1, distances.AV + distances.PR + distances.UI, maxSeverity.eq1[eq1] * step],
    [value - lowerEq2, distances.AC + distances.AT, maxSeverity.eq2[eq2] * step],
    [value - lowerEq3eq6, distances.VC + distances.VI + distances.VA + distances.CR + distances.IR + distances.AR, maxSeverity.eq3eq6[eq3][eq6] * step],
    [value - lowerEq4, distances.SC + distances.SI + distances.SA, maxSeverity.eq4[eq4] * step],
    // The proportion for EQ5 is always 0.
    [value - lowerEq5, 0, 1]
  ]
  let existing = 0
  let total = 0
  for (const [available, distance, depth] of classes) {
    if (Number.isNaN(available)) continue
    existing++
    total += available * (distance / depth)
  }
  // 2 and 3. The macro vector's score minus the mean, rounded half up with the reference's epsilon.
  const meanDistance = existing === 0 ? 0 : total / existing
  return Math.round((Math.max(0, Math.min(10, value - meanDistance)) + 1e-6) * 10) / 10
}
