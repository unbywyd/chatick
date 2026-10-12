import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Про ДРУГОГО человека спрашиваем состав команды, а не действующую роль.
 *
 * projectRoleOf поднимает менеджера и админа компании до админа проекта, даже
 * если в команде их нет (одна лестница ролей). Добавление проверяло «уже в
 * команде» через неё — и админа компании нельзя было добавить в проект.
 * Правка роли и прав находила «участника» без записи и молча ничего не меняла.
 */
const src = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8').replace(/\r\n/g, '\n')
const projects = src('projects.ts')
const bridge = src('bridge.ts')

describe('состав команды — teamMemberOf', () => {
  it('добавить, убрать, роль и права другого — по записи в команде', () => {
    expect(projects).toContain('const exists = await teamMemberOf(projectId, userId)')
    expect(projects).toContain('const victim = await teamMemberOf(projectId, userId)')
    expect(projects.match(/const target = await teamMemberOf\(projectId, userId\)/g)?.length).toBe(3)
    expect(bridge).toContain("if (await teamMemberOf(scope.projectId, userId)) return c.json({ error: 'Already a member' }, 409)")
    expect(bridge.match(/const target = await teamMemberOf\(scope\.projectId, userId\)/g)?.length).toBe(2)
  })

  it('о другом человеке projectRoleOf больше не спрашивают', () => {
    // Саботаж: вернуть projectRoleOf в любое из этих мест — тест упадёт.
    expect(projects).not.toMatch(/const (target|exists|victim) = await projectRoleOf\(projectId, userId\)/)
    expect(bridge).not.toMatch(/const target = await projectRoleOf\(scope\.projectId, userId\)/)
  })
})
