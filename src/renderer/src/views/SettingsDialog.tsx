import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateInfo } from '../../../shared/types'
import { appApi } from '../api'
import { Icon, Modal } from '../components/ui'

export function SettingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autostart, setAutostart] = useState<{ available: boolean; enabled: boolean } | null>(null)
  const [autoUpdates, setAutoUpdates] = useState(true)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    void appApi.autostart().then(setAutostart)
    void appApi.updateChecksEnabled().then(setAutoUpdates)
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
  return (
    <Modal title="Настройки" onClose={onClose} wide>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      <section className="settings-section">
        <h3>Запуск</h3>
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
          <span>Запускать при входе в систему, чтобы отложенные публикации выходили вовремя</span>
        </label>
        {autostart && !autostart.available && <p className="hint">Доступно в установленном приложении.</p>}
      </section>
      <section className="settings-section">
        <h3>Обновления</h3>
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
          <span>Проверять при запуске, вышла ли новая версия. Проверка обращается к GitHub и ничего не устанавливает сама.</span>
        </label>
        <div className="update-row">
          <button className="btn btn-small" disabled={busy} onClick={() => void attempt(async () => setUpdate(await appApi.checkForUpdates()))}>Проверить сейчас</button>
          {update && !update.latest && <span className="muted">Версия {update.current}. Опубликованных выпусков пока нет.</span>}
          {update?.latest && !update.available && <span className="muted">Установлена последняя версия: {update.current}.</span>}
          {update?.available && update.url && (
            <button className="link" onClick={() => void appApi.openExternal(update.url!)}>Скачать версию {update.latest}</button>
          )}
        </div>
      </section>
    </Modal>
  )
}
