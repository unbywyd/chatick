import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Одна лестница ролей (v2): участник / менеджер / админ в компании; менеджер и
 * админ управляют любым её проектом. Правила держатся в источниках прав —
 * сторож следит, чтобы они там и остались.
 */
const projects = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8').replace(/\r\n/g, '\n')
const auth = readFileSync(join(import.meta.dirname, '../auth.ts'), 'utf8').replace(/\r\n/g, '\n')
const ws = readFileSync(join(import.meta.dirname, '../ws.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('одна лестница ролей', () => {
  it('projectRoleOf поднимает менеджера и админа компании до админа проекта', () => {
    const fn = projects.slice(projects.indexOf('export async function projectRoleOf('))
    expect(fn).toMatch(/companyManagesProject\(projectId, userId\)/)
    expect(fn).toMatch(/role: 'admin'/)
  })
  it('memberDomains и вход в проект идут через projectRoleOf', () => {
    expect(projects).toMatch(/export async function memberDomains[\s\S]{0,120}projectRoleOf\(projectId, userId\)/)
    expect(auth).toContain('projectRoleOf(projectId, payload.sub)')
    expect(ws).toContain('projectRoleOf(claimed, payload.sub)')
  })
  it('менеджер — это canCreateProjects: admin и manager', () => {
    expect(projects).toContain("export const canCreateProjects = (role: string | null) => role === 'admin' || role === 'manager'")
  })
  it('удалить проект менеджер НЕ может — только владелец проекта или админ компании', () => {
    const del = projects.slice(projects.indexOf("projectsRoute.delete('/:projectId'"), projects.indexOf("projectsRoute.delete('/:projectId'") + 1500)
    expect(del).toContain("if (!(membership?.role === 'owner' || companyRole === 'admin')) {")
  })
})
