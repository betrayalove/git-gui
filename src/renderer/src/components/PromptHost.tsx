import { useEffect, useState, type ReactNode } from 'react'
import type { AccessPrompt, PromptReply } from '../../../shared/access'
import { kindForHost } from '../../../shared/remote-url'
import { appApi } from '../api'
import { Icon, Modal } from './ui'

const FINGERPRINT_DOCS: Record<string, string> = {
  github: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints',
  gitlab: 'https://docs.gitlab.com/user/gitlab_com/#ssh-host-keys-fingerprints'
}

function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path
}

function TextPrompt({ prompt, onReply }: { prompt: AccessPrompt; onReply: (reply: PromptReply | null) => void }): ReactNode {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const isKey = prompt.kind === 'passphrase'
  const isLogin = prompt.kind === 'username' || prompt.kind === 'password'
  const title = isKey ? 'Пароль SSH-ключа' : isLogin ? 'Вход на сервер' : 'Вопрос от git'
  const label = isKey ? 'Пароль ключа' : prompt.kind === 'username' ? 'Имя пользователя' : prompt.kind === 'password' ? 'Пароль или токен' : 'Ответ'
  const submit = (): void => {
    if (value) onReply({ answer: value, remember })
  }
  return (
    <Modal
      title={title}
      topmost
      onClose={() => onReply(null)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => onReply(null)}>Отмена</button>
        <button className="btn btn-primary" disabled={!value} onClick={submit}>Продолжить</button>
      </>}
    >
      {prompt.retry && <div className="banner danger"><Icon name="warning" />Пароль не подошёл. Попробуй ещё раз.</div>}
      {isKey
        ? <p className="prose">Ключ {prompt.keyPath ? <b>{fileName(prompt.keyPath)}</b> : null} защищён паролем. Это пароль самого ключа, а не аккаунта на сайте.</p>
        : <p className="prose prompt-text">{prompt.text}</p>}
      <label className="field">
        <span>{label}</span>
        <input
          autoFocus
          type={prompt.hidden ? 'password' : 'text'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
        />
      </label>
      {prompt.canRemember && (
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Запомнить на этом компьютере. Пароль будет зашифрован средствами системы, и отложенные публикации смогут выходить без тебя.</span>
        </label>
      )}
      {isKey && !remember && <p className="hint">Пока приложение открыто, пароль хранится в памяти 15 минут, поэтому одна отправка не спросит его несколько раз.</p>}
      {isLogin && <p className="hint">GitHub и GitLab принимают здесь не пароль от сайта, а токен. Проще подключить SSH-ключ: нажми «Отмена», и приложение предложит это.</p>}
    </Modal>
  )
}

function HostKeyPrompt({ prompt, onReply }: { prompt: AccessPrompt; onReply: (reply: PromptReply | null) => void }): ReactNode {
  const kind = prompt.host ? kindForHost(prompt.host) : null
  return (
    <Modal
      title="Первое подключение к серверу"
      topmost
      onClose={() => onReply(null)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => onReply(null)}>Отмена</button>
        <button className="btn btn-primary" autoFocus onClick={() => onReply({ answer: 'yes' })}>Доверять и подключиться</button>
      </>}
    >
      <p className="prose">Этот компьютер ещё не подключался к <b>{prompt.host ?? 'этому серверу'}</b>. Проверь отпечаток: так можно убедиться, что это настоящий сервер. После подтверждения он запомнится.</p>
      {prompt.fingerprint && <div className="key-box"><code>{prompt.fingerprint}</code></div>}
      {kind && (
        <button className="link" onClick={() => void appApi.openExternal(FINGERPRINT_DOCS[kind])}>
          Официальные отпечатки {kind === 'github' ? 'GitHub' : 'GitLab'}
        </button>
      )}
    </Modal>
  )
}

function ConfirmPrompt({ prompt, onReply }: { prompt: AccessPrompt; onReply: (reply: PromptReply | null) => void }): ReactNode {
  return (
    <Modal
      title="Вопрос от ssh"
      topmost
      onClose={() => onReply(null)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => onReply(null)}>Нет</button>
        <button className="btn btn-primary" onClick={() => onReply({ answer: 'yes' })}>Да</button>
      </>}
    >
      <p className="prose prompt-text">{prompt.text}</p>
    </Modal>
  )
}

/** Shows what git and ssh ask, one question at a time, over whatever else is on screen. */
export function PromptHost(): ReactNode {
  const [queue, setQueue] = useState<AccessPrompt[]>([])
  useEffect(() => {
    const offPrompt = window.chronicle.onPrompt((prompt) => setQueue((items) => [...items, prompt]))
    const offClosed = window.chronicle.onPromptClosed((id) => setQueue((items) => items.filter((item) => item.id !== id)))
    return () => {
      offPrompt()
      offClosed()
    }
  }, [])
  const prompt = queue[0]
  if (!prompt) return null
  const onReply = (reply: PromptReply | null): void => {
    setQueue((items) => items.filter((item) => item.id !== prompt.id))
    void appApi.answerPrompt(prompt.id, reply)
  }
  if (prompt.kind === 'host-key') return <HostKeyPrompt key={prompt.id} prompt={prompt} onReply={onReply} />
  if (prompt.kind === 'confirm') return <ConfirmPrompt key={prompt.id} prompt={prompt} onReply={onReply} />
  return <TextPrompt key={prompt.id} prompt={prompt} onReply={onReply} />
}
