import { useEffect, useState, type ReactNode } from 'react'
import type { Theme, UpdateInfo } from '../../../shared/types'
import { appApi } from '../api'
import { AccessDialog } from '../components/AccessDialog'
import { Icon, Modal } from '../components/ui'
import { t, type Language } from '../../../shared/i18n'

const THEMES: [Theme, string][] = [['system', t('Как в системе')], ['light', t('Светлая')], ['dark', t('Тёмная')]]

// Each language is named in itself, so it can be found by someone who cannot read the current one.
const LANGUAGE_NAMES: [Language, string][] = [['ru', 'Русский'], ['en', 'English']] // i18n-ignore: native names

export function SettingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autostart, setAutostart] = useState<{ available: boolean; enabled: boolean } | null>(null)
  const [autoUpdates, setAutoUpdates] = useState(true)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [access, setAccess] = useState(false)
  const [saved, setSaved] = useState<{ available: boolean; count: number } | null>(null)
  const [preferences, setPreferences] = useState<{ language: Language; theme: Theme } | null>(null)

  useEffect(() => {
    void appApi.autostart().then(setAutostart)
    void appApi.updateChecksEnabled().then(setAutoUpdates)
    void appApi.savedPassphrases().then(setSaved)
    void appApi.preferences().then(setPreferences)
  }, [])

  const attempt = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (access) return <AccessDialog onClose={() => setAccess(false)} />
  return (
    <Modal title={t('Настройки')} onClose={onClose} wide>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      <section className="settings-section">
        <h3>{t('Оформление')}</h3>
        <div className="settings-row">
          <span>{t('Тема')}</span>
          <div className="segmented compact" role="group" aria-label={t('Тема')}>
            {THEMES.map(([value, label]) => (
              <button
                key={value}
                className={preferences?.theme === value ? 'active' : ''}
                aria-pressed={preferences?.theme === value}
                onClick={() => void attempt(async () => {
                  await appApi.setTheme(value)
                  setPreferences((current) => current && { ...current, theme: value })
                })}
              >{label}</button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>{t('Язык')}</span>
          <div className="segmented compact" role="group" aria-label={t('Язык')}>
            {LANGUAGE_NAMES.map(([value, name]) => (
              <button
                key={value}
                lang={value}
                className={preferences?.language === value ? 'active' : ''}
                aria-pressed={preferences?.language === value}
                onClick={() => void attempt(async () => {
                  if (preferences?.language === value) return
                  await appApi.setLanguage(value)
                })}
              >{name}</button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>{t('Доступ к серверам')}</h3>
        <p className="hint settings-hint">{t('Приложение работает с сервером через git и SSH-ключи этого компьютера. Вход в аккаунт не нужен.')}</p>
        <div className="inline-actions">
          <button className="btn" onClick={() => setAccess(true)}><Icon name="key" size={14} />{t('Настроить SSH-ключ')}</button>
          {saved && saved.count > 0 && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => void attempt(async () => {
              await appApi.forgetPassphrases()
              setSaved(await appApi.savedPassphrases())
            })}>{t('Забыть сохранённые пароли ключей:')} {saved.count}</button>
          )}
        </div>
      </section>
      <section className="settings-section">
        <h3>{t('Запуск')}</h3>
        <label className="check">
          <input
            type="checkbox"
            disabled={!autostart?.available}
            checked={autostart?.enabled ?? false}
            onChange={(event) => {
              const enabled = event.target.checked
              void attempt(async () => {
                await appApi.setAutostart(enabled)
                setAutostart(await appApi.autostart())
              })
            }}
          />
          <span>{t('Запускать при входе в систему, чтобы отложенные публикации выходили вовремя')}</span>
        </label>
        {autostart && !autostart.available && <p className="hint">{t('Доступно в установленном приложении.')}</p>}
      </section>
      <section className="settings-section">
        <h3>{t('Обновления')}</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={autoUpdates}
            onChange={(event) => {
              const enabled = event.target.checked
              setAutoUpdates(enabled)
              void attempt(() => appApi.setUpdateChecksEnabled(enabled))
            }}
          />
          <span>{t('Проверять при запуске, вышла ли новая версия. Проверка обращается к GitHub и ничего не устанавливает сама.')}</span>
        </label>
        <div className="update-row">
          <button className="btn btn-small" disabled={busy} onClick={() => void attempt(async () => setUpdate(await appApi.checkForUpdates()))}>{t('Проверить сейчас')}</button>
          {update && !update.latest && <span className="muted">{t('Версия')} {update.current}{t('. Опубликованных выпусков пока нет.')}</span>}
          {update?.latest && !update.available && <span className="muted">{t('Установлена последняя версия:')} {update.current}.</span>}
          {update?.available && update.url && (
            <button className="link" onClick={() => void appApi.openExternal(update.url!)}>{t('Скачать версию')} {update.latest}</button>
          )}
        </div>
      </section>
    </Modal>
  )
}
