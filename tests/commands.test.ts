import { describe, expect, it } from 'vitest'
import { filterCommands, type Command } from '../src/shared/commands'

const command = (title: string, group = 'Действия'): Command => ({ id: title, title, group, run: () => {} })
const titles = (list: Command[]): string[] => list.map((item) => item.title)

describe('command search', () => {
  const all = [
    command('История', 'Разделы'),
    command('Изменения', 'Разделы'),
    command('Новая ветка…'),
    command('Перейти на ветку main', 'Ветки'),
    command('Перейти на ветку feature/login', 'Ветки')
  ]

  it('keeps every command, in order, while nothing is typed', () => {
    expect(filterCommands(all, '  ')).toBe(all)
  })

  it('needs every typed word, in any order and case', () => {
    expect(titles(filterCommands(all, 'ВЕТКУ login'))).toEqual(['Перейти на ветку feature/login'])
    expect(titles(filterCommands(all, 'login ветку'))).toEqual(['Перейти на ветку feature/login'])
    expect(filterCommands(all, 'нет такого')).toEqual([])
  })

  it('puts titles that start with the text first, then those with a word that does', () => {
    expect(titles(filterCommands(all, 'ветк'))).toEqual(['Новая ветка…', 'Перейти на ветку main', 'Перейти на ветку feature/login'])
    expect(titles(filterCommands(all, 'из'))).toEqual(['Изменения'])
    expect(titles(filterCommands(all, 'ист'))).toEqual(['История'])
  })

  it('finds a command by its group', () => {
    expect(titles(filterCommands(all, 'разделы'))).toEqual(['История', 'Изменения'])
  })
})
