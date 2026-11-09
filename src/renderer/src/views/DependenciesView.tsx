import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ADVICE_ORDER, adviseDependencies, isMalicious, packagePage, worstSeverity, type Advice, type AdviceGroup } from '../../../shared/advice'
import type { DependencyFix, DependencyReport, PackageManager, RuntimeSupport, Severity } from '../../../shared/deps'
import { appApi } from '../api'
import { useDialogs } from '../components/dialogs'
import { EmptyState, Icon, Modal } from '../components/ui'
import { formatDay, formatRelative, shortSha } from '../format'
import { useRepo } from '../store'
import { t } from '../../../shared/i18n'

const GROUP_TITLE: Record<AdviceGroup, string> = {
  urgent: t('Исправить сейчас'),
  recommended: t('Стоит обновить'),
  unfixed: t('Исправления пока нет'),
  major: t('Крупные обновления'),
  safe: t('Обновления без риска')
}

const GROUP_HINT: Record<AdviceGroup, string> = {
  urgent: t('Серьёзные уязвимости в коде, который попадает к пользователям.'),
  recommended: t('Уязвимости в инструментах разработки или менее опасные, а также заброшенные пакеты.'),
  unfixed: t('Исправленной версии ещё нет. Следи за выпусками или замени пакет.'),
  major: t('Новая мажорная версия может потребовать правок в коде.'),
  safe: t('Исправления и мелкие улучшения без ломающих изменений.')
}

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: t('критическая'), high: t('высокая'), moderate: t('средняя'), low: t('низкая'), unknown: t('неизвестная')
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Support that ends within this long is worth a warning now. */
const SOON_MS = 90 * DAY_MS

/** Managers whose lockfile the app can update by itself, on a branch of its own. */
const FIXABLE: PackageManager[] = ['npm', 'pnpm', 'yarn', 'pip']

function fixOf(advice: Advice): DependencyFix | null {
  if (!advice.target || !FIXABLE.includes(advice.manager)) return null
  return { lockfile: advice.lockfile, manager: advice.manager, updates: [{ name: advice.name, from: advice.version, to: advice.target, direct: advice.direct }] }
}

function FixDialog({ fix }: { fix: DependencyFix }): ReactNode {
  const { client, run, toast, jumpTo } = useRepo()
  const { close } = useDialogs()
  const [commands, setCommands] = useState<string[][] | null>(null)
  useEffect(() => {
    // Asking pnpm for its version only decides where an override goes, so it is not worth showing.
    void client.fixCommands(fix).then((list) => setCommands(list.filter((command) => command[1] !== '--version'))).catch(() => setCommands([]))
  }, [client, fix])
  const apply = (): void => {
    close()
    void run(t('Обновляю зависимости'), async () => {
      const result = await client.fixDependencies(fix)
      if (result.missed.length) toast('info', t('Не удалось обновить: {names}. Остальное сделано.', { names: result.missed.join(', ') }))
      toast('success', t('Готова ветка {branch}', { branch: result.branch }), { label: t('Показать'), run: () => jumpTo(result.commit) })
    })
  }
  const update = fix.updates[0]
  return (
    <Modal
      title={t('Обновить {name}', { name: update.name })}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" autoFocus disabled={!commands} onClick={apply}>{t('Создать ветку')}</button>
      </>}
    >
      <div className="prose">
        <p>{t('Chronicle создаст ветку от текущего коммита и обновит {name} с {from} до {to} в {lockfile}. Рабочая папка и текущая ветка не изменятся.', { name: update.name, from: update.from, to: update.to, lockfile: fix.lockfile })}</p>
        {commands && commands.length > 0 && <>
          <p>{t('В отдельной копии репозитория выполнится:')}</p>
          {commands.map((command) => <div key={command.join(' ')} className="mono-list">{command.join(' ')}</div>)}
          <div className="banner warn"><Icon name="warning" />{t('Скрипты установки отключены, но настройки проекта, например .pnpmfile.cjs или yarnPath, всё равно могут выполнить код. Запускай только для проектов, которым доверяешь.')}</div>
        </>}
        <p className="muted">{t('Потом проверь ветку тестами проекта и отправь её на сервер как обычно.')}</p>
      </div>
    </Modal>
  )
}

function AdviceCard({ advice }: { advice: Advice }): ReactNode {
  const { show } = useDialogs()
  const fix = fixOf(advice)
  const severity = worstSeverity(advice.advisories)
  const page = packagePage(advice.ecosystem, advice.name)
  const chain = advice.via.slice(0, -1).join(' → ')
  return (
    <article className="schedule-card">
      <div className="schedule-when">
        <Icon name={advice.advisories.length ? 'shield' : 'package'} size={18} />
        <div>
          <b>{advice.name} <span className="mono muted">{advice.version}{advice.target && ` → ${advice.target}`}</span></b>
          <span className="muted truncate">
            {advice.lockfile} · {advice.direct ? t('прямая зависимость') : t('через {chain}', { chain })}
            {advice.dev && ` · ${t('только для разработки')}`}
          </span>
        </div>
        {advice.advisories.length > 0 && <span className={`pill severity-${severity}`}>{SEVERITY_TEXT[severity]}</span>}
      </div>
      {isMalicious(advice.advisories) && <div className="banner danger"><Icon name="warning" />{t('Вредоносный пакет. Удали его из зависимостей и смени пароли, ключи и токены, которые были доступны там, где его устанавливали.')}</div>}
      {advice.deprecated && <div className="banner warn"><Icon name="warning" />{t('Пакет устарел: {reason}', { reason: advice.deprecated })}</div>}
      {advice.advisories.length > 0 && (
        <ul className="dep-advisories">
          {advice.advisories.map((advisory) => (
            <li key={advisory.id}>
              <button className="link" onClick={() => void appApi.openExternal(advisory.url)}>{advisory.id}</button>
              <span>{advisory.summary}</span>
              <span className="muted">{advisory.fixed ? t('исправлено в {version}', { version: advisory.fixed }) : t('исправления нет')}</span>
            </li>
          ))}
        </ul>
      )}
      {(page || fix) && (
        <div className="detail-actions">
          {fix && <button className="btn btn-small" onClick={() => show(<FixDialog fix={fix} />)}>{t('Обновить в новой ветке')}</button>}
          {page && <button className="btn btn-small btn-ghost" onClick={() => void appApi.openExternal(page)}><Icon name="external" size={13} />{t('Страница пакета')}</button>}
        </div>
      )}
    </article>
  )
}

function RuntimeCard({ runtime }: { runtime: RuntimeSupport }): ReactNode {
  const ends = runtime.eol ? Date.parse(runtime.eol) : null
  const tone = runtime.isEol ? 'danger' : ends !== null && ends - Date.now() < SOON_MS ? 'warn' : null
  const text = runtime.isEol
    ? t('Поддержка закончилась {date}. Последняя версия: {latest}.', { date: runtime.eol ? formatDay(runtime.eol) : '—', latest: runtime.latest ?? '—' })
    : runtime.eol ? t('Поддерживается до {date}.', { date: formatDay(runtime.eol) }) : t('Срок поддержки не объявлен.')
  return (
    <article className="schedule-card">
      <div className="schedule-when">
        <Icon name={tone ? 'warning' : 'check'} size={18} className={tone ? `tone-${tone}` : 'tone-ok'} />
        <div>
          <b>{runtime.product} <span className="mono muted">{runtime.version}</span></b>
          <span className="muted">{text}</span>
        </div>
      </div>
    </article>
  )
}

export function DependenciesView(): ReactNode {
  const { client, snapshot } = useRepo()
  const [consent, setConsent] = useState<boolean | null>(null)
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const head = snapshot?.status.headSha ?? null

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    setFailure(null)
    try {
      setReport(await client.checkDependencies())
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setChecking(false)
    }
  }, [client])

  useEffect(() => {
    let cancelled = false
    void Promise.all([appApi.dependencyConsent(), client.lastDependencyReport()]).then(([agreed, last]) => {
      if (cancelled) return
      setConsent(agreed)
      setReport(last)
      // A new commit may bring new lockfiles, and the databases learn of new flaws every day.
      const stale = !last || last.commit !== head || Date.now() - Date.parse(last.checkedAt) > DAY_MS
      if (agreed && head && stale) void check()
    })
    return () => { cancelled = true }
  }, [check, client, head])

  const advice = useMemo(() => (report ? adviseDependencies(report) : []), [report])

  if (consent === null) return null
  if (!consent) {
    return (
      <div className="empty">
        <Icon name="shield" size={28} />
        <h3>{t('Проверка зависимостей')}</h3>
        <p>{t('Chronicle найдёт lock-файлы в последнем коммите и сверит пакеты с открытыми базами OSV.dev, deps.dev и endoflife.date.')}</p>
        <p>{t('Туда уйдут только имена и версии публичных пакетов. Код, пути и частные пакеты останутся на компьютере.')}</p>
        <button className="btn btn-primary" onClick={() => void appApi.setDependencyConsent(true).then(() => { setConsent(true); return check() })}>{t('Проверить')}</button>
      </div>
    )
  }

  const runtimes = report?.runtimes ?? []
  const groups = ADVICE_ORDER.map((group) => ({ group, items: advice.filter((item) => item.group === group) })).filter((entry) => entry.items.length)

  return (
    <div className="schedule">
      <header className="pane-head">
        <h2>{t('Зависимости')}</h2>
        {report && <span className="muted">{t('Проверено {when}, коммит {commit}', { when: formatRelative(report.checkedAt), commit: shortSha(report.commit) })}</span>}
        <button className="btn btn-small" disabled={checking || !head} onClick={() => void check()}>
          {checking ? <span className="spinner" /> : <Icon name="shield" size={13} />}{checking ? t('Проверяю') : t('Проверить')}
        </button>
      </header>
      {failure && <div className="banner danger dep-banner"><Icon name="warning" />{t('Не удалось проверить: {reason}', { reason: failure })}{report && ` ${t('Показан прошлый результат.')}`}</div>}
      {report?.skipped.map((item) => (
        <div key={item.path} className="banner warn dep-banner"><Icon name="warning" />{t('{path} не прочитан: {reason}', { path: item.path, reason: item.reason })}</div>
      ))}
      {report && !report.lockfiles.length && (
        <EmptyState icon="package" title={t('Lock-файлы не найдены')}>
          {t('Chronicle ищет package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, go.mod, poetry.lock, uv.lock и другие в последнем коммите.')}
        </EmptyState>
      )}
      {report && report.lockfiles.length > 0 && !groups.length && (
        <EmptyState icon="check" title={t('Всё в порядке')}>{t('Известных уязвимостей нет, а прямые зависимости свежие.')}</EmptyState>
      )}
      {groups.map(({ group, items }) => (
        <section key={group} className="dep-group">
          <h3>{GROUP_TITLE[group]}<span className="count">{items.length}</span></h3>
          <p className="muted">{GROUP_HINT[group]}</p>
          {items.map((item) => <AdviceCard key={`${item.lockfile}:${item.name}@${item.version}`} advice={item} />)}
        </section>
      ))}
      {runtimes.length > 0 && (
        <section className="dep-group">
          <h3>{t('Платформы')}<span className="count">{runtimes.length}</span></h3>
          <p className="muted">{t('Сроки поддержки фреймворков и сред, на которых построен проект.')}</p>
          {runtimes.map((runtime) => <RuntimeCard key={`${runtime.product}@${runtime.version}`} runtime={runtime} />)}
        </section>
      )}
    </div>
  )
}
