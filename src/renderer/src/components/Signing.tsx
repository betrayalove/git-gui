import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SshKey } from '../../../core/ssh'
import type { GpgKey, SignatureInfo, SignatureState, SigningChoice, SigningState } from '../../../shared/types'
import { appApi } from '../api'
import { useRepo } from '../store'
import { useDialogs } from './dialogs'
import { Icon, Modal } from './ui'
import { t } from '../../../shared/i18n'

const BADGE: Record<Exclude<SignatureState, 'none'>, { label: string; tone: 'good' | 'bad' | 'neutral' }> = {
  good: { label: t('Подпись проверена'), tone: 'good' },
  untrusted: { label: t('Подпись верна, ключ не заверен'), tone: 'neutral' },
  bad: { label: t('Подпись не сходится'), tone: 'bad' },
  expired: { label: t('Подпись просрочена'), tone: 'bad' },
  revoked: { label: t('Ключ подписи отозван'), tone: 'bad' },
  'unknown-key': { label: t('Подписан, ключа нет'), tone: 'neutral' },
  unverifiable: { label: t('Подписан, проверить нельзя'), tone: 'neutral' }
}

function badgeHint(info: SignatureInfo): string {
  if (info.state === 'unverifiable' && info.format === 'ssh') {
    return t('Git проверяет подписи SSH-ключом только по списку доверенных ключей из настройки gpg.ssh.allowedSignersFile.')
  }
  if (info.state === 'unknown-key') return t('Открытого ключа того, кто подписал, нет на этом компьютере, поэтому подпись не проверить.')
  if (info.state === 'bad') return t('Коммит изменили после подписи, или подпись чужая.')
  return [info.signer, info.key].filter(Boolean).join(' · ')
}

/** Whether a commit is signed and whether the signature holds. Shows nothing for an unsigned commit. */
export function SignatureBadge({ sha }: { sha: string }): ReactNode {
  const { client } = useRepo()
  const [info, setInfo] = useState<SignatureInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    setInfo(null)
    client.readSignature(sha).then((result) => { if (!cancelled) setInfo(result) }).catch(() => {})
    return () => { cancelled = true }
  }, [client, sha])
  if (!info || info.state === 'none') return null
  const badge = BADGE[info.state]
  return (
    <span className={`pill signature signature-${badge.tone}`} title={badgeHint(info)}>
      <Icon name="shield" size={11} />{badge.label}
    </span>
  )
}

const listeners = new Set<() => void>()
let changes = 0

/** How a repository's signing setting reads now; it updates wherever the setting was changed from. */
export function useSigning(): SigningState | null {
  const { client } = useRepo()
  const [state, setState] = useState<SigningState | null>(null)
  const version = useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => changes)
  useEffect(() => {
    let cancelled = false
    client.readSigning().then((result) => { if (!cancelled) setState(result) }).catch(() => {})
    return () => { cancelled = true }
  }, [client, version])
  return state
}

/** A short line about how new commits are signed, for the commit box. */
export function signingSummary(state: Pick<SigningState, 'enabled' | 'format'>): string {
  if (!state.enabled) return t('Коммиты не подписываются')
  return state.format === 'ssh' ? t('Подпись SSH-ключом') : state.format === 'x509' ? t('Подпись сертификатом') : t('Подпись GPG-ключом')
}

const sshKeyValue = (key: SshKey): string | null => (key.path ? `${key.path}.pub` : key.publicKey ? `key::${key.publicKey}` : null)

export function SigningDialog(): ReactNode {
  const { client, run } = useRepo()
  const { close } = useDialogs()
  const [state, setState] = useState<SigningState | null>(null)
  const [mode, setMode] = useState<SigningChoice['mode']>('inherit')
  const [sshKeys, setSshKeys] = useState<SshKey[] | null>(null)
  const [gpgKeys, setGpgKeys] = useState<GpgKey[] | null>(null)
  const [key, setKey] = useState('')

  useEffect(() => {
    void client.readSigning().then((current) => {
      setState(current)
      setMode(current.choice)
      if (current.choice === 'ssh' || current.choice === 'openpgp') setKey(current.key)
    })
    void appApi.sshListKeys().then(setSshKeys).catch(() => setSshKeys([]))
  }, [client])

  // Asking GnuPG for keys starts its background daemons, so that waits until GPG is chosen.
  const wantsGpg = mode === 'openpgp'
  useEffect(() => {
    if (!wantsGpg) return
    void client.listGpgKeys().then(setGpgKeys).catch(() => setGpgKeys([]))
  }, [client, wantsGpg])

  const save = (): void => {
    const choice: SigningChoice = mode === 'ssh' || mode === 'openpgp' ? { mode, key } : { mode }
    close()
    void run(t('Сохраняю подпись'), async () => {
      await client.setSigning(choice)
      changes++
      for (const listener of listeners) listener()
    })
  }

  const options: [SigningChoice['mode'], string][] = [
    ['inherit', t('Как в общих настройках git')],
    ['off', t('Не подписывать')],
    ['ssh', t('SSH-ключом')],
    ['openpgp', t('GPG-ключом')]
  ]
  const needsKey = mode === 'ssh' || mode === 'openpgp'
  return (
    <Modal
      title={t('Подпись коммитов')}
      onClose={close}
      wide
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!state || (needsKey && !key)} onClick={save}>{t('Сохранить')}</button>
      </>}
    >
      <div className="segmented compact signing-modes" role="group" aria-label={t('Подпись коммитов')}>
        {options.map(([value, label]) => (
          <button key={value} className={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => { setMode(value); setKey(value === state?.choice ? state.key : '') }}>{label}</button>
        ))}
      </div>
      {mode === 'inherit' && state && (
        <p className="hint">{t('Сейчас по общим настройкам:')} {signingSummary(state.inherited).toLowerCase()}.</p>
      )}
      {mode === 'off' && <p className="hint">{t('Коммиты в этом репозитории не будут подписываться, даже если подпись включена в общих настройках git.')}</p>}
      {mode === 'ssh' && (
        <div className="key-list" role="radiogroup" aria-label={t('SSH-ключ')}>
          {sshKeys === null && <p className="hint">{t('Ищу ключи…')}</p>}
          {sshKeys?.length === 0 && <p className="hint">{t('SSH-ключей не нашлось. Создать ключ можно в настройках, в разделе «Доступ к серверам».')}</p>}
          {sshKeys?.map((item) => {
            const value = sshKeyValue(item)
            if (!value) return null
            return (
              <label key={item.id} className="key-option">
                <input type="radio" name="ssh-key" checked={key === value} onChange={() => setKey(value)} />
                <span className="truncate"><b>{item.name}</b> <span className="muted">{item.type}{item.comment ? ` · ${item.comment}` : ''}</span></span>
              </label>
            )
          })}
          <p className="hint">{t('Чтобы GitHub и GitLab показывали коммиты проверенными, добавь этот ключ на сайт как ключ для подписи. Если у ключа есть пароль, приложение спросит его при коммите.')}</p>
        </div>
      )}
      {mode === 'openpgp' && (
        <div className="key-list" role="radiogroup" aria-label={t('GPG-ключ')}>
          {gpgKeys === null && <p className="hint">{t('Ищу ключи…')}</p>}
          {gpgKeys?.length === 0 && <p className="hint">{t('GPG не установлен, или в нём нет ключей, которыми можно подписывать.')}</p>}
          {gpgKeys?.map((item) => (
            <label key={item.id} className="key-option">
              <input type="radio" name="gpg-key" checked={key === item.id} onChange={() => setKey(item.id)} />
              <span className="truncate"><b>{item.uid || item.id}</b> <span className="muted">{item.id}</span></span>
            </label>
          ))}
          <p className="hint">{t('Пароль ключа GPG спрашивает сам GPG в своём окне.')}</p>
        </div>
      )}
      <p className="hint">{t('Настройка действует только в этом репозитории. Общие настройки git не меняются.')}</p>
    </Modal>
  )
}
